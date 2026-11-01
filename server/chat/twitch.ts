import WebSocket from "ws";
import { z } from "zod";
import type { ChatMessage } from "../../shared/types.js";
import { Reconnect } from "./backoff.js";
import { twitchFieldStatus } from "./platform-setup.js";
import {
  oauthRefreshSchema,
  type ChatSource,
  type Receive,
  type Status,
} from "./source.js";

// Untrusted network JSON: each schema names only the fields this file reads.
const twitchFrameSchema = z.object({
  metadata: z.object({
    message_type: z.string(),
    subscription_type: z.string().optional(),
    message_timestamp: z.string().optional(),
  }),
  payload: z
    .object({
      session: z
        .object({
          id: z.string(),
          keepalive_timeout_seconds: z.number().nullish(),
          reconnect_url: z.string().nullish(),
        })
        .optional(),
      event: z.unknown().optional(),
    })
    .optional(),
});
const twitchChatEventSchema = z.object({
  broadcaster_user_id: z.unknown().optional(),
  message_id: z.string().optional(),
  chatter_user_id: z.string().optional(),
  chatter_user_name: z.string().optional(),
  message: z
    .object({
      text: z.string().optional(),
      fragments: z
        .array(
          z.object({
            type: z.string().optional(),
            text: z.string().nullish(),
          }),
        )
        .optional(),
    })
    .optional(),
});
type TwitchChatEvent = z.infer<typeof twitchChatEventSchema>;
export function twitchMessage(
  event: TwitchChatEvent,
  timestamp: string,
): ChatMessage | undefined {
  if (!event.message_id || !event.chatter_user_id || !event.message?.text)
    return;
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return;
  // Drop emote fragments so emote names are not submitted as prompt text.
  const text = event.message.fragments
    ? event.message.fragments
      .filter((f) => f.type !== "emote")
      .map((f) => f.text ?? "")
      .join("")
    : event.message.text;
  return {
    id: event.message_id,
    platform: "twitch",
    authorId: event.chatter_user_id,
    author: event.chatter_user_name ?? "Viewer",
    text,
    timestamp: at,
    membership: {
      verified: true,
      member: false,
      gift: false,
      evidence: `twitch:${event.message_id}`,
    },
  };
}
export type TwitchFrame =
  | { kind: "welcome"; session: string; keepaliveMs: number }
  | { kind: "reconnect"; url: string }
  | { kind: "revocation" }
  | { kind: "chat"; event: TwitchChatEvent; timestamp: string }
  | { kind: "other" };
// undefined means malformed: never throws, so a bad frame cannot escape the socket handler.
export function readTwitchFrame(raw: string): TwitchFrame | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return;
  }
  const frame = twitchFrameSchema.safeParse(json);
  if (!frame.success) return;
  const { metadata, payload } = frame.data;
  if (metadata.message_type === "session_welcome") {
    const session = payload?.session;
    if (!session) return;
    return {
      kind: "welcome",
      session: session.id,
      keepaliveMs: (session.keepalive_timeout_seconds ?? 10) * 1000 + 2000,
    };
  }
  if (metadata.message_type === "session_reconnect") {
    const url = payload?.session?.reconnect_url;
    return url ? { kind: "reconnect", url } : undefined;
  }
  if (metadata.message_type === "revocation") return { kind: "revocation" };
  if (
    metadata.message_type === "notification" &&
    metadata.subscription_type === "channel.chat.message"
  ) {
    const event = twitchChatEventSchema.safeParse(payload?.event);
    if (!event.success || metadata.message_timestamp === undefined) return;
    return {
      kind: "chat",
      event: event.data,
      timestamp: metadata.message_timestamp,
    };
  }
  return { kind: "other" };
}
export class TwitchChat implements ChatSource {
  readonly platform = "twitch";
  readonly runningStatuses = ["Connected", "Connecting"];
  readonly confirmsConnection = true;
  private socket?: WebSocket;
  private sockets = new Set<WebSocket>();
  private active = false;
  private reconnect = new Reconnect(() =>
    this.connect("wss://eventsub.wss.twitch.tv/ws"),
  );
  constructor(
    private auth: {
      access: string;
      refresh: string;
      client: string;
      secret: string;
      broadcaster: string;
      user: string;
    },
    private receive: Receive,
    private status: Status,
  ) { }
  // Every Twitch field empty means Twitch is off; a partial setup is an error.
  configured() {
    const fields = twitchFieldStatus(this.auth);
    if (fields.kind === "partial")
      throw new Error(
        `Twitch is partially filled. Add ${fields.missing.join(", ")} or leave every Twitch field empty to skip Twitch.`,
      );
    return fields.kind === "on";
  }
  start() {
    if (
      !this.auth.access ||
      !this.auth.client ||
      !this.auth.broadcaster ||
      !this.auth.user
    )
      throw new Error(
        "Twitch token, client ID, broadcaster ID and bot ID are required",
      );
    this.active = true;
    this.connect("wss://eventsub.wss.twitch.tv/ws");
  }
  private connect(url: string, previous?: WebSocket) {
    // Reconnect URLs come from the network; a bad one must not throw out of the socket handler.
    const parsed = URL.parse(url);
    if (
      !parsed ||
      parsed.protocol !== "wss:" ||
      parsed.hostname !== "eventsub.wss.twitch.tv"
    ) {
      this.status("twitch", "Invalid reconnect endpoint", true);
      return;
    }
    const socket = new WebSocket(url);
    this.sockets.add(socket);
    this.socket = socket;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let keepalive = 15000;
    const touch = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => socket.terminate(), keepalive);
    };
    socket.on("open", touch);
    socket.on("error", () => this.status("twitch", "Connection error"));
    socket.on("message", (raw) => {
      touch();
      const frame = readTwitchFrame(raw.toString());
      // Malformed frames are dropped; the keepalive watchdog still reconnects with backoff.
      if (!frame) {
        console.warn("Twitch EventSub: dropped a malformed frame");
        return;
      }
      if (frame.kind === "welcome") {
        this.reconnect.connected();
        keepalive = frame.keepaliveMs;
        touch();
        if (previous) {
          previous.close();
          this.status("twitch", "Connected");
        } else void this.subscribe(frame.session);
      } else if (frame.kind === "reconnect") this.connect(frame.url, socket);
      else if (frame.kind === "revocation") {
        this.status("twitch", "Chat permission revoked", true);
        this.stop();
      } else if (
        frame.kind === "chat" &&
        String(frame.event.broadcaster_user_id) === this.auth.broadcaster
      ) {
        const message = twitchMessage(frame.event, frame.timestamp);
        if (message) this.receive(message);
      }
    });
    socket.on("close", () => {
      if (watchdog) clearTimeout(watchdog);
      this.sockets.delete(socket);
      if (this.active && socket === this.socket && !this.reconnect.pending) {
        this.status("twitch", "Disconnected; reconnecting");
        this.reconnect.schedule();
      }
    });
  }
  private async subscribe(session: string) {
    try {
      let response = await this.subscriptionRequest(session);
      if (response.status === 401 && this.auth.refresh && this.auth.secret) {
        const refresh = await fetch("https://id.twitch.tv/oauth2/token", {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: this.auth.refresh,
            client_id: this.auth.client,
            client_secret: this.auth.secret,
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!refresh.ok) throw new Error();
        const data = oauthRefreshSchema.parse(await refresh.json());
        this.auth.access = data.access_token;
        this.auth.refresh = data.refresh_token ?? this.auth.refresh;
        response = await this.subscriptionRequest(session);
      }
      if (!response.ok && response.status !== 409) throw new Error();
      this.status("twitch", "Connected");
    } catch {
      this.status(
        "twitch",
        "EventSub subscription/authentication failed",
        true,
      );
      this.stop();
    }
  }
  private subscriptionRequest(session: string) {
    return fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.auth.access}`,
        "Client-Id": this.auth.client,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "channel.chat.message",
        version: "1",
        condition: {
          broadcaster_user_id: this.auth.broadcaster,
          user_id: this.auth.user,
        },
        transport: { method: "websocket", session_id: session },
      }),
      signal: AbortSignal.timeout(10000),
    });
  }
  stop() {
    this.active = false;
    this.reconnect.cancel();
    for (const socket of this.sockets) socket.close();
  }
}

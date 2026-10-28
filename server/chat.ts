import { createVerify } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import type { ChatMessage } from "../shared/types.js";
import { Store } from "./store.js";
type Status = (platform: string, status: string, fatal?: boolean) => void;
type Receive = (message: ChatMessage) => void;
export function youtubeMessage(
  item: any,
  store: Store,
  since: number,
): ChatMessage | undefined {
  const s = item.snippet;
  const a = item.authorDetails;
  if (!s || !a?.channelId || !item.id) return;
  const at = Date.parse(s.publishedAt);
  if (!Number.isFinite(at)) return;
  if (
    (s.type === 18 ||
      s.type === "membershipGiftingEvent" ||
      s.type === 21 ||
      s.type === "giftEvent") &&
    at >= since
  )
    store.gift(`youtube:${a.channelId}`, `youtube:${item.id}`, at);
  const gift = store.giftEvidence(`youtube:${a.channelId}`, since);
  const text =
    s.textMessageDetails?.messageText ??
    s.superChatDetails?.userComment ??
    s.memberMilestoneChatDetails?.userComment;
  if (typeof text !== "string") return;
  return {
    id: item.id,
    platform: "youtube",
    authorId: a.channelId,
    author: String(a.displayName ?? "Viewer"),
    text,
    timestamp: at,
    membership: {
      verified: true,
      member: a.isChatSponsor === true,
      gift: !!gift,
      evidence: gift ?? `youtube:${item.id}:authorDetails`,
    },
  };
}
export function twitchMessage(
  event: any,
  timestamp: string,
): ChatMessage | undefined {
  if (!event.message_id || !event.chatter_user_id || !event.message?.text)
    return;
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return;
  // Drop emote fragments so emote names are not submitted as prompt text.
  const text = Array.isArray(event.message.fragments)
    ? event.message.fragments
      .filter((f: any) => f.type !== "emote")
      .map((f: any) => f.text ?? "")
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
export function kickMessage(
  event: any,
  store: Store,
  since: number,
): ChatMessage | undefined {
  if (
    !event.message_id ||
    event.sender?.is_anonymous ||
    !event.sender?.user_id ||
    typeof event.content !== "string"
  )
    return;
  const at = Date.parse(event.created_at);
  if (!Number.isFinite(at)) return;
  const gift = store.giftEvidence(`kick:${event.sender.user_id}`, since);
  const member =
    event.sender.identity?.badges?.some((b: any) => b.type === "subscriber") ===
    true;
  return {
    id: event.message_id,
    platform: "kick",
    authorId: String(event.sender.user_id),
    author: String(event.sender.username ?? "Viewer"),
    text: event.content.replace(/\[emote:[^\]]+\]/g, ""),
    timestamp: at,
    membership: {
      verified: true,
      member,
      gift: !!gift,
      evidence: gift ?? `kick:${event.message_id}:signed-subscriber-badge`,
    },
  };
}
export function validKickSignature(
  publicKey: string,
  raw: Buffer,
  headers: { id: string; timestamp: string; signature: string },
  now = Date.now(),
) {
  if (
    !headers.id ||
    !headers.timestamp ||
    !headers.signature ||
    Math.abs(now - Date.parse(headers.timestamp)) > 300000 ||
    !Number.isFinite(Date.parse(headers.timestamp))
  )
    return false;
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headers.id}.${headers.timestamp}.`);
    verifier.update(raw);
    verifier.end();
    return verifier.verify(publicKey, headers.signature, "base64");
  } catch {
    return false;
  }
}
export class YouTubeChat {
  private client?: any;
  private stream?: grpc.ClientReadableStream<any>;
  private retry?: ReturnType<typeof setTimeout>;
  private active = false;
  private page?: string;
  private backoff = 1000;
  constructor(
    private auth: {
      access: string;
      refresh: string;
      client: string;
      secret: string;
      chat: string;
    },
    private store: Store,
    private receive: Receive,
    private status: Status,
    private since: () => number,
  ) { }
  start() {
    if (!this.auth.access || !this.auth.chat)
      throw new Error("YouTube token and live chat ID are required");
    const definition = loader.loadSync(
      fileURLToPath(new URL("./youtube.proto", import.meta.url)),
      { keepCase: false, longs: String, enums: Number, defaults: false },
    );
    const api: any = grpc.loadPackageDefinition(definition);
    this.client = new api.youtube.api.v3.V3DataLiveChatMessageService(
      "youtube.googleapis.com:443",
      grpc.credentials.createSsl(),
    );
    this.active = true;
    this.connect();
  }
  private connect() {
    if (!this.active) return;
    const metadata = new grpc.Metadata();
    metadata.set("authorization", `Bearer ${this.auth.access}`);
    this.stream = this.client.StreamList(
      {
        liveChatId: this.auth.chat,
        part: ["id", "snippet", "authorDetails"],
        ...(this.page ? { pageToken: this.page } : {}),
      },
      metadata,
    );
    this.status("youtube", "Connecting");
    this.stream!.on("data", (response: any) => {
      this.backoff = 1000;
      this.status("youtube", "Connected");
      this.page = response.nextPageToken ?? this.page;
      for (const item of response.items ?? []) {
        const message = youtubeMessage(item, this.store, this.since());
        if (message) this.receive(message);
      }
      if (response.offlineAt) {
        this.status("youtube", "Livestream ended", true);
        this.stop();
      }
    });
    this.stream!.on("error", (error: grpc.ServiceError) => {
      void this.failed(error.code);
    });
    this.stream!.on("end", () => this.schedule());
  }
  private async failed(code: number) {
    if (!this.active) return;
    if (
      code === grpc.status.UNAUTHENTICATED &&
      this.auth.refresh &&
      this.auth.client &&
      this.auth.secret
    ) {
      try {
        const response = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: this.auth.refresh,
            client_id: this.auth.client,
            client_secret: this.auth.secret,
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error();
        const data = (await response.json()) as any;
        this.auth.access = data.access_token;
        this.schedule();
        return;
      } catch {
        this.status(
          "youtube",
          "Authentication expired; update credentials",
          true,
        );
        this.stop();
        return;
      }
    }
    if (
      [
        grpc.status.UNAUTHENTICATED,
        grpc.status.PERMISSION_DENIED,
        grpc.status.FAILED_PRECONDITION,
        grpc.status.NOT_FOUND,
        grpc.status.RESOURCE_EXHAUSTED,
      ].includes(code)
    ) {
      this.status("youtube", `Chat API unavailable (code ${code})`, true);
      this.stop();
    } else {
      this.status("youtube", "Disconnected; reconnecting");
      this.schedule();
    }
  }
  private schedule() {
    if (!this.active || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(30000, this.backoff * 2);
  }
  stop() {
    this.active = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.stream?.cancel();
    this.client?.close();
  }
}
export class TwitchChat {
  private socket?: WebSocket;
  private sockets = new Set<WebSocket>();
  private active = false;
  private retry?: ReturnType<typeof setTimeout>;
  private backoff = 1000;
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
    const parsed = new URL(url);
    if (
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
      let m: any;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.metadata?.message_type === "session_welcome") {
        this.backoff = 1000;
        keepalive =
          (m.payload.session.keepalive_timeout_seconds ?? 10) * 1000 + 2000;
        touch();
        if (previous) {
          previous.close();
          this.status("twitch", "Connected");
        } else void this.subscribe(m.payload.session.id);
      } else if (m.metadata?.message_type === "session_reconnect")
        this.connect(m.payload.session.reconnect_url, socket);
      else if (m.metadata?.message_type === "revocation") {
        this.status("twitch", "Chat permission revoked", true);
        this.stop();
      } else if (
        m.metadata?.message_type === "notification" &&
        m.metadata.subscription_type === "channel.chat.message" &&
        String(m.payload.event.broadcaster_user_id) === this.auth.broadcaster
      ) {
        const message = twitchMessage(
          m.payload.event,
          m.metadata.message_timestamp,
        );
        if (message) this.receive(message);
      }
    });
    socket.on("close", () => {
      if (watchdog) clearTimeout(watchdog);
      this.sockets.delete(socket);
      if (this.active && socket === this.socket && !this.retry) {
        this.status("twitch", "Disconnected; reconnecting");
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.connect("wss://eventsub.wss.twitch.tv/ws");
        }, this.backoff);
        this.backoff = Math.min(30000, this.backoff * 2);
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
        const data = (await refresh.json()) as any;
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
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    for (const socket of this.sockets) socket.close();
  }
}
export class KickChat {
  private server?: Server;
  private publicKey = "";
  constructor(
    private auth: { access: string; broadcaster: string },
    private port: number,
    private host: string,
    private webhookUrl: string,
    private store: Store,
    private receive: Receive,
    private status: Status,
    private since: () => number,
  ) { }
  async start() {
    if (
      !this.auth.access ||
      !this.auth.broadcaster ||
      !this.webhookUrl.startsWith("https://")
    )
      throw new Error(
        "Kick token, broadcaster ID and HTTPS webhook URL are required",
      );
    const key = await fetch("https://api.kick.com/public/v1/public-key", {
      signal: AbortSignal.timeout(10000),
    });
    if (!key.ok) throw new Error("Kick verification key unavailable");
    this.publicKey = ((await key.json()) as any).data.public_key;
    if (!this.publicKey?.includes("BEGIN PUBLIC KEY"))
      throw new Error("Invalid Kick verification key");
    this.server = createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/kick") {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 256000) {
            res.writeHead(413).end();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks);
        const id = String(req.headers["kick-event-message-id"] ?? "");
        if (
          req.headers["kick-event-version"] !== "1" ||
          !validKickSignature(this.publicKey, raw, {
            id,
            timestamp: String(
              req.headers["kick-event-message-timestamp"] ?? "",
            ),
            signature: String(req.headers["kick-event-signature"] ?? ""),
          })
        ) {
          res.writeHead(401).end();
          return;
        }
        const e = JSON.parse(raw.toString());
        if (String(e.broadcaster?.user_id) !== this.auth.broadcaster) {
          res.writeHead(403).end();
          return;
        }
        if (!this.store.seen(`kick-webhook:${id}`)) {
          const type = req.headers["kick-event-type"];
          if (
            type === "channel.subscription.gifts" &&
            !e.gifter?.is_anonymous &&
            e.gifter?.user_id
          )
            this.store.gift(
              `kick:${e.gifter.user_id}`,
              `kick:${id}`,
              Date.parse(e.created_at),
            );
          if (type === "kicks.gifted" && e.sender?.user_id)
            this.store.gift(
              `kick:${e.sender.user_id}`,
              `kick:${id}`,
              Date.parse(e.created_at),
            );
          if (type === "chat.message.sent") {
            const message = kickMessage(e, this.store, this.since());
            if (message) this.receive(message);
          }
        }
        this.status("kick", "Connected");
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, this.host, resolve);
    });
    const response = await fetch(
      "https://api.kick.com/public/v1/events/subscriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.auth.access}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          broadcaster_user_id: Number(this.auth.broadcaster),
          events: [
            { name: "chat.message.sent", version: 1 },
            { name: "channel.subscription.gifts", version: 1 },
            { name: "kicks.gifted", version: 1 },
          ],
          method: "webhook",
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok && response.status !== 409) {
      this.stop();
      throw new Error(`Kick subscription failed (${response.status})`);
    }
    this.status("kick", "Subscribed; waiting for signed events");
  }
  stop() {
    this.server?.close();
    this.server = undefined;
  }
}

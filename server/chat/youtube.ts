import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import type { ChatMessage } from "../../shared/types.js";
import type { Store } from "../store.js";
import { Reconnect } from "./backoff.js";
import { ensureYoutubeChatId } from "./platform-setup.js";
import {
  oauthRefreshSchema,
  type ChatSource,
  type Receive,
  type Status,
} from "./source.js";

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
export class YouTubeChat implements ChatSource {
  readonly platform = "youtube";
  readonly runningStatuses = ["Connected", "Connecting"];
  readonly confirmsConnection = true;
  private client?: any;
  private stream?: grpc.ClientReadableStream<any>;
  private reconnect = new Reconnect(() => this.connect());
  private active = false;
  private page?: string;
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
  prepare() {
    return ensureYoutubeChatId(this.auth);
  }
  start() {
    if (!this.auth.access || !this.auth.chat)
      throw new Error("YouTube token and live chat ID are required");
    const definition = loader.loadSync(
      fileURLToPath(new URL("../youtube.proto", import.meta.url)),
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
      this.reconnect.connected();
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
        // A body without a token would retry with "Bearer undefined" forever.
        const data = oauthRefreshSchema.parse(await response.json());
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
    if (this.active) this.reconnect.schedule();
  }
  stop() {
    this.active = false;
    this.reconnect.cancel();
    this.stream?.cancel();
    this.client?.close();
  }
}

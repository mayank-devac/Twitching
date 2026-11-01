import { createVerify } from "node:crypto";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import type { ChatMessage } from "../../shared/types.js";
import type { Store } from "../store.js";
import { Backoff } from "./backoff.js";
import type { ChatSource, Receive, Status } from "./source.js";

// Untrusted network JSON: each schema names only the fields this file reads.
// loose: kickMessage also reads sender.username and sender.identity.
const kickUserSchema = z.looseObject({
  user_id: z.unknown().optional(),
  is_anonymous: z.boolean().optional(),
});
// loose: the full event still goes to kickMessage, which reads its own fields (content, message_id).
const kickWebhookSchema = z.looseObject({
  broadcaster: kickUserSchema.optional(),
  gifter: kickUserSchema.nullish(),
  sender: kickUserSchema.optional(),
  created_at: z.string().optional(),
});
const kickTokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.unknown(),
});
const kickPublicKeySchema = z.object({
  data: z.object({ public_key: z.string() }),
});

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
type KickAuth = {
  access: string;
  broadcaster: string;
  client?: string;
  secret?: string;
};
// Kick app access token. With KICK_CLIENT_ID + KICK_CLIENT_SECRET it is minted
// via the client-credentials grant and kept in memory only (never written to
// disk or logged); otherwise the static KICK_ACCESS_TOKEN is used unchanged.
export class KickToken {
  private token = "";
  private expiresAt = 0;
  private pending?: Promise<string>;
  private retryAt = 0;
  private backoff = new Backoff();
  constructor(
    private auth: Pick<KickAuth, "access" | "client" | "secret">,
    private fetchImpl: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) { }
  get usesClientCredentials() {
    return !!(this.auth.client?.trim() && this.auth.secret?.trim());
  }
  get configured() {
    return this.usesClientCredentials || !!this.auth.access;
  }
  // Current minted value, so the redactor can hide it; empty until fetched.
  current() {
    return this.token;
  }
  async get(force = false): Promise<string> {
    if (!this.usesClientCredentials) return this.auth.access;
    // Refresh a minute early so a request never races the expiry.
    if (!force && this.token && this.now() < this.expiresAt - 60000)
      return this.token;
    this.pending ??= this.refresh().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async refresh() {
    // Same 1s..30s doubling backoff as the chat reconnect loops, so a bad
    // secret or an id.kick.com outage cannot turn into a request storm.
    if (this.now() < this.retryAt)
      throw new Error("Kick token refresh is backing off; try again shortly");
    try {
      const response = await this.fetchImpl("https://id.kick.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.auth.client!.trim(),
          client_secret: this.auth.secret!.trim(),
        }).toString(),
        signal: AbortSignal.timeout(10000),
      });
      // Only the status is reported; the body may echo credentials.
      if (!response.ok)
        throw new Error(`Kick token request failed (${response.status})`);
      const body = kickTokenSchema.safeParse(await response.json());
      if (!body.success)
        throw new Error("Kick token response had no access token");
      const seconds = Number(body.data.expires_in);
      this.token = body.data.access_token;
      this.expiresAt =
        this.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
      this.backoff.reset();
      this.retryAt = 0;
      return this.token;
    } catch (error) {
      this.retryAt = this.now() + this.backoff.next();
      throw error;
    }
  }
}
export class KickChat implements ChatSource {
  readonly platform = "kick";
  // Kick reports "Connected" only once a signed webhook arrives, so going live does not wait for it.
  readonly runningStatuses = ["Connected"];
  readonly confirmsConnection = false;
  private server?: Server;
  private publicKey = "";
  constructor(
    private auth: KickAuth,
    private port: number,
    private host: string,
    private webhookUrl: string,
    private store: Store,
    private receive: Receive,
    private status: Status,
    private since: () => number,
    private token = new KickToken(auth),
    private fetchImpl: typeof fetch = fetch,
  ) { }
  async start() {
    if (
      !this.token.configured ||
      !this.auth.broadcaster ||
      !this.webhookUrl.startsWith("https://")
    )
      throw new Error(
        "Kick token (or client ID + secret), broadcaster ID and HTTPS webhook URL are required",
      );
    const key = await this.fetchImpl("https://api.kick.com/public/v1/public-key", {
      signal: AbortSignal.timeout(10000),
    });
    if (!key.ok) throw new Error("Kick verification key unavailable");
    const published = kickPublicKeySchema.safeParse(await key.json());
    this.publicKey = published.success ? published.data.data.public_key : "";
    if (!this.publicKey.includes("BEGIN PUBLIC KEY"))
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
        // Signed but malformed bodies fall through to the 400 below.
        const e = kickWebhookSchema.parse(JSON.parse(raw.toString()));
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
              Date.parse(e.created_at ?? ""),
            );
          if (type === "kicks.gifted" && e.sender?.user_id)
            this.store.gift(
              `kick:${e.sender.user_id}`,
              `kick:${id}`,
              Date.parse(e.created_at ?? ""),
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
    const subscribe = async (force = false) =>
      this.fetchImpl("https://api.kick.com/public/v1/events/subscriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.token.get(force)}`,
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
      });
    let response: Response;
    try {
      response = await subscribe();
      // A minted token can be revoked early; refresh once and retry on 401.
      if (response.status === 401 && this.token.usesClientCredentials)
        response = await subscribe(true);
    } catch (error) {
      this.stop();
      throw error;
    }
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

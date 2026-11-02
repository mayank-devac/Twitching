import express from "express";
import { z } from "zod";
import { CHAT_PLATFORMS, type ChatPlatform } from "../shared/settings.js";
import type { ChatFeed, FeedStatus } from "./chat-feed.js";
import type { HostOnly } from "./http-kit.js";
import { HttpError, routeAction } from "./http-kit.js";

export interface ChatFeedServices {
  feed: ChatFeed;
  // Which platform keys exist in the environment, by platform.
  configured: () => Record<ChatPlatform, boolean>;
  connections: () => Record<string, string>;
  // Sends a prompt into the running arena collection.
  send: (message: NonNullable<ReturnType<ChatFeed["asPrompt"]>>) => Promise<void>;
  arenaOpen: () => boolean;
}

const settingsBody = z
  .object({ enabled: z.boolean(), hideBlocked: z.boolean(), mode: z.enum(["mask", "hide"]) })
  .partial()
  .strict();
const sendBody = z.object({ platform: z.enum(CHAT_PLATFORMS), id: z.string().min(1).max(200) }).strict();
const num = z.coerce.number().int().min(0).max(1_000_000_000);

export function chatFeedRoutes(app: express.Express, services: ChatFeedServices, guard: HostOnly) {
  const statuses = (): FeedStatus[] => {
    const configured = services.configured();
    const connections = services.connections();
    return CHAT_PLATFORMS.map((platform) => ({
      platform,
      configured: configured[platform],
      status: connections[platform] ?? (configured[platform] ? "Idle" : "No key"),
    }));
  };
  // Public on purpose: the OBS browser source has no host cookie. It only ever
  // receives the filtered view, and blocked words are removed server-side.
  app.get("/api/chat-feed", (req, res) => {
    const only = String(req.query.platforms ?? "")
      .split(",")
      .filter((p): p is ChatPlatform => (CHAT_PLATFORMS as readonly string[]).includes(p));
    const since = req.query.since === undefined ? undefined : num.safeParse(req.query.since);
    const limit = num.safeParse(req.query.limit ?? 100);
    res.json(
      services.feed.view(statuses(), {
        only: only.length ? only : undefined,
        prompts: req.query.prompts === "1",
        since: since?.success ? since.data : undefined,
        rev: typeof req.query.rev === "string" ? req.query.rev : undefined,
        limit: limit.success ? Math.min(limit.data, 300) || 100 : 100,
      }),
    );
  });
  app.post(
    "/api/chat-feed/settings",
    guard("Use the local control panel to change chat filtering"),
    express.json({ limit: "1kb" }),
    routeAction((req) => {
      const input = settingsBody.safeParse(req.body);
      if (!input.success) throw new HttpError(400, "Invalid chat filter setting");
      services.feed.update(input.data);
      return services.feed.settings;
    }, { status: 409, failed: "Chat filter was not saved" }),
  );
  app.post(
    "/api/chat-feed/send",
    guard("Use the local control panel to send a prompt"),
    express.json({ limit: "1kb" }),
    routeAction(async (req) => {
      const input = sendBody.safeParse(req.body);
      if (!input.success) throw new HttpError(400, "Invalid prompt request");
      if (!services.feed.settings.enabled) throw new HttpError(409, "Turn on the chat feed first");
      if (!services.arenaOpen()) throw new HttpError(409, "Open the prompt arena and start a round first");
      const message = services.feed.asPrompt(input.data.platform, input.data.id);
      if (!message) throw new HttpError(404, "That comment is no longer in the feed");
      await services.send(message);
      return { ok: true };
    }, { status: 409, failed: "Prompt was not sent" }),
  );
}

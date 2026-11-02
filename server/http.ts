import type { PresentationControls } from "./presentation-controls.js";
import { presentationAction, PresentationConflict } from "./presentation-controls.js";
import { presentationRoutes } from "./presentation-http.js";
import { lstat, realpath } from "node:fs/promises";
import { settingsRoutes, type SettingsServices } from "./settings-http.js";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import type { Controller } from "./controller.js";
import { activityPatches } from "../shared/activity-stream.js";
import { overlayPatches } from "../shared/overlay-stream.js";
import type { ShowState } from "../shared/types.js";
import type { SnapshotMessage, UpdateMessage } from "../shared/server-message.js";
import { sessionRoutes } from "./sessions/http.js";
import { hostCheck, hostOnly, HttpError, routeAction } from "./http-kit.js";
import { urlHost, type BootIdentity, type BootResponse } from "../shared/boot.js";
import type { Sessions } from "./sessions/service.js";
import { chatFeedRoutes, type ChatFeedServices } from "./chat-feed-http.js";
const requestSchema = z.object({
  action: z.enum([
    "start",
    "pause",
    "resume",
    "skip",
    "stop",
    "stop-choice",
    "reject",
    "confirm-rehearsal",
    "rehearsal-task",
    "suggest",
  ]),
  id: z.string().max(80).optional(),
  text: z.string().max(700).optional(),
  choice: z
    .enum(["chat-now", "chat-after", "stream-now", "stream-after"])
    .optional(),
  youtube: z.boolean().optional(),
  twitch: z.boolean().optional(),
  kick: z.boolean().optional(),
});
// Re-exported for callers that already import it from here.
export { urlHost };
export function makeHttp(
  controller: Controller,
  options: {
    host: string;
    port: number;
    previewOrigin: string;
    root: string;
    musicPath: string;
    quick?: SettingsServices;
    presentation?: PresentationControls;
    sessions?: Sessions;
    openObs?: () => Promise<void>;
    boot?: BootIdentity;
    chatFeed?: ChatFeedServices;
  },
) {
  const origin = `http://${urlHost(options.host)}:${options.port}`;
  const csrf = randomBytes(32).toString("hex");
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (req.headers.host !== new URL(origin).host) {
      res.status(403).end();
      return;
    }
    res.set({
      "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://${urlHost(options.host)}:${options.port}; frame-src ${options.previewOrigin}; img-src 'self' data:; media-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    if (req.headers.origin && req.headers.origin !== origin) {
      res.status(403).end();
      return;
    }
    next();
  });
  const hostContexts = new Map<string, { identity: string; version: number }>();
  let contextVersion = 0;
  const publicState = (overlay = "default") => {
    const base = options.sessions?.snapshot(controller.snapshot(), overlay) ?? controller.snapshot();
    // Publish only an opaque generation, never private session identifiers while hidden.
    const identity = JSON.stringify([base.experience, base.round?.id, base.sharedSession?.conversation.id, base.sharedOverlay?.frames.map((frame) => frame.conversation.id)]);
    let context = hostContexts.get(overlay);
    if (!context || context.identity !== identity) {
      context = { identity, version: ++contextVersion };
      hostContexts.set(overlay, context);
    }
    return { ...(options.presentation?.publicSnapshot(base, overlay, options.quick?.preferences.get().value.media) ?? base), hostContext: context.version };
  };
  app.get("/api/state", (_req, res) => res.json(publicState()));
  app.get("/api/boot", (_req, res) => res.json((options.boot ?? {}) satisfies BootResponse));
  const guard = hostOnly(hostCheck(csrf, origin));
  app.get("/api/host", (req, res) => {
    if (
      req.headers["sec-fetch-site"] &&
      !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"]))
    ) {
      res.status(403).end();
      return;
    }
    res.cookie("arena_host", csrf, {
      httpOnly: true,
      sameSite: "strict",
      path: "/api",
      maxAge: 86400000,
    });
    res.json({ csrf });
  });
  app.get("/api/host-state", guard("Use the local control panel to operate the show"), (_req, res) => {
    res.json({ ...controller.hostSnapshot(), presentation: options.presentation?.get(), experience: options.sessions?.experience,
      sharedSession: options.sessions?.snapshot(controller.snapshot()).sharedSession, sharedOverlay: options.sessions?.snapshot(controller.snapshot()).sharedOverlay });
  });
  // Privacy actions authenticate before parsing, and never touch the running controller.
  app.post("/api/presentation", guard("Use local host controls"), express.json({ limit: "2kb" }), routeAction((req) => {
    const input = presentationAction.safeParse(req.body);
    if (!input.success || !options.presentation) throw new HttpError(400, "Invalid presentation action");
    return options.presentation.act(input.data);
  }, { status: 409, failed: "Presentation was not saved. Retry before relying on privacy.", expose: (error) => error instanceof PresentationConflict }));
  const rehearsal = options.quick && options.presentation ? presentationRoutes(app, controller, options.quick, options.presentation, options.sessions, guard) : undefined;
  if (options.sessions && rehearsal) options.sessions.requirePresentationRehearsal = rehearsal;
  if (options.chatFeed) chatFeedRoutes(app, options.chatFeed, guard);
  // Settings routes share the existing host cookie and CSRF token checks.
  if (options.quick)
    settingsRoutes(app, controller, options.quick, guard);
  if (options.sessions)
    sessionRoutes(app, options.sessions, guard, options.openObs ?? (async () => { throw new Error("Open OBS manually"); }), (id) => { const p = options.presentation?.get(id); return !!(p?.hidden || p?.breakActive); }, rehearsal, () => options.presentation?.selections());
  // The guard runs before body parsing, so an unauthenticated caller gets 403 and never has a body read.
  app.post("/api/action", guard("Use the local control panel to operate the show"), express.json({ limit: "2kb" }), routeAction(async (req) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid control action");
    const { action, id, text, choice, youtube, twitch, kick } = parsed.data;
    if (["start", "resume", "rehearsal-task", "suggest"].includes(action) && options.sessions?.experience !== undefined && options.sessions.experience !== "arena")
      throw new Error("Choose Existing prompt arena in the welcome dialog first");
    if ((action === "start" || action === "resume") && controller.state?.mode === "live") rehearsal?.("arena");
    if (action === "confirm-rehearsal") rehearsal?.("arena");
    if (action === "start") await controller.start();
    else if (action === "pause") controller.pause();
    else if (action === "resume") await controller.resume();
    else if (action === "skip") await controller.skip();
    else if (action === "stop") await controller.stop();
    else if (action === "stop-choice") {
      if (!choice) throw new Error("Pick chat or end-stream");
      await controller.hostChoice(choice, { youtube, twitch, kick });
    } else if (action === "reject") {
      if (!id) throw new Error("Candidate ID required");
      controller.reject(id);
    } else if (action === "confirm-rehearsal") controller.confirmRehearsal();
    else if (action === "rehearsal-task") controller.prepareRehearsal(text);
    else if (action === "suggest") {
      if (controller.state.mode !== "rehearsal")
        throw new Error(
          "Test suggestions are available only in private rehearsal mode",
        );
      await controller.ingest({
        id: randomBytes(12).toString("hex"),
        platform: "youtube",
        authorId: "host-rehearsal",
        author: "Host test",
        text: text ?? "",
        timestamp: Date.now(),
        membership: { verified: false, member: false, gift: false },
      });
    }
    return { ok: true };
  }, { status: 409, failed: "Action failed" }));
  // One fixed GIF route keeps the repository and other assets outside static serving.
  app.get("/media/break-visual.gif", async (_req, res) => {
    const path = resolve(options.root, "assets/break-visual.gif");
    try {
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (await realpath(path)) !== path
      )
        throw new Error("Unsafe default visual");
      res.type("gif").sendFile(path, (error) => {
        if (error && !res.headersSent) res.status(404).end();
      });
    } catch {
      res.status(404).end();
    }
  });
  app.get("/media/break.mp3", (_req, res) => {
    res.sendFile(options.musicPath, (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  });
  // Only built public assets are served. Project files, runtime data and secrets are never static roots.
  app.use(
    express.static(resolve(options.root, "dist"), {
      index: false,
      dotfiles: "deny",
    }),
  );
  app.get(["/", "/overlay", "/control", "/control/welcome", "/control/settings", "/control/chats", "/chat", "/chats/prompts"], (_req, res) =>
    res.sendFile(resolve(options.root, "dist/index.html")),
  );
  app.get("/overlay/:overlayId", (req, res) => {
    if (!/^[a-f0-9-]{36}$/.test(String(req.params.overlayId))) { res.status(404).end(); return; }
    res.sendFile(resolve(options.root, "dist/index.html"));
  });
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(400).json({ error: "Invalid request" });
    },
  );
  const server = createServer(app);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const channels = new WeakMap<WebSocket, string>();
  const previous = new Map<string, ShowState>();
  // The full wire state last sent per channel; an identical one carries no change.
  const sent = new Map<string, string>();
  // A browser source receives only its named output, never the assignments of another output.
  const wireState = (state: ShowState, patch = false): ShowState => ({
    ...state,
    sharedSession: state.sharedOverlay ? undefined : state.sharedSession,
    sharedOverlay: state.sharedOverlay ? { ...state.sharedOverlay, frames: state.sharedOverlay.frames.map((frame) => ({ ...frame, page: { ...frame.page, items: patch ? [] : frame.page.items } })) } : undefined,
  });
  server.on("upgrade", (req, socket, head) => {
    let request: URL;
    try { request = new URL(req.url ?? "", origin); } catch { socket.destroy(); return; }
    const overlay = request.searchParams.get("overlay") ?? "default";
    if (request.pathname !== "/events" || !/^(default|[a-f0-9-]{36})$/.test(overlay) ||
      req.headers.host !== new URL(origin).host || req.headers.origin !== origin) {
      socket.destroy(); return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      channels.set(ws, overlay); sockets.emit("connection", ws, req);
    });
  });
  // Typed against the client's parser so the wire shape cannot drift silently.
  const snapshot = (state: ShowState): SnapshotMessage =>
    ({ type: "snapshot", state: wireState(state), previewOrigin: options.previewOrigin });
  // Sockets that answered the last ping; others are dead and get terminated.
  const alive = new WeakSet<WebSocket>();
  sockets.on("connection", (socket) => {
    const channel = channels.get(socket) ?? "default";
    const state = publicState(channel);
    if (!previous.has(channel)) {
      previous.set(channel, state);
      sent.set(channel, JSON.stringify(wireState(state)));
    }
    socket.send(JSON.stringify(snapshot(state)));
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
    socket.on("error", () => socket.terminate());
    socket.on("message", () => socket.close(1008, "Read-only overlay socket"));
  });
  const broadcast = () => {
    const active = new Set([...sockets.clients].map((socket) => channels.get(socket) ?? "default"));
    for (const id of previous.keys()) if (!active.has(id)) previous.delete(id);
    for (const id of sent.keys()) if (!active.has(id)) sent.delete(id);
    for (const channel of active) {
      const state = publicState(channel), before = previous.get(channel);
      const session = state.sharedOverlay ? undefined : state.sharedSession;
      const previousItems = before?.sharedSession?.conversation.id === session?.conversation.id ? before?.sharedSession?.page.items ?? [] : [];
      // Privacy transitions always send complete snapshots before any further patches.
      const privacyChanged = before?.presentation?.hidden !== state.presentation?.hidden || before?.presentation?.breakActive !== state.presentation?.breakActive;
      const update = (): UpdateMessage => ({
        type: "update", state: { ...wireState(state, true), events: [], sharedSession: session ? { ...session, page: { ...session.page, items: [] } } : undefined },
        overlayPatches: overlayPatches(before?.sharedOverlay, state.sharedOverlay),
        sessionPatches: activityPatches(previousItems, session?.page.items ?? []),
        sessionItemIds: session?.page.items.map((item) => item.id) ?? [],
        patches: activityPatches(before?.events ?? [], state.events), eventIds: state.events.map((event) => event.id),
        previewOrigin: options.previewOrigin,
      });
      // Many emitters fire "state" without changing this channel's public view;
      // an unchanged full wire state means empty patches, so skip the frame.
      const key = JSON.stringify(wireState(state));
      if (sent.get(channel) === key) continue;
      sent.set(channel, key);
      const payload = JSON.stringify(privacyChanged ? snapshot(state) : update());
      previous.set(channel, state);
      for (const socket of sockets.clients) if ((channels.get(socket) ?? "default") === channel && socket.readyState === WebSocket.OPEN) {
        if (socket.bufferedAmount > 8_000_000) socket.terminate();
        else socket.send(payload);
      }
    }
  };
  options.presentation?.on("state", broadcast);
  controller.on("state", broadcast);
  options.sessions?.on("state", broadcast);
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!alive.has(socket)) { socket.terminate(); continue; }
      alive.delete(socket);
      socket.ping();
    }
  }, 20000);
  heartbeat.unref();
  sockets.on("close", () => clearInterval(heartbeat));
  return {
    app,
    server,
    close: () => {
      clearInterval(heartbeat);
      options.presentation?.off("state", broadcast);
      controller.off("state", broadcast);
      options.sessions?.off("state", broadcast);
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

import { settingsRoutes, type SettingsServices } from "./settings-http.js";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import type { Controller } from "./controller.js";
import { activityPatches } from "../shared/activity-stream.js";
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
export function makeHttp(
  controller: Controller,
  options: {
    host: string;
    port: number;
    previewOrigin: string;
    root: string;
    musicPath: string;
    quick?: SettingsServices;
    boot?: { rootId: string; configurationId: string; startedAt: number };
  },
) {
  const origin = `http://${options.host}:${options.port}`;
  const csrf = randomBytes(32).toString("hex");
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (req.headers.host !== new URL(origin).host) {
      res.status(403).end();
      return;
    }
    res.set({
      "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://${options.host}:${options.port}; frame-src ${options.previewOrigin}; img-src 'self' data:; media-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
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
  app.get("/api/state", (_req, res) => res.json(controller.snapshot()));
  app.get("/api/boot", (_req, res) => res.json(options.boot ?? {}));
  const hostAuthorized = (req: express.Request) => {
    const token = String(req.headers["x-host-token"] ?? "");
    const cookie = String(req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("arena_host="))
      ?.slice(11);
    if (
      cookie !== csrf ||
      token.length !== csrf.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))
    )
      return false;
    if (req.headers.origin) return req.headers.origin === origin;
    // Same-origin GET leaves Origin off. POST still has to send it.
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const site = req.headers["sec-fetch-site"];
    return !site || ["same-origin", "none"].includes(String(site));
  };
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
  app.get("/api/host-state", (req, res) => {
    if (!hostAuthorized(req)) {
      res
        .status(403)
        .json({ error: "Use the local control panel to operate the show" });
      return;
    }
    res.json(controller.hostSnapshot());
  });
  // Settings routes share the existing host cookie and CSRF token checks.
  if (options.quick) settingsRoutes(app, controller, options.quick, hostAuthorized);
  app.post("/api/action", express.json({ limit: "2kb" }), async (req, res) => {
    if (!hostAuthorized(req)) {
      res
        .status(403)
        .json({ error: "Use the local control panel to operate the show" });
      return;
    }
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid control action" });
      return;
    }
    const { action, id, text, choice, youtube, twitch, kick } = parsed.data;
    try {
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
      res.json({ ok: true });
    } catch (error) {
      res.status(409).json({
        error: error instanceof Error ? error.message : "Action failed",
      });
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
  app.get(["/", "/overlay", "/control", "/control/settings"], (_req, res) =>
    res.sendFile(resolve(options.root, "dist/index.html")),
  );
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
  server.on("upgrade", (req, socket, head) => {
    if (
      req.url !== "/events" ||
      req.headers.host !== new URL(origin).host ||
      req.headers.origin !== origin
    ) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) =>
      sockets.emit("connection", ws, req),
    );
  });
  const snapshot = () =>
    JSON.stringify({
      type: "snapshot",
      state: controller.snapshot(),
      previewOrigin: options.previewOrigin,
    });
  sockets.on("connection", (socket) => {
    socket.send(snapshot());
    socket.on("error", () => socket.terminate());
    socket.on("message", () => socket.close(1008, "Read-only overlay socket"));
  });
  let previousEvents = controller.snapshot().events;
  const broadcast = () => {
    const state = controller.snapshot();
    const payload = JSON.stringify({
      type: "update",
      state: { ...state, events: [] },
      patches: activityPatches(previousEvents, state.events),
      eventIds: state.events.map((event) => event.id),
      previewOrigin: options.previewOrigin,
    });
    previousEvents = state.events;
    for (const socket of sockets.clients)
      if (socket.readyState === WebSocket.OPEN) {
        if (socket.bufferedAmount > 1_000_000) socket.terminate();
        else socket.send(payload);
      }
  };
  controller.on("state", broadcast);
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) socket.ping();
  }, 20000);
  heartbeat.unref();
  return {
    app,
    server,
    close: () => {
      clearInterval(heartbeat);
      controller.off("state", broadcast);
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

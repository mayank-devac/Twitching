import express from "express";
import { z } from "zod";
import type { Sessions } from "./service.js";
import { cliSchema, runnerModeSchema } from "../../shared/schema.js";
import { CLIS } from "../../shared/types.js";
import { routeAction, type HostOnly } from "../http-kit.js";
import { SetupError } from "../cli-startup-repair.js";

const identifier = z
  .string()
  .min(1)
  .max(220)
  .regex(/^[a-zA-Z0-9:_-]+$/);
const cursor = z.string().min(1).max(4000).optional();
const listing = z.object({
  source: z.enum(["managed", "all", ...CLIS]),
  search: z.string().max(160).default(""),
  before: cursor,
});
const cliRunner = { cli: cliSchema, runner: runnerModeSchema };
const overlayId = z.string().regex(/^(default|[a-f0-9-]{36})$/);
const page = z.object({
  id: identifier,
  before: cursor,
  overlay: overlayId.default("default"),
});
const overlayAction = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    revision: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(80),
  }),
  z.object({
    action: z.literal("save"),
    captureRunning: z.boolean().optional(),
    revision: z.number().int().nonnegative(),
    overlay: z
      .object({
        id: overlayId,
        name: z.string().trim().min(1).max(80),
        selection: z.enum(["selected", "running-snapshot", "follow-running"]),
        sessionIds: z.array(identifier).max(8),
        published: z.boolean(),
      })
      .strict(),
  }),
  z.object({
    action: z.literal("delete"),
    revision: z.number().int().nonnegative(),
    id: overlayId,
  }),
  z.object({ action: z.literal("stop"), id: overlayId }),
]);
const action = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    ...cliRunner,
    nativeConsent: z.literal("NATIVE").optional(),
  }),
  z.object({ action: z.literal("publish"), id: identifier }),
  z.object({ action: z.literal("confirm-rehearsal"), id: identifier }),
  z.object({ action: z.literal("unpublish") }),
  z.object({
    action: z.literal("run"),
    id: identifier,
    text: z.string().trim().min(1).max(12000),
    nativeConsent: z.literal("NATIVE").optional(),
  }),
  z.object({ action: z.literal("arena") }),
  z.object({ action: z.literal("session-mode"), choice: z.enum(["wait", "cancel"]).optional() }),
  z.object({ action: z.literal("open-obs") }),
]);

// Private preview routes authenticate before looking up provider metadata or transcripts.
export function sessionRoutes(
  app: express.Express,
  sessions: Sessions,
  hostOnly: HostOnly,
  openObs: () => Promise<void>,
  hidden = (_overlay = "default") => false,
  rehearsal?: (context: string) => void,
  presentations?: () => import("../../shared/sessions.js").OverlayHostDocument["presentation"],
) {
  app.use("/api/sessions", hostOnly("Use the local welcome dialog"));
  const respond = (operation: (req: express.Request) => unknown) =>
    routeAction(operation, { status: 409, invalid: "Invalid session request", failed: "Session request failed" });
  app.get(
    "/api/sessions/readiness",
    respond(() => sessions.readiness()),
  );
  app.get(
    "/api/sessions/overlays",
    respond(async () => ({ ...sessions.overlays.host(), presentation: presentations?.() })),
  );
  app.post(
    "/api/sessions/overlays",
    express.json({ limit: "8kb" }),
    respond(async (req) => {
      const input = overlayAction.parse(req.body);
      if (input.action === "save" && input.overlay.published && sessions.mode === "live") {
        for (const id of input.overlay.sessionIds) rehearsal?.(id);
      }
      switch (input.action) {
        case "create":
          return { ...sessions.overlays.create(input.revision, input.name), presentation: presentations?.() };
        case "save":
          return { ...await sessions.overlays.save(input.revision, input.overlay, input.captureRunning), presentation: presentations?.() };
        case "delete":
          return { ...sessions.overlays.remove(input.revision, input.id), presentation: presentations?.() };
        case "stop":
          sessions.overlays.stop(input.id);
          return { ...sessions.overlays.host(), presentation: presentations?.() };
      }
    }),
  );
  app.get(
    "/api/sessions/models",
    respond(async (req) => {
      const input = z
        .object(cliRunner)
        .parse(req.query);
      try {
        return { models: await sessions.models(input.cli, input.runner) };
      } catch (error) {
        // Setup messages are written by the app and safe to show; anything else may hold CLI output.
        if (error instanceof SetupError) throw new Error(error.message);
        throw new Error(
          "Models unavailable. Check that this CLI is installed and signed in for the selected runner. Docker uses the arena login; native uses the installed CLI login.",
        );
      }
    }),
  );
  app.get(
    "/api/sessions/list",
    respond((req) => {
      const q = listing.parse(req.query);
      return sessions.list(q.source, q.search, q.before);
    }),
  );
  app.get(
    "/api/sessions/view",
    respond((req) => {
      const q = page.parse(req.query);
      return sessions.view(q.id, q.before);
    }),
  );
  app.get(
    "/api/sessions/result",
    respond((req) => sessions.result(identifier.parse(req.query.id))),
  );
  app.post(
    "/api/sessions/action",
    express.json({ limit: "16kb" }),
    respond(async (req) => {
      const input = action.parse(req.body);
      switch (input.action) {
        case "create":
          return sessions.create(input.cli, input.runner, input.nativeConsent);
        case "publish":
          if (sessions.mode === "live") rehearsal?.(input.id);
          await sessions.publish(input.id);
          break;
        case "confirm-rehearsal":
          rehearsal?.(input.id);
          await sessions.confirmRehearsal(input.id);
          break;
        case "unpublish":
          sessions.stopPublication();
          break;
        case "run":
          return sessions.run(input.id, input.text, input.nativeConsent);
        case "arena":
          sessions.arena();
          break;
        case "session-mode":
          return sessions.sessionMode(input.choice);
        case "open-obs":
          await openObs();
          break;
      }
      return { ok: true };
    }),
  );
  // The overlay can page only the currently published conversation, with visibility filtering.
  app.get(
    "/api/public-session",
    respond(async (req) => {
      const q = page.parse(req.query);
      if (hidden(q.overlay)) throw new Error("Back shortly");
      const result = await sessions.publicHistory(q.id, q.before, q.overlay);
      if (hidden(q.overlay)) throw new Error("Back shortly");
      return result;
    }),
  );
}

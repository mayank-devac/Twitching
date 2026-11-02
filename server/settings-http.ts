import { basename } from "node:path";
import express from "express";
import { z } from "zod";
import type { Controller } from "./controller.js";
import type { Agent, RunnerMode } from "../shared/types.js";
import { cliSchema, runnerModeSchema } from "../shared/schema.js";
import type { QuickSettings } from "./quick-settings.js";
import { saveSettingsSchema } from "./quick-settings.js";
import { validateModel } from "./cli/index.js";
import type { CliModel } from "./cli/types.js";
import type { Store } from "./store.js";
import type { BreakMedia } from "./break-media.js";
import { HttpError, routeAction, type HostOnly } from "./http-kit.js";
import { SetupError } from "./cli-startup-repair.js";

export interface SettingsServices {
  preferences: QuickSettings;
  media: BreakMedia;
  store: Store;
  discover(cli: Agent, runner?: RunnerMode): Promise<CliModel[]>;
  runner?: RunnerMode;
  defaults?: { audio: string; visual: string; visualUrl: string };
}
// Every host route authenticates before parsing a body or doing expensive discovery.
export function settingsRoutes(
  app: express.Express,
  controller: Controller,
  services: SettingsServices,
  hostOnly: HostOnly,
) {
  const { preferences, media, store } = services;
  app.use(
    [
      "/api/settings",
      "/api/models",
      "/api/history",
      "/api/break-media",
      "/api/quick-action",
    ],
    hostOnly("Open the local control panel to use settings"),
  );
  // Concurrent refreshes share a probe instead of spawning duplicate CLI processes.
  const probes = new Map<Agent, Promise<CliModel[]>>();
  const discover = (cli: Agent) => {
    let pending = probes.get(cli);
    if (!pending) {
      pending = services.discover(cli).finally(() => probes.delete(cli));
      probes.set(cli, pending);
    }
    return pending;
  };
  app.get("/api/settings", (_req, res) => res.json(preferences.get()));
  app.get("/api/models/:cli", routeAction(async (req) => {
    const cli = cliSchema.safeParse(req.params.cli);
    if (!cli.success) throw new HttpError(400, "Unsupported CLI");
    const boundary = runnerModeSchema.optional().parse(req.query.runner);
    return { models: boundary ? await services.discover(cli.data, boundary) : await discover(cli.data) };
  }, {
    status: 409,
    // Discovery errors can carry CLI output; only setup messages written by the app are shown.
    expose: (error) => error instanceof SetupError,
    failed: "Model discovery failed. Check that this CLI is installed and signed in through the arena startup flow, then retry.",
  }));
  app.put(
    "/api/settings",
    express.json({ limit: "24kb" }),
    routeAction(async (req) => {
      const runner = runnerModeSchema.optional().safeParse(req.query.runner);
      if (!runner.success) throw new HttpError(400, "Invalid runner");
      const parsed = saveSettingsSchema.safeParse(req.body);
      if (!parsed.success)
        throw new HttpError(400, "Invalid settings. Check text lengths, timings and session choices.");
      const { revision, value, nativeConsent } = parsed.data;
      const old = preferences.get();
      if (revision !== old.revision)
        throw new Error(
          "Settings changed in another tab. Reload settings before saving.",
        );
      // A session that newly runs natively gets no Docker boundary, so the host confirms it each time.
      const newlyNative = value.sessions.some(
        (s) =>
          s.runner === "native" &&
          !old.value.sessions.some((o) => o.id === s.id && o.runner === "native"),
      );
      if (newlyNative && nativeConsent !== "NATIVE")
        throw new HttpError(
          400,
          "Type NATIVE to allow this harness to run on this computer without Docker isolation",
        );
      // Visibility/media-only saves never start a CLI discovery probe.
      if (
        JSON.stringify(value.sessions) !== JSON.stringify(old.value.sessions)
      ) {
        // A session with its own runner is checked on that runner, not the launch one.
        const groups = new Map<string, { cli: Agent; boundary?: RunnerMode }>();
        for (const s of value.sessions) {
          const boundary = s.runner ?? runner.data;
          groups.set(`${boundary ?? ""}:${s.cli}`, { cli: s.cli, boundary });
        }
        for (const [key, { cli, boundary }] of groups) {
          let models: CliModel[];
          try {
            models = boundary ? await services.discover(cli, boundary) : await discover(cli);
          } catch {
            throw new Error(
              "Could not verify installed models. Check CLI login and retry; no settings were saved.",
            );
          }
          for (const session of value.sessions.filter((s) => `${s.runner ?? runner.data ?? ""}:${s.cli}` === key))
            validateModel(session, models);
        }
      }
      // Each managed conversation owns its future model, independent of an arena slot or another conversation.
      for (const [id, selection] of Object.entries(value.managedModels ?? {})) {
        if (JSON.stringify(selection) === JSON.stringify(old.value.managedModels?.[id])) continue;
        const conversation = store.conversation(id);
        if (conversation?.source !== "managed" || !conversation.config) throw new Error("Managed session no longer exists");
        validateModel({ ...conversation.config, ...selection }, await services.discover(conversation.cli, conversation.runner));
      }
      for (const kind of ["audio", "visual"] as const) {
        const id = value.media[kind];
        if (id) {
          const asset = await media.path(id).catch(() => {
            throw new Error(
              "Selected media is missing or unsafe. Choose another file or the original fallback.",
            );
          });
          if (!asset.type.startsWith(kind === "audio" ? "audio/" : "image/"))
            throw new Error("Choose the correct media type");
        }
      }
      controller.assertSettingsChange(value);
      const saved = preferences.save(revision, value);
      controller.settingsChanged();
      return saved;
    }, { status: 409, failed: "Settings were not saved" }),
  );
  app.get("/api/history", (req, res) => {
    const before =
      req.query.before === undefined ? undefined : Number(req.query.before);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) {
      res.status(400).json({ error: "Invalid history cursor" });
      return;
    }
    const page = store.history(before);
    // Reuse the controller redactor before any historical text reaches the host browser.
    res.json(controller.safeHistory(page));
  });
  app.get("/api/break-media", routeAction(async () => ({
    files: await media.list(),
    defaults: {
      audio: {
        name: basename(services.defaults?.audio ?? "break.mp3"),
        url: "/media/break.mp3",
      },
      visual: {
        name: "break-visual.gif",
        url: "/media/break-visual.gif",
      },
    },
  }), { status: 409, expose: () => false, failed: "Media library unavailable. Check its directory permissions." }));
  // Reject a second upload before buffering its body in memory.
  let uploading = false;
  app.post(
    "/api/break-media",
    (req, res, next) => {
      if (uploading) {
        res.status(429).json({ error: "Another media upload is in progress" });
        return;
      }
      uploading = true;
      const done = () => {
        uploading = false;
      };
      res.once("finish", done);
      res.once("close", done);
      next();
    },
    express.raw({ type: "application/octet-stream", limit: "12mb" }),
    routeAction(async (req) => {
      if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Send a media file");
      let name = "";
      try {
        name = decodeURIComponent(
          String(req.headers["x-file-name"] ?? "").slice(0, 1000),
        );
      } catch {
        throw new HttpError(400, "Invalid filename");
      }
      return media.upload(req.body, name);
    }, {
      status: 400,
      // Only the library's own validation messages are shown; filesystem errors can name paths.
      expose: (error) => /^(Use |Invalid |Media |Maximum |Another |Unsafe )/.test(error.message),
      failed: "Upload failed. Check media storage permissions and available space.",
    }),
  );
  // Approved assets are available to the overlay; no runtime directory is a static root.
  app.get("/media/break/:id", async (req, res) => {
    try {
      const asset = await media.path(String(req.params.id));
      res.set({
        "Content-Type": asset.type,
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
      });
      res.sendFile(asset.path, (error) => {
        if (error && !res.headersSent) res.status(404).end();
      });
    } catch {
      res.status(404).end();
    }
  });
  const action = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("break"),
      durationMs: z.number().int().min(10000).max(3600000).nullable(),
      immediate: z.boolean(),
    }),
    z.object({
      action: z.literal("edit-prompt"),
      version: z.string().length(64),
      text: z.string().trim().min(10).max(600),
    }),
    z.object({ action: z.literal("stop-stream"), confirm: z.literal(true) }),
    z.object({ action: z.literal("end-break") }),
  ]);
  app.post(
    "/api/quick-action",
    express.json({ limit: "4kb" }),
    routeAction(async (req) => {
      const parsed = action.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, "Invalid action");
      const value = parsed.data;
      if (value.action === "break")
        await controller.manualBreak(value.durationMs, value.immediate);
      else if (value.action === "end-break")
        controller.endManualBreak();
      else if (value.action === "edit-prompt")
        controller.editPrepared(value.version, value.text);
      else await controller.stopStream();
      return { ok: true };
    }, { status: 409, failed: "Action failed; check OBS and runner status" }),
  );
}

import { basename } from "node:path";
import express from "express";
import { z } from "zod";
import type { Controller } from "./controller.js";
import type { Agent } from "../shared/types.js";
import type { QuickSettings } from "./quick-settings.js";
import { saveSettingsSchema } from "./quick-settings.js";
import { validateModel } from "./cli/index.js";
import type { CliModel } from "./cli/types.js";
import type { Store } from "./store.js";
import type { BreakMedia } from "./break-media.js";

export interface SettingsServices {
  preferences: QuickSettings;
  media: BreakMedia;
  store: Store;
  discover(cli: Agent, runner?: "docker" | "native"): Promise<CliModel[]>;
  defaults?: { audio: string; visual: string; visualUrl: string };
}
// Every host route authenticates before parsing a body or doing expensive discovery.
export function settingsRoutes(
  app: express.Express,
  controller: Controller,
  services: SettingsServices,
  authorized: (req: express.Request) => boolean,
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
    (req, res, next) => {
      if (!authorized(req)) {
        res
          .status(403)
          .json({ error: "Open the local control panel to use settings" });
        return;
      }
      next();
    },
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
  app.get("/api/models/:cli", async (req, res) => {
    const cli = z.enum(["codex", "cursor"]).safeParse(req.params.cli);
    if (!cli.success) {
      res.status(400).json({ error: "Unsupported CLI" });
      return;
    }
    try {
      const boundary = z.enum(["docker", "native"]).optional().parse(req.query.runner);
      res.json({ models: boundary ? await services.discover(cli.data, boundary) : await discover(cli.data) });
    } catch {
      res.status(409).json({
        error:
          "Model discovery failed. Check that this CLI is installed and signed in through the arena startup flow, then retry.",
      });
    }
  });
  app.put(
    "/api/settings",
    express.json({ limit: "24kb" }),
    async (req, res) => {
      const runner = z.enum(["docker", "native"]).optional().safeParse(req.query.runner);
      if (!runner.success) { res.status(400).json({ error: "Invalid runner" }); return; }
      const parsed = saveSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error:
            "Invalid settings. Check text lengths, timings and session choices.",
        });
        return;
      }
      try {
        const { revision, value } = parsed.data;
        const old = preferences.get();
        if (revision !== old.revision)
          throw new Error(
            "Settings changed in another tab. Reload settings before saving.",
          );
        // Visibility/media-only saves never start a CLI discovery probe.
        if (
          JSON.stringify(value.sessions) !== JSON.stringify(old.value.sessions)
        ) {
          for (const cli of new Set(value.sessions.map((s) => s.cli))) {
            let models: CliModel[];
            try {
              models = runner.data ? await services.discover(cli, runner.data) : await discover(cli);
            } catch {
              throw new Error(
                "Could not verify installed models. Check CLI login and retry; no settings were saved.",
              );
            }
            for (const session of value.sessions.filter((s) => s.cli === cli))
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
        res.json(saved);
      } catch (error) {
        res.status(409).json({
          error:
            error instanceof Error ? error.message : "Settings were not saved",
        });
      }
    },
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
  app.get("/api/break-media", async (_req, res) => {
    try {
      res.json({
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
      });
    } catch {
      res.status(409).json({
        error: "Media library unavailable. Check its directory permissions.",
      });
    }
  });
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
    async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: "Send a media file" });
        return;
      }
      try {
        let name = "";
        try {
          name = decodeURIComponent(
            String(req.headers["x-file-name"] ?? "").slice(0, 1000),
          );
        } catch {
          res.status(400).json({ error: "Invalid filename" });
          return;
        }
        res.json(await media.upload(req.body, name));
      } catch (error) {
        res.status(400).json({
          error:
            error instanceof Error &&
            /^(Use |Invalid |Media |Maximum |Another |Unsafe )/.test(
              error.message,
            )
              ? error.message
              : "Upload failed. Check media storage permissions and available space.",
        });
      }
    },
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
  ]);
  app.post(
    "/api/quick-action",
    express.json({ limit: "4kb" }),
    async (req, res) => {
      const parsed = action.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid action" });
        return;
      }
      try {
        const value = parsed.data;
        if (value.action === "break")
          await controller.manualBreak(value.durationMs, value.immediate);
        else if (value.action === "edit-prompt")
          controller.editPrepared(value.version, value.text);
        else await controller.stopStream();
        res.json({ ok: true });
      } catch (error) {
        res.status(409).json({
          error:
            error instanceof Error
              ? error.message
              : "Action failed; check OBS and runner status",
        });
      }
    },
  );
}

import express from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Controller } from "./controller.js";
import type { SettingsServices } from "./settings-http.js";
import type { PresentationControls } from "./presentation-controls.js";
import type { Sessions } from "./sessions/service.js";
import { validateModel } from "./cli/index.js";
import { preferencesSchema } from "./quick-settings.js";

// Rehearsal confirmations expire with relevant public choices, not harmless timing edits.
export function presentationRoutes(app: express.Express, controller: Controller, services: SettingsServices,
  presentation: PresentationControls, sessions: Sessions | undefined, authorized: (req: express.Request) => boolean) {
  const { store, preferences } = services;
  const confirmations = new Map<string, string>();
  const contextSchema = z.string().min(1).max(220);
  const key = (context: string) => {
    const value = preferences.get().value;
    const c = store.conversation(context);
    const p = presentation.get();
    return createHash("sha256").update(JSON.stringify([context,
      context === "arena" ? value.sessions : [c?.config, c?.model, c?.runner, value.managedModels?.[context]],
      context === "arena" ? value.visibility : value.visibility[context], value.media, p.goal, p.showGoal,
    ])).digest("hex");
  };
  app.use(["/api/rehearsal", "/api/last-setup"], (req, res, next) => {
    if (!authorized(req)) { res.status(403).json({ error: "Use local host controls" }); return; }
    next();
  });
  const respond = (operation: (req: express.Request) => unknown | Promise<unknown>) => async (req: express.Request, res: express.Response) => {
    try { res.json(await operation(req)); }
    catch (error) { res.status(409).json({ error: error instanceof z.ZodError ? "Invalid setup or rehearsal choices" : error instanceof Error ? error.message : "Request failed" }); }
  };
  app.get("/api/rehearsal", respond((req) => {
    const context = contextSchema.parse(req.query.context);
    return { key: key(context), confirmed: confirmations.get(context) === key(context), hidden: presentation.get().hidden };
  }));
  app.post("/api/rehearsal", express.json({ limit: "2kb" }), respond((req) => {
    const input = z.object({ context: contextSchema, key: z.string(), session: z.literal(true), readable: z.literal(true), visible: z.literal(true), audible: z.literal(true) }).strict().parse(req.body);
    if (input.key !== key(input.context)) throw new Error("Public choices changed. Review the rehearsal again.");
    if (presentation.get().hidden) throw new Error("Show the overlay explicitly before confirming its visibility.");
    confirmations.set(input.context, input.key);
    return { confirmed: true };
  }));
  const requireRehearsal = (context: string) => {
    if (confirmations.get(context) !== key(context)) throw new Error("Complete the short pre-live checklist for this session and current public choices first.");
  };
  // Last setup captures only applied preferences, never an unsaved browser draft.
  app.get("/api/last-setup", respond(() => ({ setup: store.lastSetup() })));
  app.post("/api/last-setup", express.json({ limit: "2kb" }), respond(async (req) => {
    const input = z.object({ path: z.enum(["existing", "new", "arena"]), sessionId: contextSchema.optional(), runner: z.enum(["docker", "native"]) }).strict().parse(req.body);
    const selected = input.sessionId ? await sessions?.view(input.sessionId) : undefined;
    const value = preferences.get().value;
    const setup = { ...input, runner: input.path === "arena" ? services.runner ?? "docker" : input.runner, session: selected ? { cli: selected.conversation.cli, model: selected.conversation.model, effort: selected.conversation.config?.effort, title: selected.conversation.title } : undefined, savedAt: Date.now(), sessions: value.sessions, visibility: value.visibility, stream: value.stream, managedModels: value.managedModels };
    store.saveLastSetup(setup);
    return { setup };
  }));
  app.post("/api/last-setup/apply", express.json({ limit: "1kb" }), respond(async (req) => {
    const input = z.object({ revision: z.number().int(), savedAt: z.number() }).strict().parse(req.body);
    const setup = store.lastSetup();
    if (!setup || setup.savedAt !== input.savedAt) throw new Error("Last setup changed. Review it again.");
    if (preferences.get().revision !== input.revision) throw new Error("Settings changed in another tab. Reload before applying.");
    // Read external history again; a missing/deleted session must not silently select another.
    const selected = setup.sessionId ? await sessions?.view(setup.sessionId) : undefined;
    const selectedConfig = selected?.conversation.config;
    if (!selected || selected.conversation.source === "managed") {
      const configs = selectedConfig ? [{ ...selectedConfig, ...setup.managedModels?.[setup.sessionId!] }] : setup.sessions;
      for (const config of configs) validateModel(config, await services.discover(config.cli, setup.runner));
    }
    const current = preferences.get();
    if (current.revision !== input.revision) throw new Error("Settings changed while checking models. Reload and retry.");
    const value = preferencesSchema.parse({ ...current.value, sessions: setup.sessions, visibility: setup.visibility, stream: setup.stream, managedModels: setup.managedModels });
    controller.assertSettingsChange(value);
    const document = preferences.save(input.revision, value);
    controller.settingsChanged();
    // Applying does not create/run a session, grant native consent, publish, or start OBS.
    return { setup, document, selected };
  }));
  return requireRehearsal;
}

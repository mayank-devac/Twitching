import express from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Controller } from "./controller.js";
import type { SettingsServices } from "./settings-http.js";
import type { PresentationControls } from "./presentation-controls.js";
import type { Sessions } from "./sessions/service.js";
import { validateModel } from "./cli/index.js";
import type { OverlayDefinition } from "../shared/sessions.js";
import { runnerModeSchema } from "../shared/schema.js";
import { preferencesSchema } from "./quick-settings.js";
import { routeAction, type HostOnly } from "./http-kit.js";

// Rehearsal confirmations expire with relevant public choices, not harmless timing edits.
export function presentationRoutes(
  app: express.Express,
  controller: Controller,
  services: SettingsServices,
  presentation: PresentationControls,
  sessions: Sessions | undefined,
  hostOnly: HostOnly,
) {
  const { store, preferences } = services;
  const confirmations = new Map<string, string>();
  const contextSchema = z.string().min(1).max(220);
  const key = (context: string, nextOverlay?: OverlayDefinition) => {
    const value = preferences.get().value;
    const c = store.conversation(context);
    const cli = c?.cli ?? (context.startsWith("codex:") ? "codex" : undefined);
    const outputs = store.overlays()?.overlays ?? [];
    const layouts = nextOverlay ? outputs.map((output) => output.id === nextOverlay.id ? nextOverlay : output) : outputs;
    return createHash("sha256")
      .update(
        JSON.stringify([
          context,
          context === "arena"
            ? value.sessions
            : [c?.config, c?.model, c?.runner, value.managedModels?.[context]],
          context === "arena"
            ? value.sessions.map((session) => value.visibility[session.id])
            : (value.visibility[context] ??
              value.visibility[
                c?.config?.id ??
                  value.sessions.find((s) => s.cli === cli)?.id ??
                  // preferencesSchema keeps at least one session.
                  value.sessions[0]!.id
              ]),
          context === "arena" ? undefined : layouts
            .filter((output) => output.selection === "follow-running" || output.sessionIds.includes(context))
            .map((output) => [output.id, output.selection, output.sessionIds]),
          context === "arena" ? services.runner : undefined,
          value.media,
          context === "arena"
            ? [presentation.get("default").goal, presentation.get("default").showGoal]
            : layouts.filter((output) => output.selection === "follow-running" || output.sessionIds.includes(context))
                .map((output) => { const p = presentation.get(output.id); return [output.id, presentation.selection(output.id).source, p.goal, p.showGoal]; }),
        ]),
      )
      .digest("hex");
  };
  app.use(["/api/rehearsal", "/api/last-setup"], hostOnly("Use local host controls"));
  const respond = (operation: (req: express.Request) => unknown) =>
    routeAction(operation, { status: 409, invalid: "Invalid setup or rehearsal choices", failed: "Request failed" });
  const hiddenFor = (context: string) => {
    if (context === "arena") return presentation.get("default").hidden;
    const outputs = sessions?.overlays.host().overlays.filter((output) => output.published && output.sessionIds.includes(context)) ?? [];
    return outputs.length ? outputs.every((output) => presentation.get(output.id).hidden) : presentation.get().hidden;
  };
  app.get(
    "/api/rehearsal",
    respond((req) => {
      const context = contextSchema.parse(req.query.context);
      return {
        key: key(context),
        confirmed: confirmations.get(context) === key(context),
        hidden: hiddenFor(context),
      };
    }),
  );
  app.post(
    "/api/rehearsal",
    express.json({ limit: "2kb" }),
    respond((req) => {
      const input = z
        .object({
          context: contextSchema,
          key: z.string(),
          session: z.literal(true),
          readable: z.literal(true),
          visible: z.literal(true),
          audible: z.literal(true),
        })
        .strict()
        .parse(req.body);
      if (input.key !== key(input.context))
        throw new Error("Public choices changed. Review the rehearsal again.");
      if (hiddenFor(input.context))
        throw new Error(
          "Show the overlay explicitly before confirming its visibility.",
        );
      if (confirmations.size >= 256 && !confirmations.has(input.context))
        confirmations.delete(confirmations.keys().next().value!);
      confirmations.set(input.context, input.key);
      return { confirmed: true };
    }),
  );
  const requireRehearsal = (context: string, nextOverlay?: OverlayDefinition) => {
    if (confirmations.get(context) !== key(context, nextOverlay))
      throw new Error(
        "Complete the short pre-live checklist for this session and current public choices first.",
      );
  };
  // Last setup captures only applied preferences, never an unsaved browser draft.
  app.get(
    "/api/last-setup",
    respond(() => ({ setup: store.lastSetup() })),
  );
  app.post(
    "/api/last-setup",
    express.json({ limit: "2kb" }),
    respond(async (req) => {
      const input = z
        .object({
          path: z.enum(["existing", "new", "arena"]),
          sessionId: contextSchema.optional(),
          runner: runnerModeSchema,
        })
        .strict()
        .parse(req.body);
      if (input.sessionId && !sessions) throw new Error("Session browser is unavailable; choose a setup without a saved session.");
      const selected = input.sessionId
        ? await sessions?.view(input.sessionId)
        : undefined;
      const value = preferences.get().value;
      const ids = new Set([...value.sessions.map((session) => session.id), ...(input.sessionId ? [input.sessionId] : [])]);
      const model = input.sessionId ? value.managedModels?.[input.sessionId] : undefined;
      const setup = {
        ...input,
        runner:
          input.path === "arena" ? (services.runner ?? "docker") : input.runner,
        session: selected
          ? {
              cli: selected.conversation.cli,
              model: model?.model ?? selected.conversation.model,
              effort: model?.effort ?? selected.conversation.config?.effort,
              title: selected.conversation.title,
            }
          : undefined,
        savedAt: Date.now(),
        sessions: value.sessions,
        visibility: Object.fromEntries(Object.entries(value.visibility).filter(([id]) => ids.has(id))),
        stream: value.stream,
        managedModels: input.sessionId && model ? { [input.sessionId]: model } : undefined,
      };
      store.saveLastSetup(setup);
      return { setup };
    }),
  );
  app.post(
    "/api/last-setup/apply",
    express.json({ limit: "1kb" }),
    respond(async (req) => {
      const input = z
        .object({ revision: z.number().int(), savedAt: z.number() })
        .strict()
        .parse(req.body);
      const setup = store.lastSetup();
      if (!setup || setup.savedAt !== input.savedAt)
        throw new Error("Last setup changed. Review it again.");
      if (setup.sessionId && !sessions) throw new Error("Saved session is unavailable; choose another session manually.");
      if (preferences.get().revision !== input.revision)
        throw new Error(
          "Settings changed in another tab. Reload before applying.",
        );
      // Read external history again; a missing/deleted session must not silently select another.
      const selected = setup.sessionId
        ? await sessions?.view(setup.sessionId)
        : undefined;
      const selectedConfig = selected?.conversation.config;
      const configs = [
        ...setup.sessions,
        ...(selectedConfig
          ? [{ ...selectedConfig, ...setup.managedModels?.[setup.sessionId!] }]
          : []),
      ];
      const catalogs = new Map<
        string,
        Awaited<ReturnType<typeof services.discover>>
      >();
      for (const config of configs) {
        let models = catalogs.get(config.cli);
        if (!models) {
          models = await services.discover(config.cli, setup.runner);
          catalogs.set(config.cli, models);
        }
        validateModel(config, models);
      }
      const current = preferences.get();
      if (current.revision !== input.revision)
        throw new Error(
          "Settings changed while checking models. Reload and retry.",
        );
      const value = preferencesSchema.parse({
        ...current.value,
        sessions: setup.sessions,
        visibility: { ...current.value.visibility, ...setup.visibility },
        stream: setup.stream,
        managedModels: { ...current.value.managedModels, ...setup.managedModels },
      });
      controller.assertSettingsChange(value);
      const document = preferences.save(input.revision, value);
      controller.settingsChanged();
      // Applying does not create/run a session, grant native consent, publish, or start OBS.
      return { setup, document, selected };
    }),
  );
  return requireRehearsal;
}

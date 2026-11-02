import { z } from "zod";
import type { QuickPreferences, SettingsDocument } from "../shared/settings.js";
import { defaultVisibility } from "../shared/settings.js";
import { validSessionId } from "../shared/types.js";
import { sessionConfigSchema, sessionListSchema, streamModeSchema } from "../shared/schema.js";
import type { Store } from "./store.js";

// Strict schemas prevent an operator request from becoming arbitrary configuration.
const visibility = z
  .object(
    Object.fromEntries(
      Object.keys(defaultVisibility).map((k) => [k, z.boolean()]),
    ) as Record<keyof typeof defaultVisibility, z.ZodBoolean>,
  )
  // Settings saved before the effort and web toggles existed have no key. Web
  // stays on; effort follows the model toggle, so a streamer who hid the
  // model does not start showing its effort.
  .extend({
    hidePreviousRuns: z.boolean().optional(),
    effort: z.boolean().optional(),
    web: z.boolean().default(true),
  })
  .strict()
  .transform((value) => ({ ...value, effort: value.effort ?? value.model }));
const duration = z.number().int().min(1000).max(3_600_000);
export const preferencesSchema = z
  .object({
    managedModels: z
      .record(
        z.string().regex(/^managed:[a-zA-Z0-9_-]+$/),
        z
          .object({
            model: z.string().trim().min(1).max(160),
            effort: z.string().trim().min(1).max(40).optional(),
          })
          .strict(),
      )
      .optional(),
    sessions: sessionListSchema(sessionConfigSchema),
    visibility: z.record(
      z
        .string()
        .max(220)
        .refine(
          (id) =>
            validSessionId(id) || /^(managed|codex|claude):[a-zA-Z0-9_-]+$/.test(id),
        ),
      visibility,
    ),
    stream: z
      .object({
        mode: streamModeSchema,
        youtube: z.boolean(),
        twitch: z.boolean(),
        kick: z.boolean(),
        collectionMs: duration,
        extensionMs: duration,
        resultMs: duration,
      })
      .strict(),
    jevCriteria: z.string().trim().min(10).max(4000),
    jevProbe: z.string().trim().min(10).max(700),
    // Rows saved before this toggle existed read as off.
    directPreview: z.boolean().default(false),
    media: z
      .object({
        audio: z
          .string()
          .regex(/^[a-f0-9]{32}\.(mp3|wav|ogg)$/)
          .optional(),
        visual: z
          .string()
          .regex(/^[a-f0-9]{32}\.(png|jpg|gif|webp)$/)
          .optional(),
        // Older saved preference rows default to Fit until the next normal save.
        visualFit: z.enum(["fit", "center", "fill"]).default("fit"),
      })
      .strict(),
  })
  .strict();
export const saveSettingsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    value: preferencesSchema,
    // Typed by the host whenever a save newly runs a session natively.
    nativeConsent: z.literal("NATIVE").optional(),
  })
  .strict();
export const defaultCriteria =
  "Prefer clear, creative, visually striking ideas with small scope and an observable interaction. Prefer the higher weighted score unless another idea is clearly more suitable.";

// SQLite compare-and-swap makes two host tabs conflict visibly instead of losing edits.
export class QuickSettings {
  private document: SettingsDocument;
  // JSON of the sessions last written to (or read from) the database. Startup flags
  // change the in-memory sessions only, so a difference means "not saved as default yet".
  private persistedSessions: string;
  constructor(
    private store: Store,
    defaults: QuickPreferences,
    startup: {
      mode?: QuickPreferences["stream"]["mode"];
      sessions?: QuickPreferences["sessions"];
      directPreview?: boolean;
      platforms?: Pick<
        QuickPreferences["stream"],
        "youtube" | "twitch" | "kick"
      >;
    } = {},
  ) {
    const saved = store.quickSettings();
    this.document = saved
      ? {
          revision: saved.revision,
          value: preferencesSchema.parse(saved.value),
        }
      : { revision: 0, value: defaults };
    // Revision zero still represents untouched defaults; revise only those, preserving saved choices.
    if (saved?.revision === 0) {
      for (const value of Object.values(this.document.value.visibility)) {
        value.read = true;
        value.edit = false;
        value.summary = false;
      }
      this.store.saveQuickSettings(this.document);
    }
    // On a fresh database, explicit startup sessions count as unsaved too.
    this.persistedSessions =
      saved || !startup.sessions ? JSON.stringify(this.document.value.sessions) : "";
    // Explicit guided-startup choices beat previous web choices for this process.
    if (startup.mode) this.document.value.stream.mode = startup.mode;
    if (startup.sessions)
      this.document.value.sessions = structuredClone(startup.sessions);
    if (startup.directPreview !== undefined)
      this.document.value.directPreview = startup.directPreview;
    if (startup.platforms)
      Object.assign(this.document.value.stream, startup.platforms);
  }
  get() {
    return structuredClone(this.document);
  }
  // True when the sessions in use (CLI, model, effort, runner) are not what the database holds.
  sessionsUnsaved() {
    return JSON.stringify(this.document.value.sessions) !== this.persistedSessions;
  }
  // Writes the current document as is, so the sessions in use become the saved default arena.
  saveCurrent() {
    return this.save(this.document.revision, this.document.value);
  }
  save(revision: number, value: QuickPreferences) {
    if (revision !== this.document.revision)
      throw new Error(
        "Settings changed in another tab. Reload settings before saving.",
      );
    const next = {
      revision: revision + 1,
      value: preferencesSchema.parse(value),
    };
    this.store.saveQuickSettings(next);
    this.document = next;
    this.persistedSessions = JSON.stringify(next.value.sessions);
    return this.get();
  }
}

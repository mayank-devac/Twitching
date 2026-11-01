import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import {
  configuredSessions,
  validSessionId,
  SESSION_IDS,
  type SessionConfig,
} from "../shared/types.js";
import { DEFAULT_PROMPT_FILE } from "./prompt-playlist.js";
export const startupSchema = z.object({
  experience: z.enum(["welcome", "session", "arena"]).default("welcome"),
  // The control server holds credentials and native-run controls; it must
  // never listen beyond this machine.
  host: z.enum(["127.0.0.1", "::1", "localhost"], {
    error: "host must be a loopback address: 127.0.0.1, ::1 or localhost",
  }),
  port: z.number().int().min(1024).max(65535),
  previewPort: z.number().int().min(1024).max(65535),
  webhookPort: z.number().int().min(1024).max(65535),
  collectionMs: z.number().positive(),
  extensionMs: z.number().positive(),
  resultMs: z.number().positive(),
  reconnectLimitMs: z.number().positive().default(900_000),
  quotaGraceMs: z.number().positive(),
  quotaPollMs: z.number().min(10000),
  codexModel: z.string().trim().min(1),
  codexEffort: z.string().trim().min(1).default("high"),
  cursorModel: z.string().trim().min(1),
  agentImage: z.string().regex(/^[\w./:-]+$/),
  previewImage: z.string().regex(/^[\w./:-]+$/),
  browserPort: z.number().int().min(1024).max(65535),
  mode: z.enum(["live", "rehearsal"]),
  previewView: z.enum(["jpeg", "live"]).default("live"),
  runnerMode: z.enum(["docker", "native"]).default("docker"),
  sessions: z
    .array(
      z.object({
        id: z.string().refine(validSessionId, `Use ${SESSION_IDS.join(", ")}`),
        cli: z.enum(["codex", "cursor"]),
        model: z.string().trim().min(1),
        effort: z.string().trim().min(1).optional(),
      }),
    )
    .min(1)
    .max(2)
    .refine(
      (sessions) => new Set(sessions.map((s) => s.id)).size === sessions.length,
      "Session IDs must be unique",
    )
    .optional(),
  singleAgent: z.enum(["codex", "cursor"]).optional(),
  safetyThreshold: z.number().min(0).max(1),
  relevanceThreshold: z.number().min(0).max(1),
  minScore: z.number().min(0).max(100),
  jevProbe: z.string().min(10),
  blockedWords: z.array(z.string()),
  musicPath: z.string(),
  visualPath: z.string(),
  obsUrl: z.string().url(),
  stopObsOnEnd: z.boolean(),
  kickWebhookUrl: z.string(),
  kickListenHost: z.enum(["127.0.0.1", "0.0.0.0"]),
  skipYoutube: z.boolean().default(true),
  skipTwitch: z.boolean().default(true),
  skipKick: z.boolean().default(true),
  promptFile: z.string().min(1).default(DEFAULT_PROMPT_FILE),
  promptPlaylist: z.boolean().default(false),
});
export type StartupSettings = z.infer<typeof startupSchema>;
export function normalizeStartup(
  settings: unknown,
  root: string,
): StartupSettings {
  const value = startupSchema.parse(settings);
  value.sessions = startupSchema.shape.sessions.parse(
    configuredSessions(value),
  );
  for (const key of ["musicPath", "visualPath"] as const)
    value[key] = resolve(root, value[key]);
  if (
    new Set([
      value.port,
      value.previewPort,
      value.webhookPort,
      value.browserPort,
    ]).size !== 4
  )
    throw new Error("Use four different ports");
  return value;
}
export function resolveStartup(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  root: string,
  promptPlaylist: boolean,
): StartupSettings {
  return normalizeStartup(
    {
      ...raw,
      ...(env.ARENA_EXPERIENCE ? { experience: env.ARENA_EXPERIENCE } : {}),
      ...(env.ARENA_MODE ? { mode: env.ARENA_MODE } : {}),
      ...(env.ARENA_RUNNER ? { runnerMode: env.ARENA_RUNNER } : {}),
      singleAgent: env.ARENA_SINGLE_AGENT || raw.singleAgent,
      sessions: env.ARENA_SESSIONS
        ? JSON.parse(env.ARENA_SESSIONS)
        : env.ARENA_SINGLE_AGENT
          ? undefined
          : raw.sessions,
      // Chat collection is opt-in; explicit startup flags and saved file choices still win.
      skipYoutube:
        promptPlaylist ||
        (env.ARENA_SKIP_YOUTUBE === undefined
          ? (raw.skipYoutube ?? true)
          : env.ARENA_SKIP_YOUTUBE !== "0"),
      skipTwitch:
        promptPlaylist ||
        (env.ARENA_SKIP_TWITCH === undefined
          ? (raw.skipTwitch ?? true)
          : env.ARENA_SKIP_TWITCH !== "0"),
      skipKick:
        promptPlaylist ||
        (env.ARENA_SKIP_KICK === undefined
          ? (raw.skipKick ?? true)
          : env.ARENA_SKIP_KICK !== "0"),
      promptPlaylist,
    },
    root,
  );
}
export function selectStartupSessions(
  settings: StartupSettings,
  sessions: SessionConfig[],
  root: string,
) {
  return normalizeStartup({ ...settings, sessions }, root);
}
// Identifies immutable startup inputs, before saved web preferences are applied.
export function startupConfigurationId(settings: StartupSettings) {
  return createHash("sha256")
    .update(JSON.stringify(startupSchema.parse(settings)))
    .digest("hex");
}

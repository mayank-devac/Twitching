import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { configuredSessions, type SessionConfig } from "../shared/types.js";
import {
  cliSchema,
  runnerModeSchema,
  sessionIdSchema,
  sessionListSchema,
  streamModeSchema,
} from "../shared/schema.js";
import { DEFAULT_PROMPT_FILE } from "./prompt-playlist.js";
import { CHAT_PLATFORMS, type ChatPlatform } from "../shared/settings.js";
import { skipRecord, skipEnvKey } from "./chat-skips.js";
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
  claudeModel: z.string().trim().min(1).default("sonnet"),
  claudeEffort: z.string().trim().min(1).default("high"),
  agentImage: z.string().regex(/^[\w./:-]+$/),
  previewImage: z.string().regex(/^[\w./:-]+$/),
  browserPort: z.number().int().min(1024).max(65535),
  mode: streamModeSchema,
  previewView: z.enum(["jpeg", "live"]).default("live"),
  runnerMode: runnerModeSchema.default("docker"),
  // Operator-authored settings: not strict and without the saved-settings length caps.
  sessions: sessionListSchema(
    z.object({
      id: sessionIdSchema,
      cli: cliSchema,
      model: z.string().trim().min(1),
      effort: z.string().trim().min(1).optional(),
    }),
  ).optional(),
  singleAgent: cliSchema.optional(),
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
  // Chat collection is opt-in: one record holds every platform's skip state.
  skips: z
    .record(z.enum(CHAT_PLATFORMS), z.boolean())
    .default(skipRecord(true)),
  promptFile: z.string().min(1).default(DEFAULT_PROMPT_FILE),
  promptPlaylist: z.boolean().default(false),
  // Process-lifetime opt-in (ARENA_NATIVE_LIVE_CHAT), never read from settings.json:
  // lets viewer chat prompts run on the native runner as the host user.
  allowNativeLiveChat: z.boolean().default(false),
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
      skips: startupSkips(raw, env, promptPlaylist),
      promptPlaylist,
      allowNativeLiveChat: env.ARENA_NATIVE_LIVE_CHAT === "1",
    },
    root,
  );
}

// Chat collection is opt-in: env overrides, then saved file choices — the new skips
// record wins over the legacy per-platform keys. Everything defaults to skipped.
function startupSkips(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  forceSkip: boolean,
): Record<ChatPlatform, boolean> {
  const legacy: Record<ChatPlatform, string> = {
    youtube: "skipYoutube",
    twitch: "skipTwitch",
    kick: "skipKick",
  };
  const skips = skipRecord(true);
  for (const platform of CHAT_PLATFORMS) {
    const envValue = env[skipEnvKey(platform)];
    const stored = raw[legacy[platform]];
    if (envValue !== undefined) skips[platform] = envValue !== "0";
    else if (
      typeof raw.skips === "object" &&
      raw.skips !== null &&
      typeof (raw.skips as Record<string, unknown>)[platform] === "boolean"
    )
      skips[platform] = (raw.skips as Record<string, unknown>)[platform] as boolean;
    else if (typeof stored === "boolean") skips[platform] = stored;
  }
  if (forceSkip) return skipRecord(true);
  return skips;
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

import { readFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import {
  DEFAULT_PROMPT_FILE,
  loadPromptList,
  promptPlaylistEnabled,
} from "./prompt-playlist.js";
const schema = z.object({
  host: z.string().regex(/^[\w.-]+$/),
  port: z.number().int().min(1024).max(65535),
  previewPort: z.number().int().min(1024).max(65535),
  webhookPort: z.number().int().min(1024).max(65535),
  collectionMs: z.number().positive(),
  extensionMs: z.number().positive(),
  resultMs: z.number().positive(),
  reconnectLimitMs: z.number().positive().default(900_000),
  quotaGraceMs: z.number().positive(),
  quotaPollMs: z.number().min(10000),
  codexModel: z.string().min(1),
  codexEffort: z.enum(["minimal", "low", "medium", "high"]).default("high"),
  cursorModel: z.string().min(1),
  agentImage: z.string().regex(/^[\w./:-]+$/),
  previewImage: z.string().regex(/^[\w./:-]+$/),
  browserPort: z.number().int().min(1024).max(65535),
  mode: z.enum(["live", "rehearsal"]),
  previewView: z.enum(["jpeg", "live"]).default("live"),
  runnerMode: z.enum(["docker", "native"]).default("docker"),
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
  skipYoutube: z.boolean().default(false),
  skipTwitch: z.boolean().default(false),
  skipKick: z.boolean().default(false),
  promptFile: z.string().min(1).default(DEFAULT_PROMPT_FILE),
  promptPlaylist: z.boolean().default(false),
});
export const root = process.cwd();
const raw = JSON.parse(
  readFileSync(resolve(root, "settings.json"), "utf8"),
) as Record<string, unknown>;
const promptFile =
  typeof raw.promptFile === "string" && raw.promptFile.trim()
    ? raw.promptFile.trim()
    : DEFAULT_PROMPT_FILE;
export const housePrompts = loadPromptList(resolve(root, promptFile));
const promptPlaylist = promptPlaylistEnabled(housePrompts);
export const settings = schema.parse({
  ...raw,
  ...(process.env.ARENA_MODE ? { mode: process.env.ARENA_MODE } : {}),
  ...(process.env.ARENA_RUNNER ? { runnerMode: process.env.ARENA_RUNNER } : {}),
  singleAgent: process.env.ARENA_SINGLE_AGENT || undefined,
  skipYoutube: process.env.ARENA_SKIP_YOUTUBE === "1" || promptPlaylist,
  skipTwitch: process.env.ARENA_SKIP_TWITCH === "1" || promptPlaylist,
  skipKick: process.env.ARENA_SKIP_KICK === "1" || promptPlaylist,
  promptFile,
  promptPlaylist,
});
if (
  new Set([
    settings.port,
    settings.previewPort,
    settings.webhookPort,
    settings.browserPort,
  ]).size !== 4
)
  throw new Error("Use four different ports");
// Relative media paths resolve against the project root; absolute paths pass through.
for (const key of ["musicPath", "visualPath"] as const)
  settings[key] = resolve(root, settings[key]);
// Only the controller reads credentials, at runtime. Never return this object in an API response.
try {
  chmodSync(resolve(root, ".env.local"), 0o600);
} catch {
  /* A missing file is reported by preflight. */
}
dotenv.config({ path: resolve(root, ".env.local"), quiet: true });
export const secrets = {
  jev: process.env.TYPESAFE_API_KEY ?? "",
  youtube: {
    access: process.env.YOUTUBE_ACCESS_TOKEN ?? "",
    refresh: process.env.YOUTUBE_REFRESH_TOKEN ?? "",
    client: process.env.YOUTUBE_CLIENT_ID ?? "",
    secret: process.env.YOUTUBE_CLIENT_SECRET ?? "",
    chat: process.env.YOUTUBE_LIVE_CHAT_ID ?? "",
  },
  twitch: {
    access: process.env.TWITCH_ACCESS_TOKEN ?? "",
    refresh: process.env.TWITCH_REFRESH_TOKEN ?? "",
    client: process.env.TWITCH_CLIENT_ID ?? "",
    secret: process.env.TWITCH_CLIENT_SECRET ?? "",
    broadcaster: process.env.TWITCH_BROADCASTER_ID ?? "",
    user: process.env.TWITCH_BOT_USER_ID ?? "",
  },
  kick: {
    access: process.env.KICK_ACCESS_TOKEN ?? "",
    broadcaster: process.env.KICK_BROADCASTER_ID ?? "",
  },
  obs: process.env.OBS_PASSWORD ?? "",
};

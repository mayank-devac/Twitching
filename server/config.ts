import { resolveStartup } from "./startup-config.js";
import { readFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import {
  DEFAULT_PROMPT_FILE,
  loadPromptList,
  promptPlaylistEnabled,
} from "./prompt-playlist.js";
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
export const settings = resolveStartup({ ...raw, promptFile }, process.env, root, promptPlaylist);
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

import { CHAT_PLATFORMS, type ChatPlatform } from "../shared/settings.js";

// The short name each platform is documented with in --skip.
export const skipFlags: Record<ChatPlatform, string> = {
  youtube: "yt",
  twitch: "twitch",
  kick: "kick",
};
// --skip accepts the documented short name or the full platform name.
export function parseSkipPlatform(value: string): ChatPlatform {
  const name = value.trim().toLowerCase();
  const platform = CHAT_PLATFORMS.find(
    (known) => known === name || skipFlags[known] === name,
  );
  if (platform) return platform;
  throw new Error(
    `Unknown --skip target "${value}". Use --skip yt, --skip twitch, or --skip kick.`,
  );
}

// The launcher passes each skip as ARENA_SKIP_<PLATFORM>=1.
export const skipEnvKey = (platform: ChatPlatform) =>
  `ARENA_SKIP_${platform.toUpperCase()}`;

export function chatSkips(
  env: NodeJS.ProcessEnv = process.env,
): Record<ChatPlatform, boolean> {
  return Object.fromEntries(
    CHAT_PLATFORMS.map((platform) => [platform, env[skipEnvKey(platform)] === "1"]),
  ) as Record<ChatPlatform, boolean>;
}

// One skip state per platform; the launcher and the startup settings both store this shape.
export function skipRecord(skip = true): Record<ChatPlatform, boolean> {
  return Object.fromEntries(
    CHAT_PLATFORMS.map((platform) => [platform, skip]),
  ) as Record<ChatPlatform, boolean>;
}

// The env entries a skip record turns into, so child processes inherit chat skips.
export const skipEnvRecord = (skips: Record<ChatPlatform, boolean>) =>
  Object.fromEntries(
    CHAT_PLATFORMS.map((platform) => [
      skipEnvKey(platform),
      skips[platform] ? "1" : "0",
    ]),
  );

// The enable flags web preferences express: the opposite of every skip.
export const enabledFromSkips = (skips: Record<ChatPlatform, boolean>) =>
  Object.fromEntries(
    CHAT_PLATFORMS.map((platform) => [platform, !skips[platform]]),
  ) as Record<ChatPlatform, boolean>;

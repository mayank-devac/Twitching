export function parseSkipPlatform(value: string) {
  switch (value.trim().toLowerCase()) {
    case "yt":
    case "youtube":
      return "youtube" as const;
    case "twitch":
      return "twitch" as const;
    case "kick":
      return "kick" as const;
    default:
      throw new Error(
        `Unknown --skip target "${value}". Use --skip yt, --skip twitch, or --skip kick.`,
      );
  }
}

export function chatSkips(env: NodeJS.ProcessEnv = process.env) {
  return {
    youtube: env.ARENA_SKIP_YOUTUBE === "1",
    twitch: env.ARENA_SKIP_TWITCH === "1",
    kick: env.ARENA_SKIP_KICK === "1",
  };
}

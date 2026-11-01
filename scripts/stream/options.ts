// Owns the guided launcher's command line: help text, flag parsing and the env it hands the server.
import { parseSessionSpec } from "../session-selection.js";
import { parseSkipPlatform } from "../../server/chat-skips.js";
import type { SessionConfig } from "../../shared/types.js";

export const help = `Prompt Arena guided startup

  ./check_stream_start.sh [--cli codex|cursor] [--mode live|rehearsal] [--runner docker|native] [--verify] [--non-interactive] [--chat yt|twitch|kick] [--skip yt|twitch|kick] [--prompts] [--no-prompts]
  ./start_stream.sh       [--cli codex|cursor] [--mode live|rehearsal] [--runner docker|native] [--verify] [--chat yt|twitch|kick] [--skip yt|twitch|kick] [--prompts] [--no-prompts]

Check defaults to live readiness. Start offers rehearsal/live and Docker/native choices.
Chat starts off. Repeat --chat for each platform you want, or enable it in Quick Settings.
--session cli:model[:effort] selects a session; repeat once for two sessions (including Codex + Codex).
Interactive start also offers session/model selection from installed CLIs.
--codex / --cursor (or --cli codex|cursor) runs one CLI in a full-width panel. The other CLI is not checked or launched.
--skip yt, --skip twitch and --skip kick omit those chat connections in live mode. Repeat --skip for each.
--prompts runs tasks from prompts.txt (or settings.promptFile) for the selected CLIs, then ends the show. OBS only; chat is skipped.
If that file already has tasks, prompt-list mode is used unless you pass --no-prompts.
--verify explicitly runs type checks, tests, fixture replay, build and (Docker mode) isolation tests.
Without --verify, checks use saved CLI logins/models/quota and a temporary isolated preview.
Check never starts a broadcast or coding round. Native agents still require Docker previews.
Public starts require terminal confirmation. No credentials are requested or printed in this terminal.
`;

export type StreamCommand = "check" | "start";
export interface StreamOptions {
  command: StreamCommand;
  mode?: "live" | "rehearsal";
  runnerMode?: "docker" | "native";
  verify: boolean;
  interactive: boolean;
  skipYoutube: boolean;
  skipTwitch: boolean;
  skipKick: boolean;
  forcePrompts: boolean;
  ignorePrompts: boolean;
  singleAgent?: "codex" | "cursor";
  requestedSessions: SessionConfig[];
}

// Usage errors exit 2 (help exits 0) before any prompt, check or child process starts.
export function parseStreamOptions(
  command: string | undefined,
  args: string[],
): StreamOptions {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(help);
    process.exit(0);
  }
  if (command !== "check" && command !== "start") {
    console.error(help);
    process.exit(2);
  }
  const options: StreamOptions = {
    command,
    verify: false,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    // Chat collection starts unchecked; each platform is an explicit opt-in.
    skipYoutube: true,
    skipTwitch: true,
    skipKick: true,
    forcePrompts: false,
    ignorePrompts: false,
    requestedSessions: [],
  };
  const setSkip = (value: string, skip: boolean) => {
    const platform = parseSkipPlatform(value);
    if (platform === "youtube") options.skipYoutube = skip;
    else if (platform === "twitch") options.skipTwitch = skip;
    else options.skipKick = skip;
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--verify") options.verify = true;
    else if (args[i] === "--session") {
      try {
        options.requestedSessions.push(
          parseSessionSpec(args[++i] ?? "", options.requestedSessions.length),
        );
      } catch (error) {
        console.error(
          `ERROR: ${error instanceof Error ? error.message : "Invalid session"}`,
        );
        process.exit(2);
      }
    } else if (["--codex", "--cursor", "--cli"].includes(args[i])) {
      const agent = args[i] === "--cli" ? args[++i] : args[i].slice(2);
      if (
        (agent !== "codex" && agent !== "cursor") ||
        (options.singleAgent && options.singleAgent !== agent)
      ) {
        console.error(
          `ERROR: Choose one CLI: --codex, --cursor, or --cli codex|cursor.\n${help}`,
        );
        process.exit(2);
      }
      options.singleAgent = agent;
    } else if (args[i] === "--non-interactive") options.interactive = false;
    else if (args[i] === "--mode" && ["live", "rehearsal"].includes(args[i + 1]))
      options.mode = args[++i] as StreamOptions["mode"];
    else if (args[i] === "--runner" && ["docker", "native"].includes(args[i + 1]))
      options.runnerMode = args[++i] as StreamOptions["runnerMode"];
    else if (args[i] === "--prompts") options.forcePrompts = true;
    else if (args[i] === "--no-prompts") options.ignorePrompts = true;
    else if (args[i] === "--chat" && args[i + 1]) {
      try {
        setSkip(args[++i], false);
      } catch (error) {
        console.error(
          `ERROR: ${error instanceof Error ? error.message : "Invalid --chat"}`,
        );
        process.exit(2);
      }
    } else if (args[i] === "--skip" && args[i + 1]) {
      try {
        setSkip(args[++i], true);
      } catch (error) {
        console.error(
          `ERROR: ${error instanceof Error ? error.message : "Invalid --skip"}\n${help}`,
        );
        process.exit(2);
      }
    } else {
      console.error(`ERROR: Invalid option or value.\n${help}`);
      process.exit(2);
    }
  }
  if (options.singleAgent && options.requestedSessions.length) {
    console.error("ERROR: Use --session or --cli, not both.");
    process.exit(2);
  }
  if (options.singleAgent) delete process.env.ARENA_SESSIONS;
  if (options.requestedSessions.length)
    process.env.ARENA_SESSIONS = JSON.stringify(options.requestedSessions);
  if (options.forcePrompts && options.ignorePrompts) {
    console.error(
      "ERROR: Use either --prompts or --no-prompts, not both.\n" + help,
    );
    process.exit(2);
  }
  if (options.forcePrompts) process.env.ARENA_PROMPTS = "1";
  if (options.ignorePrompts) process.env.ARENA_NO_PROMPTS = "1";
  process.env.ARENA_SINGLE_AGENT = options.singleAgent ?? "";
  return options;
}

// The server reads chat skips from env, so they follow every change to the flags.
export function exportChatSkips(options: StreamOptions) {
  process.env.ARENA_SKIP_YOUTUBE = options.skipYoutube ? "1" : "0";
  process.env.ARENA_SKIP_TWITCH = options.skipTwitch ? "1" : "0";
  process.env.ARENA_SKIP_KICK = options.skipKick ? "1" : "0";
}

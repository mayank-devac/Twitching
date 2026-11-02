// Owns the guided launcher's command line: help text, flag parsing and the env it hands the server.
import { RUNNER_MODES } from "../../shared/schema.js";
import { parseSessionSpec } from "../session-selection.js";
import { parseSkipPlatform, skipRecord, skipEnvRecord } from "../../server/chat-skips.js";
import { type ChatPlatform } from "../../shared/settings.js";
import { CLIS, isCli, type Agent, type RunnerMode, type SessionConfig } from "../../shared/types.js";

export const help = `Prompt Arena guided startup

  ./check_stream_start.sh [--cli codex|cursor|claude] [--mode live|rehearsal] [--runner docker|native] [--direct-preview] [--verify] [--non-interactive] [--chat yt|twitch|kick] [--skip yt|twitch|kick] [--prompts] [--no-prompts]
  ./start_stream.sh       [--cli codex|cursor|claude] [--mode live|rehearsal] [--runner docker|native] [--direct-preview] [--verify] [--chat yt|twitch|kick] [--skip yt|twitch|kick] [--prompts] [--no-prompts] [--chats]

--chats turns on the chat history feed (/chat and /chats/prompts OBS pages). It is off by default.
Check defaults to live readiness. Start offers rehearsal/live and Docker/native choices.
Chat starts off. Repeat --chat for each platform you want, or enable it in Quick Settings.
--session cli:model[:effort] selects a session; repeat once for two sessions (including Codex + Codex).
--<cli>-<model>[:effort] is a shorthand for --session, e.g. --codex-6-luna vs --codex-terra (the word "vs" is optional).
Names are matched against the CLI's model list; an unclear name lists the choices. Without any session flag, the sessions saved in Quick Settings are kept.
Send more prompts to the running app with: ./start_stream.sh send ["prompt" ...]  (no text = re-read prompts.txt; --check only lists them).
Interactive start also offers session/model selection from installed CLIs.
--codex / --cursor / --claude (or --cli codex|cursor|claude) runs one CLI in a full-width panel. The other CLIs are not checked or launched.
--skip yt, --skip twitch and --skip kick omit those chat connections in live mode. Repeat --skip for each.
--prompts runs tasks from prompts.txt (or settings.promptFile) for the selected CLIs, then ends the show. OBS only; chat is skipped.
Without --prompts nothing in the file runs by itself. Use the Send prompts button in the arena controls, or the send command below.
Native mode defaults to host prompts only; live chat is disabled unless explicitly enabled with --allow-native-chat (viewer prompts then run with your local-user permissions).
--verify explicitly runs type checks, tests, fixture replay, build and (Docker mode) isolation tests.
Without --verify, checks use saved CLI logins/models/quota and a temporary isolated preview.
Check never starts a broadcast or coding round. Native agents use Docker previews unless direct preview is on.
--direct-preview (native runner only) shows generated pages straight in the browser with no Docker. Pages are not isolated, and a heavy page is reloaded or paused. When Docker is not running, an interactive start offers this instead. It is also a toggle in Quick Settings.
Public starts require terminal confirmation. No credentials are requested or printed in this terminal.
`;

export interface StreamOptions {
  command: "check" | "start";
  mode?: "live" | "rehearsal";
  runnerMode?: RunnerMode;
  verify: boolean;
  interactive: boolean;
  skips: Record<ChatPlatform, boolean>;
  forcePrompts: boolean;
  ignorePrompts: boolean;
  // Explicit opt-in for viewer chat on the native runner; off unless --allow-native-chat.
  allowNativeChat: boolean;
  // Native runner only: skip the Docker preview browser and show pages straight in the browser.
  directPreview: boolean;
  singleAgent?: Agent;
  requestedSessions: SessionConfig[];
  // True when a session came from --<cli>-<model>, whose model name still needs resolving.
  shorthandSessions: boolean;
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
    skips: skipRecord(true),
    forcePrompts: false,
    ignorePrompts: false,
    allowNativeChat: false,
    directPreview: false,
    requestedSessions: [],
    shorthandSessions: false,
  };
  const setSkip = (value: string, skip: boolean) => {
    options.skips[parseSkipPlatform(value)] = skip;
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--verify") options.verify = true;
    // `vs` is only a readable separator: --codex-6-luna vs --codex-terra
    else if (args[i] === "vs") continue;
    else if (/^--(codex|cursor|claude)-.+/.test(args[i]!)) {
      // Shorthand session: --<cli>-<model>[:effort]; the model is matched to the CLI's list at startup.
      const [, cli, rest] = /^--([a-z]+)-(.+)$/.exec(args[i]!)!;
      try {
        options.requestedSessions.push(
          parseSessionSpec(`${cli}:${rest}`, options.requestedSessions.length),
        );
      } catch (error) {
        console.error(
          `ERROR: ${error instanceof Error ? error.message : "Invalid session"}\n${help}`,
        );
        process.exit(2);
      }
      options.shorthandSessions = true;
    } else if (args[i] === "--session") {
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
    } else if (args[i] === "--cli" || CLIS.some((cli) => args[i] === `--${cli}`)) {
      const agent = args[i] === "--cli" ? args[++i] : args[i]!.slice(2);
      if (
        !isCli(agent) ||
        (options.singleAgent && options.singleAgent !== agent)
      ) {
        console.error(
          `ERROR: Choose one CLI: ${CLIS.map((cli) => `--${cli}`).join(", ")}, or --cli ${CLIS.join("|")}.\n${help}`,
        );
        process.exit(2);
      }
      options.singleAgent = agent;
    } else if (args[i] === "--non-interactive") options.interactive = false;
    else if (args[i] === "--mode" && ["live", "rehearsal"].includes(args[i + 1] ?? ""))
      options.mode = args[++i] as StreamOptions["mode"];
    else if (args[i] === "--runner" && (RUNNER_MODES as readonly string[]).includes(args[i + 1] ?? ""))
      options.runnerMode = args[++i] as StreamOptions["runnerMode"];
    else if (args[i] === "--allow-native-chat") options.allowNativeChat = true;
    else if (args[i] === "--direct-preview") options.directPreview = true;
    else if (args[i] === "--prompts") options.forcePrompts = true;
    else if (args[i] === "--no-prompts") options.ignorePrompts = true;
    else if (args[i] === "--chat" && args[i + 1]) {
      try {
        setSkip(args[++i]!, false);
      } catch (error) {
        console.error(
          `ERROR: ${error instanceof Error ? error.message : "Invalid --chat"}`,
        );
        process.exit(2);
      }
    } else if (args[i] === "--skip" && args[i + 1]) {
      try {
        setSkip(args[++i]!, true);
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
  Object.assign(process.env, skipEnvRecord(options.skips));
}

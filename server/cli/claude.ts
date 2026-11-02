import { ActivityAdapter } from "../activity.js";
import {
  CLAUDE_DOCKER_PERMISSION,
  CLAUDE_EXEC_PROFILE_ARGS,
} from "../claude-profile.js";
import { missingLoginError } from "../cli-startup-repair.js";
import type { CliAdapter, CliModel } from "./types.js";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// Claude Code has no list-models command. --model accepts these aliases and
// full model IDs; the account decides at run time whether a model is allowed.
export const CLAUDE_MODELS: CliModel[] = [
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
].map((id) => ({ id, efforts: EFFORTS }));

const REQUIRED_FLAGS = [
  "--print",
  "--output-format",
  "--verbose",
  "--model",
  "--effort",
  "--permission-mode",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--mcp-config",
  "--setting-sources",
  "--settings",
];

export const claude: CliAdapter = {
  cli: "claude",
  // Tool results (writes, Bash) arrive on user events; capture after each.
  edited: (event) =>
    event.type === "user" &&
    typeof event.message === "object" &&
    (event.message?.content ?? []).some((block) => block.type === "tool_result"),
  async check(host) {
    const help = await host.capture("claude", ["claude", "--help"]);
    for (const flag of REQUIRED_FLAGS)
      if (!help.includes(flag))
        throw new Error(
          `Installed Claude Code CLI lacks required isolation control ${flag}`,
        );
    if (!/--disallowed-?tools/i.test(help))
      throw new Error(
        "Installed Claude Code CLI lacks required isolation control --disallowedTools",
      );
  },
  async discover(host) {
    if (!(await host.claudeToken()))
      throw missingLoginError("claude", host.executionBoundary);
    await host.capture("claude", ["claude", "--version"]);
    return { models: CLAUDE_MODELS };
  },
  command: (session, prompt) => [
    "claude",
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    session.model,
    ...(session.effort ? ["--effort", session.effort] : []),
    "--permission-mode",
    CLAUDE_DOCKER_PERMISSION,
    ...CLAUDE_EXEC_PROFILE_ARGS,
    prompt,
  ],
  activity: (session, round, clean, emit, general, root) =>
    new ActivityAdapter("claude", round, clean, emit, Date.now, session.id, general, root),
};

import { ActivityAdapter } from "../activity.js";
import {
  CLAUDE_MIN_VERSION,
  CLAUDE_TERMINAL_TOOLS,
  CLAUDE_WRITE_TOOLS,
  claudeProfile,
  claudeProfileViolation,
  claudeVersionAtLeast,
} from "../claude-profile.js";
import { missingLoginError } from "../cli-startup-repair.js";
import type { CliEvent } from "./events.js";
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

const CHANGING_TOOLS = [...CLAUDE_WRITE_TOOLS, ...CLAUDE_TERMINAL_TOOLS];

// One run's "did a file change" check. A tool result alone carries no tool
// name, so the IDs of write and command calls are remembered until their
// result arrives; the set belongs to this run and goes away with it.
function editTracker() {
  const pending = new Set<string>();
  return (event: CliEvent) => {
    const blocks = typeof event.message === "object" ? event.message?.content ?? [] : [];
    if (event.type === "assistant")
      for (const block of blocks)
        if (block.type === "tool_use" && block.id && CHANGING_TOOLS.includes(block.name ?? ""))
          pending.add(block.id);
    if (event.type !== "user") return false;
    let edited = false;
    for (const block of blocks)
      if (block.type === "tool_result" && block.tool_use_id && pending.delete(block.tool_use_id))
        edited = true;
    return edited;
  };
}

export const claude: CliAdapter = {
  cli: "claude",
  // One version gate instead of scanning --help: every isolation flag the
  // profile passes exists from CLAUDE_MIN_VERSION on.
  async check(host) {
    const version = await host.capture("claude", ["claude", "--version"]);
    if (!claudeVersionAtLeast(version))
      throw new Error(
        `Installed Claude Code ${version.trim() || "(unknown version)"} is older than ${CLAUDE_MIN_VERSION}; update Claude Code`,
      );
  },
  async discover(host) {
    if (!(await host.claudeToken()))
      throw missingLoginError("claude", host.executionBoundary);
    return { models: CLAUDE_MODELS };
  },
  command: (session, prompt, run) => [
    "claude",
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    session.model,
    ...(session.effort ? ["--effort", session.effort] : []),
    ...claudeProfile(run),
    // The task is always the last argument; "--" stops it being read as a flag.
    "--",
    prompt,
  ],
  activity: (session, round, clean, emit, run, root) =>
    new ActivityAdapter("claude", round, clean, emit, Date.now, session.id, run.general, root, {
      edited: editTracker(),
      checkInit: (init) => claudeProfileViolation(init, { model: session.model, run }),
    }),
};

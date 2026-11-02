import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import type { RunContext } from "./cli/types.js";

// Claude Code runs with a subscription token (claude setup-token), so --bare,
// which accepts only API keys, is unavailable. Isolation comes from these
// flags plus a managed config directory that the CLI treats as the user scope.
//
// The managed settings file is the only filesystem source Claude reads
// (--setting-sources user), so a .claude/settings.json or .mcp.json the agent
// writes into its reused workspace cannot add hooks or MCP servers.
export const CLAUDE_PROFILE_SETTINGS = {
  disableAllHooks: true,
  enableAllProjectMcpServers: false,
} as const;

// Native runs have no container: Bash runs inside Claude's OS sandbox
// (Seatbelt on macOS, bubblewrap on Linux) and must fail if it is unavailable.
export const CLAUDE_NATIVE_SETTINGS = {
  ...CLAUDE_PROFILE_SETTINGS,
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
  },
} as const;

const CLAUDE_PROFILE_JSON = JSON.stringify(CLAUDE_PROFILE_SETTINGS);
export const CLAUDE_NATIVE_PROFILE_JSON = JSON.stringify(CLAUDE_NATIVE_SETTINGS);

// Docker only bypasses permissions because the container is the boundary;
// native runs use acceptEdits plus the OS sandbox above.
export const CLAUDE_DOCKER_PERMISSION = "bypassPermissions";
export const claudePermission = (run: RunContext) =>
  run.boundary === "native" ? "acceptEdits" : CLAUDE_DOCKER_PERMISSION;

// Claude Code's built-in tool names, shared by the live parser and saved history.
export const CLAUDE_WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
export const CLAUDE_TERMINAL_TOOLS = ["Bash", "BashOutput", "KillShell"];

// An arena round only reads and writes files. Leaving out Bash, web and
// subagent tools removes them from the model entirely, rather than relying on
// the prompt asking it not to use them.
export const CLAUDE_ARENA_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];
// Tools an arena run must never be offered; checked again on system/init.
const ARENA_FORBIDDEN_TOOLS = [...CLAUDE_TERMINAL_TOOLS, "WebFetch", "WebSearch", "Task", "Agent"];
// An arena page takes a few turns; this only stops a runaway loop.
const ARENA_MAX_TURNS = "30";

// Every flag below exists from this version on (--permission-prompts is the newest).
const MIN_VERSION = [2, 1, 259] as const;
export const CLAUDE_MIN_VERSION = MIN_VERSION.join(".");

// The isolation flags for one run, chosen from where and why it runs.
export function claudeProfile(run: RunContext): string[] {
  return [
    "--permission-mode",
    claudePermission(run),
    // A call that would need approval is denied at once instead of retried.
    "--permission-prompts",
    "none",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disallowedTools",
    "mcp__*",
    "--setting-sources",
    "user",
    "--settings",
    run.boundary === "native" ? CLAUDE_NATIVE_PROFILE_JSON : CLAUDE_PROFILE_JSON,
    ...(run.general
      ? []
      : ["--tools", CLAUDE_ARENA_TOOLS.join(","), "--max-turns", ARENA_MAX_TURNS]),
  ];
}

// Non-secret environment for every Claude run (Docker and native).
export const CLAUDE_RUN_ENV = {
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  // Without this, -p waits up to 10 minutes for background work after it finishes.
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
} as const;

export const CLAUDE_TOKEN_PATH = "runtime/auth/claude/oauth-token";
const TOKEN_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

export function validClaudeToken(value: string) {
  return TOKEN_SHAPE.test(value.trim());
}

// The token is read by the host and passed to the CLI through its process
// environment; it is never copied into an agent-writable workspace.
export async function readClaudeToken(root: string) {
  const path = resolve(root, CLAUDE_TOKEN_PATH);
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error("Claude login must be a regular file, not a link");
  const token = (await readFile(path, "utf8")).trim();
  return validClaudeToken(token) ? token : undefined;
}

// Rebuilds a CLAUDE_CONFIG_DIR from nothing on every launch. Claude also loads
// CLAUDE.md, skills, agents and commands from this folder, so resetting only
// settings.json would let a reused session plant instructions for its next run.
// rm never follows a link, so a planted symlink is removed, not its target.
export async function prepareClaudeConfig(config: string) {
  await rm(config, { recursive: true, force: true });
  await mkdir(config, { recursive: true, mode: 0o700 });
  const info = await lstat(config);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("Claude profile must be a real directory");
  await writeFileAtomic(
    resolve(config, "settings.json"),
    `${JSON.stringify(CLAUDE_PROFILE_SETTINGS, null, 2)}\n`,
  );
  return config;
}

// What system/init reports about the session Claude actually started.
interface ClaudeInit {
  mcp_servers?: unknown[];
  plugins?: unknown[];
  permissionMode?: string;
  apiKeySource?: string;
  model?: string;
  tools?: unknown[];
}

// Runtime check on the system/init event. Returns the reason the run must
// stop, or undefined. Fields Claude does not report are not guessed at.
// Without `expected` only the MCP/plugin rule applies.
export function claudeProfileViolation(
  init: ClaudeInit,
  expected?: { model: string; run: RunContext },
) {
  if (init.mcp_servers?.length || init.plugins?.length)
    return "Claude arena profile exposes MCP servers or plugins; run stopped";
  if (!expected) return undefined;
  const permission = claudePermission(expected.run);
  if (init.permissionMode && init.permissionMode !== permission)
    return `Claude started in ${init.permissionMode} mode instead of ${permission}; run stopped`;
  // In -p mode an API key silently overrides the subscription token.
  if (init.apiKeySource && /api.?key|helper/i.test(init.apiKeySource))
    return "Claude is using an API key instead of the saved subscription token; run stopped";
  // An alias (sonnet) resolves to a full ID that contains it; a full ID may gain a suffix.
  if (init.model && !init.model.includes(expected.model))
    return `Claude started model ${init.model} instead of ${expected.model}; no model was substituted, run stopped`;
  if (!expected.run.general && init.tools?.some((tool) => ARENA_FORBIDDEN_TOOLS.includes(String(tool))))
    return "Claude arena run was offered command or web tools; run stopped";
  return undefined;
}

// True when `version` (e.g. "2.1.302 (Claude Code)") is at least CLAUDE_MIN_VERSION.
export function claudeVersionAtLeast(version: string) {
  const have = version.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!have) return false;
  const [a, b, c] = have as [number, number, number];
  return (a - MIN_VERSION[0] || b - MIN_VERSION[1] || c - MIN_VERSION[2]) >= 0;
}

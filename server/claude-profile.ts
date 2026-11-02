import { lstat, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";

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

export const CLAUDE_PROFILE_JSON = JSON.stringify(CLAUDE_PROFILE_SETTINGS);
export const CLAUDE_NATIVE_PROFILE_JSON = JSON.stringify(CLAUDE_NATIVE_SETTINGS);

// These controls apply to arena invocations, never the user's normal CLI config.
export const CLAUDE_EXEC_PROFILE_ARGS = [
  "--no-session-persistence",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--disallowedTools",
  "mcp__*",
  "--setting-sources",
  "user",
  "--settings",
  CLAUDE_PROFILE_JSON,
] as const;

// Docker only bypasses permissions because the container is the boundary;
// native runs swap this for acceptEdits plus the OS sandbox above.
export const CLAUDE_DOCKER_PERMISSION = "bypassPermissions";
export const CLAUDE_NATIVE_PERMISSION = "acceptEdits";

// Non-secret environment for every Claude run (Docker and native).
export const CLAUDE_RUN_ENV = {
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
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

// The CLAUDE_CONFIG_DIR inside the round home. It is rewritten on every
// launch, so anything the agent changed there in a reused session is reset.
export async function prepareClaudeHome(home: string) {
  const config = resolve(home, ".claude");
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

// Runtime check on the system/init event: the profile must expose no MCP
// servers or plugins. Returns the reason when it does.
export function claudeProfileViolation(init: {
  mcp_servers?: unknown[];
  plugins?: unknown[];
}) {
  if (init.mcp_servers?.length || init.plugins?.length)
    return "Claude arena profile exposes MCP servers or plugins; run stopped";
  return undefined;
}

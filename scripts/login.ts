import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  AGENT_NETWORK,
  EGRESS_PROXY,
  RUNNER_LIMITS,
} from "../server/constants.js";
import { settings, root } from "../server/config.js";
import { assertProviderProxy } from "../server/provider-proxy.js";
import { writeFileAtomic } from "../server/atomic-file.js";
import { CLAUDE_TOKEN_PATH, validClaudeToken } from "../server/claude-profile.js";
const agent = process.argv[2];
if (agent !== "codex" && agent !== "cursor" && agent !== "claude")
  throw new Error("Choose codex, cursor or claude");

// Claude Code: `claude setup-token` runs a browser login on the user's own
// machine and prints a long-lived subscription token. The token is pasted
// here (not echoed) and stored host-only; runs receive it via environment.
async function readHidden(question: string) {
  const input = process.stdin;
  if (!input.isTTY) throw new Error("Run this login in an interactive terminal");
  process.stdout.write(question);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return await new Promise<string>((done, fail) => {
    let value = "";
    const finish = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      process.stdout.write("\n");
      error ? fail(error) : done(value.trim());
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") return finish(new Error("Login cancelled"));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on("data", onData);
  });
}

if (agent === "claude") {
  console.log(
    "Run `claude setup-token` in another terminal (needs a Claude Pro, Max, Team or Enterprise plan),\nthen paste the printed token here. It is saved only to " +
      CLAUDE_TOKEN_PATH +
      ".",
  );
  const token = await readHidden("Claude Code token: ");
  if (!validClaudeToken(token))
    throw new Error("That does not look like a Claude Code token (expected sk-ant-…)");
  const dir = resolve(root, "runtime/auth/claude");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("runtime/auth/claude must be a real directory");
  await chmod(dir, 0o700);
  await writeFileAtomic(resolve(root, CLAUDE_TOKEN_PATH), `${token}\n`, 0o600);
  console.log("Claude Code login saved.");
  process.exit(0);
}

await assertProviderProxy(root);
// `npm run sandbox:login:codex -- 2` saves a second Codex account for session-2.
const dir = resolve(root, "runtime/auth", agent === "codex" && process.argv[3] === "2" ? "codex-2" : agent);
await mkdir(resolve(dir, ".codex"), { recursive: true, mode: 0o700 });
if (agent === "codex")
  await writeFile(
    resolve(dir, ".codex/config.toml"),
    'cli_auth_credentials_store = "file"\n',
    { mode: 0o600 },
  );
// Login is host-driven. Auth remains in a separate ignored directory and is copied to a fresh round home.
const args = [
  "run",
  "--rm",
  "-it",
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  `--user=${RUNNER_LIMITS.user}`,
  `--network=${AGENT_NETWORK}`,
  "--mount",
  `type=bind,source=${dir},target=/workspace/.home`,
  "--tmpfs",
  "/workspace/.tmp:uid=1000,gid=1000,mode=700",
  "-e",
  `HTTPS_PROXY=${EGRESS_PROXY}`,
  "-e",
  `HTTP_PROXY=${EGRESS_PROXY}`,
  "-e",
  "NODE_USE_ENV_PROXY=1",
  settings.agentImage,
  ...(agent === "codex"
    ? ["codex", "login", "--device-auth"]
    : ["cursor-agent", "login"]),
];
const proc = spawn("docker", args, { stdio: "inherit" });
proc.on("error", () => {
  console.error("Docker login could not start");
  process.exitCode = 1;
});
proc.on("exit", (code) => {
  process.exitCode = code ?? 1;
});

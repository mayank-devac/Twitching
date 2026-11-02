import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  AGENT_NETWORK,
  EGRESS_PROXY,
  RUNNER_LIMITS,
} from "../server/constants.js";
import { settings, root } from "../server/config.js";
import { assertProviderProxy } from "../server/provider-proxy.js";
import { writeFileAtomic } from "../server/atomic-file.js";
import { CLAUDE_TOKEN_PATH, validClaudeToken } from "../server/claude-profile.js";
import { copyHostCodexLogin, hostCodexLogin } from "../server/codex-profile.js";
const agent = process.argv[2];
if (agent !== "codex" && agent !== "cursor" && agent !== "claude")
  throw new Error("Choose codex, cursor or claude");

// Asks for one of `options`; Enter picks `fallback`.
async function choose(question: string, options: string[], fallback: string) {
  if (!process.stdin.isTTY) throw new Error("Run this login in an interactive terminal");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(question)).trim() || fallback;
      if (options.includes(answer)) return answer;
      console.log(`Type ${options.join(" or ")}.`);
    }
  } catch (error) {
    // Ctrl+C / Ctrl+D at the menu.
    if (error instanceof Error && error.name === "AbortError") throw new Error("Login cancelled");
    throw error;
  } finally {
    rl.close();
  }
}

const hasHostCli = (program: string) =>
  spawnSync(program, ["--version"], { stdio: "ignore" }).status === 0;

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
  // Claude's own sign-in lives in the macOS Keychain and expires within hours,
  // so it cannot be copied. With the host CLI present, setup-token reuses that
  // sign-in (one browser click) to mint the long-lived token the sandbox needs.
  const reuse =
    hasHostCli("claude") &&
    (await choose(
      "Claude Code login for the sandbox (needs a Claude Pro, Max, Team or Enterprise plan):\n" +
        "  1 = use my existing Claude sign-in: run `claude setup-token` here now (one browser click)\n" +
        "  2 = paste a token I already have\n" +
        "Choose [1]: ",
      ["1", "2"],
      "1",
    )) === "1";
  if (reuse) {
    const result = spawnSync("claude", ["setup-token"], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("claude setup-token did not finish; rerun npm run sandbox:login:claude");
    console.log("\nCopy the sk-ant-… token printed above and paste it below.");
  } else {
    console.log(
      "Run `claude setup-token` in another terminal, then paste the printed token here.",
    );
  }
  console.log(`It is saved only to ${CLAUDE_TOKEN_PATH}.`);
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

// `npm run sandbox:login:codex -- 2` saves a second Codex account for session-2.
const secondAccount = agent === "codex" && process.argv[3] === "2";
const dir = resolve(root, "runtime/auth", secondAccount ? "codex-2" : agent);
const writeCodexConfig = async () => {
  await mkdir(resolve(dir, ".codex"), { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(dir, ".codex/config.toml"),
    'cli_auth_credentials_store = "file"\n',
    { mode: 0o600 },
  );
};

// The second account must differ from the host login, so copying is only
// offered for the main account. The file is copied as-is, never parsed or printed.
if (agent === "codex" && !secondAccount && (await hostCodexLogin())) {
  const answer = await choose(
    "Found your existing Codex login (~/.codex/auth.json).\n" +
      "  1 = copy it into the sandbox (no sign-in needed)\n" +
      "  2 = sign in to a new, separate sandbox login\n" +
      "Copying shares one login with your normal Codex CLI. Codex renews it from time to time,\n" +
      "and when one side renews, the other may be signed out and need `codex login` again.\n" +
      "A separate login avoids that.\n" +
      "Choose [1]: ",
    ["1", "2"],
    "1",
  );
  if (answer === "1") {
    await writeCodexConfig();
    if (!(await copyHostCodexLogin(root))) throw new Error("Could not copy ~/.codex/auth.json");
    console.log("Codex login copied into the sandbox.");
    process.exit(0);
  }
}

await assertProviderProxy(root);
if (agent === "codex") await writeCodexConfig();
else await mkdir(resolve(dir, ".codex"), { recursive: true, mode: 0o700 });
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

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  AGENT_NETWORK,
  EGRESS_PROXY,
  RUNNER_LIMITS,
} from "../server/constants.js";
import { settings, root } from "../server/config.js";
import { assertProviderProxy } from "../server/provider-proxy.js";
const agent = process.argv[2];
if (agent !== "codex" && agent !== "cursor")
  throw new Error("Choose codex or cursor");
assertProviderProxy(root);
const dir = resolve(root, "runtime/auth", agent);
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

// Owns the Docker side of startup: engine, agent/preview images (with build consent), provider proxy and preview network.
import type { RunnerMode } from "../../shared/types.js";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Docker } from "../../server/docker.js";
import { PREVIEW_NETWORK } from "../../server/constants.js";
import { assertProviderProxy } from "../../server/provider-proxy.js";
import {
  fix,
  repair,
  root,
  run,
  throwIfStopping,
  toolEnv,
  yes,
  type Settings,
} from "./runtime.js";

const hasColima = () =>
  execFileAsync("colima", ["version"], { timeout: 10_000 }).then(() => true, () => false);

async function waitForDockerEngine(docker: Docker) {
  // Prefer the engine the user actually has: Colima if installed, else Docker Desktop.
  if (await hasColima()) {
    console.log("Starting Colima…");
    await run("colima", ["start"]);
  } else if (process.platform === "darwin") {
    console.log("Opening Docker Desktop…");
    await new Promise<void>((done) => {
      const child = spawn("open", ["-a", "Docker"], { stdio: "inherit" });
      child.once("error", () => done());
      child.once("close", () => done());
    });
  }
  const until = Date.now() + 90_000;
  let announced = false;
  while (Date.now() < until) {
    throwIfStopping();
    try {
      await docker.command(["info", "--format", "{{.ServerVersion}}"]);
      return;
    } catch {
      if (!announced) {
        console.log("Waiting for the Docker engine…");
        announced = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error(
    "Docker engine did not start within 90 seconds. Start Colima (colima start) or Docker Desktop and wait until it is ready. Run ./doctor.sh for details.",
  );
}

const execFileAsync = promisify(execFile);
const outsideHome = () => {
  const home = homedir();
  const inner = relative(home, root);
  return !home || inner === "" ? false : inner.startsWith("..") || isAbsolute(inner);
};
// Home stays shared (Colima's default) so other projects keep working.
const colimaMounts = () => [`${homedir()}:w`, ...(outsideHome() ? [`${root}:w`] : [])];

// True when the Docker engine this launcher talks to is Colima's.
async function activeColima(docker: Docker) {
  try {
    const { stdout } = await execFileAsync("colima", ["status", "--json"], { timeout: 10_000 });
    const socket = JSON.parse(stdout).docker_socket as string | undefined;
    if (!socket) return false;
    const endpoint =
      process.env.DOCKER_HOST ||
      (await docker.command(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])).trim();
    return endpoint === socket;
  } catch {
    return false;
  }
}

// Agent and preview containers bind-mount folders under runtime/. A VM-backed
// engine only sees shared host folders, so prove a fresh folder is visible.
async function assertProjectShared(docker: Docker, image: string) {
  const dir = resolve(root, "runtime/workspaces", `.share-probe-${randomUUID()}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(resolve(dir, "ok"), "");
    for (let attempt = 1; ; attempt++) {
      try {
        await docker.command(
          ["run", "--rm", "--network", "none", "--user", "0:0", "--entrypoint", "test",
            "--mount", `type=bind,source=${dir},target=/probe,readonly`, image, "-e", "/probe/ok"],
          30_000,
        );
        return;
      } catch (error) {
        // A slow VM file share can lag a moment behind a new folder.
        if (attempt >= 5)
          throw new Error(
            /bind source path does not exist|mounts denied|not shared/i.test(String(error))
              ? "Docker cannot see this project folder"
              : "Docker could not open a test file in this project folder",
          );
        await new Promise((done) => setTimeout(done, 1000));
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Returns true when previews will skip Docker (direct preview), so callers can skip the isolated render check.
export async function checkSandbox(
  docker: Docker,
  settings: Settings,
  runnerMode: RunnerMode,
  requestedDirect = false,
) {
  if (runnerMode === "native") {
    if (requestedDirect) {
      console.log("\nDirect preview: skipping the Docker checks. Pages will not be isolated.");
      return true;
    }
    const engineUp = await docker
      .command(["info", "--format", "{{.ServerVersion}}"])
      .then(() => true, () => false);
    // Ask only when Docker is down; a non-interactive start falls through to the normal failure advice.
    if (
      !engineUp &&
      (await yes(
        "\nDocker or Colima is not running. Native agents can show results straight in the browser instead (direct preview).\nPages are then not isolated, and a heavy page may be reloaded or paused. You can switch this later in Quick Settings.\nUse direct preview?",
      ))
    ) {
      console.log("Direct preview on: skipping the Docker checks.");
      return true;
    }
  }
  await repair(
    "Docker engine",
    () =>
      docker.command(["info", "--format", "{{.ServerVersion}}"]).then(() => {}),
    "Start Colima (colima start) or Docker Desktop and wait until its engine is running. Docker is required for previews even with native agents. No engine installed? Run ./setup.sh.",
    () => waitForDockerEngine(docker),
  );
  if (runnerMode === "docker")
    await repair(
      "agent image",
      () =>
        docker
          .command(["image", "inspect", settings.agentImage])
          .then(() => {}),
      "Run npm run sandbox:build.",
      // Ask here: this process's readline owns stdin, so the npm script's own
      // prompt would race it. The env answer makes the script skip asking.
      async () => {
        const env = {
          ...toolEnv,
          INSTALL_CURSOR: (await yes("Install Cursor CLI in the sandbox image?"))
            ? "1"
            : "0",
          INSTALL_CLAUDE: (await yes("Install Claude Code CLI in the sandbox image?"))
            ? "1"
            : "0",
        };
        await run("npm", ["run", "sandbox:build"], env);
      },
    );
  await repair(
    "preview image",
    () =>
      docker
        .command(["image", "inspect", settings.previewImage])
        .then(() => {}),
    "Run npm run sandbox:build:preview.",
    () => run("npm", ["run", "sandbox:build:preview"]),
  );
  const colima = await activeColima(docker);
  await repair(
    "project folder shared with Docker",
    () => assertProjectShared(docker, settings.previewImage),
    colima
      ? `Colima does not share this folder. The fix restarts Colima with your home folder${outsideHome() ? " and this project folder" : ""} shared (running containers stop and the launcher restarts what it needs). Or run it yourself: colima stop && colima start ${colimaMounts().map((m) => `--mount "${m}"`).join(" ")}`
      : "Add this project folder under Docker Desktop → Settings → Resources → File sharing, apply, then rerun. Or clone the project inside your home folder.",
    colima
      ? async () => {
          await run("colima", ["stop"]);
          await run("colima", ["start", ...colimaMounts().flatMap((m) => ["--mount", m])]);
        }
      : undefined,
  );
  await repair(
    "provider proxy",
    () => assertProviderProxy(root),
    "Run docker compose -f sandbox/compose.yml up -d. Codex login and Docker agents use this proxy. Never replace the internal network with an unrestricted network.",
    () => run("docker", ["compose", "-f", "sandbox/compose.yml", "up", "-d"]),
  );
  await repair(
    "isolated preview network",
    async () => {
      if (
        (
          await docker.command([
            "network",
            "inspect",
            PREVIEW_NETWORK,
            "--format",
            "{{.Internal}}",
          ])
        ).trim() !== "true"
      )
        throw new Error(`${PREVIEW_NETWORK} must be internal`);
    },
    `Create an internal ${PREVIEW_NETWORK} network. If a wrong network already exists, stop its users and fix it manually.`,
    async () => {
      try {
        await docker.command(["network", "inspect", PREVIEW_NETWORK]);
        fix(
          "An existing preview network is unsafe",
          "Fix that network manually; this script will not delete networks.",
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("An existing"))
          throw error;
        await run("docker", [
          "network",
          "create",
          "--internal",
          PREVIEW_NETWORK,
        ]);
      }
    },
  );
  return false;
}

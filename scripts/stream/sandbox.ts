// Owns the Docker side of startup: engine, agent/preview images (with build consent), provider proxy and preview network.
import type { RunnerMode } from "../../shared/types.js";
import { spawn } from "node:child_process";
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

async function waitForDockerEngine(docker: Docker) {
  if (process.platform === "darwin") {
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
    "Docker engine did not start within 90 seconds. Open Docker Desktop and wait until it is ready.",
  );
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
    "Docker Desktop",
    () =>
      docker.command(["info", "--format", "{{.ServerVersion}}"]).then(() => {}),
    "Open Docker Desktop and wait until its engine is running. Docker is required for previews even with native agents.",
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

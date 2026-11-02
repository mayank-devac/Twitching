// Owns the host prerequisite checklist: ports, overlay build, media, CLI logins/quota, Jev, OBS and a real isolated render.
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Docker } from "../../server/docker.js";
import type { Obs } from "../../server/obs.js";
import type { CliRunner } from "../../server/runner.js";
import {
  cliLoginCommand,
  cliStartupAdvice,
  failedLoginAgent,
} from "../../server/cli-startup-repair.js";
import { credentialGuard } from "../../server/redact.js";
import { CLIS, CLI_LABELS, configuredSessions, sessionCount, type Agent, type RunnerMode } from "../../shared/types.js";
import { newestSource } from "../boot-client.js";
import {
  fix,
  question,
  repair,
  root,
  run,
  type Secrets,
  type Settings,
} from "./runtime.js";

async function freePort() {
  const server = createServer();
  return new Promise<number>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close((error) => (error ? reject(error) : done(port)));
    });
  });
}
async function assertFree(port: number) {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", () => reject(new Error(`Port ${port} is occupied`)));
    server.listen(port, "127.0.0.1", () =>
      server.close((error) => (error ? reject(error) : done())),
    );
  });
}

// Ports (skipped when attaching to an existing app), overlay bundle and break media.
export async function checkLocalSetup(settings: Settings, existing: boolean) {
  if (!existing)
    for (const port of [
      settings.port,
      settings.previewPort,
      settings.browserPort,
      settings.webhookPort,
    ])
      await repair(
        `port ${port}`,
        () => assertFree(port),
        "Close the app using this port, or choose a different port in settings.json.",
      );
  const overlayBuilt = async () => {
    const built = await stat(resolve(root, "dist/index.html"));
    if (
      Math.max(
        await newestSource(resolve(root, "web")),
        await newestSource(resolve(root, "shared")),
      ) > built.mtimeMs
    )
      throw new Error("The overlay build is older than its source");
  };
  // A missing or stale overlay is rebuilt automatically; no prompt is needed.
  await repair(
    "built overlay",
    async () => {
      try {
        await overlayBuilt();
      } catch {
        console.log("Overlay build missing or out of date; running npm run build…");
        await run("npm", ["run", "build"]);
        await overlayBuilt();
      }
    },
    "Run npm run build.",
    () => run("npm", ["run", "build"]),
  );
  // Break media is optional: a missing file only means a silent or blank break.
  for (const file of [settings.musicPath, settings.visualPath]) {
    try {
      await access(file);
      if (!(await stat(file)).isFile()) throw new Error("not a file");
    } catch {
      console.warn(
        `WARNING: break media not available (${file}); breaks will run without it. Set musicPath/visualPath in settings.json to enable it.`,
      );
    }
  }
}

export interface ServiceCheck {
  settings: Settings;
  secrets: Secrets;
  runnerMode: RunnerMode;
  singleAgent?: Agent;
  runner: CliRunner;
  docker: Docker;
  obs: Obs;
  origin: string;
  clean: (text: string) => string;
  privateValues: string[];
  // Direct preview has no isolated browser to render in.
  directPreview?: boolean;
}

// Server modules load lazily because importing them reads the env this launcher prepares.
export async function checkServices(check: ServiceCheck) {
  const { settings, secrets, runnerMode, singleAgent, runner, clean } = check;
  const { BrowserSandbox } = await import("../../server/browser-sandbox.js");
  const { Previews } = await import("../../server/preview.js");
  const { Jev } = await import("../../server/jev.js");
  await repair(
    "CLI subscription logins, requested models and stream formats",
    async () => {
      for (const line of await runner.preflight())
        console.log(`  ${clean(line)}`);
    },
    (error) => cliStartupAdvice(error, runnerMode),
    async (error) => {
      const known = failedLoginAgent(error) ?? singleAgent;
      const choice = known
        ? undefined
        : await question(
            `Which login needs fixing? ${CLIS.map((cli, i) => `${i + 1} = ${CLI_LABELS[cli]}`).join(", ")} [cancel]: `,
          );
      const agent = known ?? CLIS[Number(choice) - 1];
      if (!agent) throw new Error("Login repair cancelled");
      if (known) console.log(`Running ${agent} login repair…`);
      const login = cliLoginCommand(agent, runnerMode);
      await run(login.program, login.args);
    },
  );
  if (configuredSessions(settings).some((session) => session.cli === "codex")) {
    const quota = await runner.quota();
    if (quota.remainingPercent <= 0)
      fix(
        `Codex five-hour allowance is empty. Reported reset: ${new Date(quota.resetsAt).toLocaleString()}`,
        "Wait for actual quota recovery, then rerun. No coding round will start with an empty allowance.",
      );
    console.log(
      `OK: Codex five-hour allowance ${Math.round(quota.remainingPercent)}% remaining`,
    );
  }
  if (secrets.jev)
    await repair(
      "TypeSafe Jev",
      async () => {
        const evaluation = await new Jev(secrets.jev).evaluate(
          settings.jevProbe,
        );
        if (
          evaluation.safety < settings.safetyThreshold ||
          evaluation.relevance < settings.relevanceThreshold
        )
          throw new Error("Jev did not approve the configured probe task");
      },
      "Check TYPESAFE_API_KEY and its TypeSafe access. Try again after an API outage.",
    );
  else
    console.log(
      "NOTE: Jev is not configured. Rehearsal can use a house task; live mode cannot.",
    );
  await repair(
    "OBS WebSocket and overlay source",
    async () => {
      const ready = await check.obs.readiness(`${check.origin}/overlay`);
      if (!ready.overlayConfigured)
        throw new Error("No OBS Browser Source uses this app overlay");
    },
    `Open OBS, enable Tools → WebSocket Server Settings, add OBS_PASSWORD privately, and add ${check.origin}/overlay as a Browser Source (1920 × 1080).`,
  );
  if (check.directPreview) {
    console.log("\nSkipping isolated HTML rendering: direct preview is on.");
    return;
  }
  await repair(
    "actual isolated HTML rendering",
    async () => {
      const tempRoot = resolve(root, "runtime/readiness", randomUUID());
      const port = await freePort();
      const apiPort = await freePort();
      const engine = new BrowserSandbox(
        check.docker,
        tempRoot,
        settings.previewImage,
        port,
      );
      const previews = new Previews(
        tempRoot,
        `http://127.0.0.1:${apiPort}`,
        settings.visualPath,
        () => engine.start(),
        credentialGuard(check.privateValues),
        settings.previewView,
      );
      try {
        await mkdir(resolve(tempRoot, "main/codex"), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(
          resolve(tempRoot, "main/codex/prompt_1.html"),
          '<html><body><canvas style="width:100%;height:100%"></canvas></body></html>',
        );
        await previews.ready();
        await previews.validate(
          "codex",
          1,
          sessionCount(configuredSessions(settings)),
        );
      } finally {
        await previews.close().catch(() => {});
        await engine.close().catch(() => {});
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
    "Check the preview image version, Docker resources and internal preview network. Rebuild with npm run sandbox:build:preview.",
  );
}

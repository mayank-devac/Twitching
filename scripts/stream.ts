import { chooseSessions, parseSessionSpec } from "./session-selection.js";
import { chooseExistingServer, stopExistingServer } from "./existing-server.js";
import {
  normalizeStartup,
  selectStartupSessions,
  startupConfigurationId,
} from "../server/startup-config.js";
import {
  configuredSessions,
  sessionCount,
  type SessionConfig,
} from "../shared/types.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { access, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline/promises";
import { PREVIEW_NETWORK } from "../server/constants.js";
import { redactor } from "../server/redact.js";
import {
  cliLoginCommand,
  cliStartupAdvice,
  failedLoginAgent,
} from "../server/cli-startup-repair.js";
import { parseSkipPlatform } from "../server/chat-skips.js";
import { assertProviderProxy } from "../server/provider-proxy.js";

const args = process.argv.slice(2);
const command = args.shift();
// Flags retain the guided arena flow; no flags opens the idle local welcome UI.
if (command === "start" && args.length === 0) {
  await import("./welcome-launcher.js");
  await new Promise(() => {});
}
process.env.ARENA_EXPERIENCE = "arena";
const help = `Prompt Arena guided startup

  ./check_stream_start.sh [--cli codex|cursor] [--mode live|rehearsal] [--runner docker|native] [--verify] [--non-interactive] [--chat yt|twitch|kick] [--skip yt|twitch|kick] [--prompts] [--no-prompts]
  ./start_stream.sh       [--cli codex|cursor] [--mode live|rehearsal] [--runner docker|native] [--verify] [--chat yt|twitch|kick] [--skip yt|twitch|kick] [--prompts] [--no-prompts]

Check defaults to live readiness. Start offers rehearsal/live and Docker/native choices.
Chat starts off. Repeat --chat for each platform you want, or enable it in Quick Settings.
--session cli:model[:effort] selects a session; repeat once for two sessions (including Codex + Codex).
Interactive start also offers session/model selection from installed CLIs.
--codex / --cursor (or --cli codex|cursor) runs one CLI in a full-width panel. The other CLI is not checked or launched.
--skip yt, --skip twitch and --skip kick omit those chat connections in live mode. Repeat --skip for each.
--prompts runs tasks from prompts.txt (or settings.promptFile) for the selected CLIs, then ends the show. OBS only; chat is skipped.
If that file already has tasks, prompt-list mode is used unless you pass --no-prompts.
--verify explicitly runs type checks, tests, fixture replay, build and (Docker mode) isolation tests.
Without --verify, checks use saved CLI logins/models/quota and a temporary isolated preview.
Check never starts a broadcast or coding round. Native agents still require Docker previews.
Public starts require terminal confirmation. No credentials are requested or printed in this terminal.
`;
if (args.includes("--help") || args.includes("-h")) {
  console.log(help);
  process.exit(0);
}
if (!["check", "start"].includes(command ?? "")) {
  console.error(help);
  process.exit(2);
}
let mode: "live" | "rehearsal" | undefined;
let runnerMode: "docker" | "native" | undefined;
let verify = false;
let interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
// Chat collection starts unchecked; each platform is an explicit opt-in.
let skipYoutube = true;
let skipTwitch = true;
let skipKick = true;
let forcePrompts = false;
let ignorePrompts = false;
let singleAgent: "codex" | "cursor" | undefined;
const requestedSessions: SessionConfig[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--verify") verify = true;
  else if (args[i] === "--session") {
    try {
      requestedSessions.push(
        parseSessionSpec(args[++i] ?? "", requestedSessions.length),
      );
    } catch (error) {
      console.error(
        `ERROR: ${error instanceof Error ? error.message : "Invalid session"}`,
      );
      process.exit(2);
    }
  } else if (["--codex", "--cursor", "--cli"].includes(args[i])) {
    const agent = args[i] === "--cli" ? args[++i] : args[i].slice(2);
    if (
      !["codex", "cursor"].includes(agent) ||
      (singleAgent && singleAgent !== agent)
    ) {
      console.error(
        `ERROR: Choose one CLI: --codex, --cursor, or --cli codex|cursor.\n${help}`,
      );
      process.exit(2);
    }
    singleAgent = agent as typeof singleAgent;
  } else if (args[i] === "--non-interactive") interactive = false;
  else if (args[i] === "--mode" && ["live", "rehearsal"].includes(args[i + 1]))
    mode = args[++i] as typeof mode;
  else if (args[i] === "--runner" && ["docker", "native"].includes(args[i + 1]))
    runnerMode = args[++i] as typeof runnerMode;
  else if (args[i] === "--prompts") forcePrompts = true;
  else if (args[i] === "--no-prompts") ignorePrompts = true;
  else if (args[i] === "--chat" && args[i + 1]) {
    try {
      const platform = parseSkipPlatform(args[++i]);
      if (platform === "youtube") skipYoutube = false;
      else if (platform === "twitch") skipTwitch = false;
      else skipKick = false;
    } catch (error) {
      console.error(
        `ERROR: ${error instanceof Error ? error.message : "Invalid --chat"}`,
      );
      process.exit(2);
    }
  } else if (args[i] === "--skip" && args[i + 1]) {
    try {
      const platform = parseSkipPlatform(args[++i]);
      if (platform === "youtube") skipYoutube = true;
      else if (platform === "twitch") skipTwitch = true;
      else skipKick = true;
    } catch (error) {
      console.error(
        `ERROR: ${error instanceof Error ? error.message : "Invalid --skip"}\n${help}`,
      );
      process.exit(2);
    }
  } else {
    console.error(`ERROR: Invalid option or value.\n${help}`);
    process.exit(2);
  }
}
if (singleAgent && requestedSessions.length) {
  console.error("ERROR: Use --session or --cli, not both.");
  process.exit(2);
}
if (singleAgent) delete process.env.ARENA_SESSIONS;
if (requestedSessions.length)
  process.env.ARENA_SESSIONS = JSON.stringify(requestedSessions);
if (forcePrompts && ignorePrompts) {
  console.error(
    "ERROR: Use either --prompts or --no-prompts, not both.\n" + help,
  );
  process.exit(2);
}
if (forcePrompts) process.env.ARENA_PROMPTS = "1";
if (ignorePrompts) process.env.ARENA_NO_PROMPTS = "1";
process.env.ARENA_SINGLE_AGENT = singleAgent ?? "";
const input = interactive
  ? createInterface({ input: process.stdin, output: process.stdout })
  : undefined;
const question = async (text: string, fallback = "") => {
  if (stopping) throw new Error("Cancelled");
  return input ? (await input.question(text)).trim() : fallback;
};
const yes = async (text: string) =>
  /^(y|yes)$/i.test(await question(`${text} [y/N]: `));
const root = process.cwd();
let safeMessage = redactor([], root);
const fix = (message: string, instruction: string): never => {
  throw new Error(`${message}\nFix: ${instruction}`);
};
const toolEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG,
  DOCKER_HOST: process.env.DOCKER_HOST,
  DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
};
async function run(program: string, parameters: string[], env = toolEnv) {
  await new Promise<void>((done, reject) => {
    const child = spawn(program, parameters, {
      cwd: root,
      env,
      stdio: "inherit",
    });
    child.once("error", () =>
      reject(new Error(`Cannot run ${program}. Install it or add it to PATH.`)),
    );
    child.once("close", (code) =>
      stopping
        ? reject(new Error("Cancelled"))
        : code === 0
          ? done()
          : reject(
              new Error(
                `${program} failed. Fix the error shown above, then rerun this file.`,
              ),
            ),
    );
  });
}
async function repair(
  label: string,
  action: () => void | Promise<void>,
  instruction:
    string | ((error: unknown) => { instruction: string; canRepair: boolean }),
  repairAction?: (error: unknown) => Promise<void>,
) {
  if (stopping) throw new Error("Cancelled");
  console.log(`\nChecking ${label}…`);
  try {
    await action();
  } catch (error) {
    const advice =
      typeof instruction === "function"
        ? instruction(error)
        : { instruction, canRepair: true };
    console.error(
      `FAIL: ${label}\n${safeMessage(error instanceof Error ? error.message : "Check failed")}\nFix: ${advice.instruction}`,
    );
    if (!advice.canRepair || !repairAction || !(await yes("Run this fix now?")))
      throw new Error(`${label} is not ready. ${advice.instruction}`);
    await repairAction(error);
    if (stopping) throw new Error("Cancelled");
    await action();
  }
  if (stopping) throw new Error("Cancelled");
  console.log(`OK: ${label}`);
}
async function waitForDockerEngine(docker: {
  command: (args: string[]) => Promise<string>;
}) {
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
    if (stopping) throw new Error("Cancelled");
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
async function newestSource(folder: string): Promise<number> {
  let newest = 0;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = resolve(folder, entry.name);
    if (entry.isDirectory())
      newest = Math.max(newest, await newestSource(path));
    else if (/\.(ts|tsx|css|html)$/.test(entry.name))
      newest = Math.max(newest, (await stat(path)).mtimeMs);
  }
  return newest;
}

let closeResources: (() => Promise<void>) | undefined;
let app: ChildProcess | undefined;
let appExit: Promise<number | null> | undefined;
let closeShow: (() => Promise<void>) | undefined;
let stopping = false;
let shutdownPromise: Promise<void> | undefined;
async function shutdown() {
  stopping = true;
  if (!shutdownPromise) shutdownPromise = finishShutdown();
  await shutdownPromise;
}
async function finishShutdown() {
  await closeShow?.().catch((error) =>
    console.error(
      `ERROR: Could not confirm OBS/show shutdown: ${error.message}. Check OBS manually.`,
    ),
  );
  if (app?.pid && app.exitCode === null) {
    process.kill(-app.pid, "SIGTERM");
    const exit = appExit!;
    const stopped = await Promise.race([
      exit.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 12000)),
    ]);
    if (!stopped)
      console.error(
        "ERROR: The app did not confirm shutdown. Stop its processes before starting another show.",
      );
  }
  await closeResources?.().catch(() => {});
  input?.close();
}
process.once("SIGINT", () => {
  void shutdown().finally(() => {
    process.exitCode = 130;
  });
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => {
    process.exitCode = 143;
  });
});

try {
  if (command === "start" && interactive) {
    if (!mode) {
      const choice = await question(
        "Mode: 1 = private rehearsal, 2 = public live [1]: ",
        "1",
      );
      if (!["", "1", "2"].includes(choice))
        fix("Unknown mode", "Choose 1 or 2.");
      mode = choice === "2" ? "live" : "rehearsal";
    }
    if (!runnerMode) {
      const choice = await question(
        "Agents: 1 = sandbox (Docker protection), 2 = native Mac terminals [1]: ",
        "1",
      );
      if (!["", "1", "2"].includes(choice))
        fix("Unknown runner", "Choose 1 or 2.");
      runnerMode = choice === "2" ? "native" : "docker";
    }
  }
  mode ??= command === "check" ? "live" : "rehearsal";
  if (runnerMode) process.env.ARENA_RUNNER = runnerMode;
  process.env.ARENA_MODE = mode;
  process.env.ARENA_SKIP_YOUTUBE = skipYoutube ? "1" : "0";
  process.env.ARENA_SKIP_TWITCH = skipTwitch ? "1" : "0";
  process.env.ARENA_SKIP_KICK = skipKick ? "1" : "0";
  const config = await import("../server/config.js");
  const { settings, secrets, housePrompts } = config;
  runnerMode = settings.runnerMode;
  if (settings.promptPlaylist) {
    if (!housePrompts.length)
      fix(
        `No tasks in ${settings.promptFile}`,
        "Add one prompt per line (comments start with #), or rerun with --no-prompts to use live chat.",
      );
    skipYoutube = true;
    skipTwitch = true;
    skipKick = true;
    process.env.ARENA_SKIP_YOUTUBE = "1";
    process.env.ARENA_SKIP_TWITCH = "1";
    process.env.ARENA_SKIP_KICK = "1";
    process.env.ARENA_PROMPTS = "1";
    console.log(
      `NOTE: Prompt list · ${housePrompts.length} tasks from ${settings.promptFile}. Chat skipped. Each configured session gets each task; the show ends after the last one.`,
    );
  }
  let twitchPending = true;
  if (!["127.0.0.1", "localhost"].includes(settings.host)) {
    fix(
      `The control server host is ${settings.host}`,
      "Set host to 127.0.0.1 in settings.json. The control panel and credentials must stay local.",
    );
  }
  console.log(
    `\nPrompt Arena — ${mode.toUpperCase()} / ${runnerMode.toUpperCase()} AGENTS\nPreviews always use isolated Docker. No coding jobs have started.`,
  );
  const origin = `http://${settings.host}:${settings.port}`;
  const { Store } = await import("../server/store.js");
  const { Docker } = await import("../server/docker.js");
  const { NativeHost } = await import("../server/native-host.js");
  const { CliRunner } = await import("../server/runner.js");
  const { BrowserSandbox } = await import("../server/browser-sandbox.js");
  const { Previews } = await import("../server/preview.js");
  const { Jev } = await import("../server/jev.js");
  const { Obs } = await import("../server/obs.js");
  const { credentialGuard } = await import("../server/redact.js");
  const privateValues = [
    secrets.jev,
    ...Object.values(secrets.youtube),
    ...Object.values(secrets.twitch),
    secrets.kick.access,
    secrets.kick.secret,
    secrets.obs,
  ];
  const clean = redactor(privateValues, root);
  safeMessage = clean;
  const store = new Store(":memory:");
  const docker = new Docker(store, { root, image: settings.agentImage });
  const host = runnerMode === "native" ? new NativeHost(store, root) : docker;
  const runner = new CliRunner(host, settings, clean);
  const obs = new Obs(
    settings.obsUrl,
    secrets.obs,
    true,
    () => {},
    () => {},
    () => {},
  );
  const resources: Array<() => Promise<void>> = [
    async () => store.close(),
    () => obs.close(),
  ];
  closeResources = async () => {
    for (const close of resources.reverse()) await close().catch(() => {});
  };
  const rootId = createHash("sha256").update(root).digest("hex");
  let configurationId = startupConfigurationId(settings);
  let existing = false;
  let existingConfigurationId: string | undefined;
  let state: any;
  try {
    const response = await fetch(`${origin}/api/state`, {
      signal: AbortSignal.timeout(1000),
    });
    if (response.ok) {
      state = await response.json();
      existing = true;
    }
  } catch {
    /* The start script can launch the app after checks. */
  }
  if (existing) {
    const response = await fetch(`${origin}/api/boot`, {
      signal: AbortSignal.timeout(1000),
    });
    const boot = response.ok ? ((await response.json()) as any) : {};
    existingConfigurationId = boot.configurationId;
    if (boot.rootId !== rootId)
      fix(
        "A different mode, older app, or another project is already on this port.",
        "Close its terminal process, then rerun this file. The script will not kill an unknown app.",
      );
    const newest = Math.max(
      await newestSource(resolve(root, "server")),
      await newestSource(resolve(root, "shared")),
      (await stat(resolve(root, "settings.json"))).mtimeMs,
      await stat(resolve(root, ".env.local"))
        .then((s) => s.mtimeMs)
        .catch(() => 0),
    );
    // Starting against an owned server is an explicit choice, including stale or active shows.
    if (command === "start") {
      if (newest > boot.startedAt)
        console.log("The running server predates local code/settings changes.");
      console.log(
        "Keep leaves the old server untouched. Restart stops active coding and may end an OBS broadcast managed by its old startup terminal.",
      );
      const choice = interactive
        ? await chooseExistingServer(question)
        : "keep";
      if (choice === "keep") {
        console.log(
          `Keeping the existing server: ${origin}/control. Requested startup changes were not applied.`,
        );
        await shutdown();
        process.exit(0);
      }
      console.log(
        "Waiting for the old server and its startup terminal to finish graceful shutdown…",
      );
      await stopExistingServer(
        root,
        settings.port,
        async () => {
          const response = await fetch(`${origin}/api/boot`, {
            signal: AbortSignal.timeout(1000),
          });
          const current = response.ok
            ? ((await response.json()) as typeof boot)
            : {};
          if (
            current.rootId !== rootId ||
            current.startedAt !== boot.startedAt ||
            current.configurationId !== boot.configurationId
          )
            throw new Error("The running server changed");
        },
        () => stopping,
      );
      existing = false;
      existingConfigurationId = undefined;
      state = undefined;
      console.log("Old server stopped. Continuing normal startup checks.");
    }
    if (existing && newest > boot.startedAt)
      fix(
        "The running app has older code/settings/credentials.",
        "Close it and rerun start_stream.sh to load your changes.",
      );
    if (
      existing &&
      (!["paused", "stopped"].includes(state.status) ||
        Object.values(state.round?.attempts ?? {}).some((a: any) =>
          ["running", "validating"].includes(a.status),
        ))
    )
      fix(
        "The show is already active.",
        "Use its control panel to Pause and let current work finish, or Stop. Then rerun this file.",
      );
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
  await repair(
    "built overlay",
    async () => {
      const built = await stat(resolve(root, "dist/index.html"));
      if (
        Math.max(
          await newestSource(resolve(root, "web")),
          await newestSource(resolve(root, "shared")),
        ) > built.mtimeMs
      )
        throw new Error("The overlay build is older than its source");
    },
    "Run npm run build.",
    () => run("npm", ["run", "build"]),
  );
  await repair(
    "break music and visual",
    async () => {
      for (const file of [settings.musicPath, settings.visualPath]) {
        await access(file);
        if (!(await stat(file)).isFile())
          throw new Error("A configured media path is not a file");
      }
    },
    "Set musicPath and visualPath in settings.json to your existing MP3 and HTML files.",
  );
  if (mode === "live") {
    const { missingLiveSecrets, twitchStatus, ensureYoutubeLiveChatId } =
      await import("../server/live-platforms.js");
    // KICK_CLIENT_ID + KICK_CLIENT_SECRET replace KICK_ACCESS_TOKEN: the server
    // mints the app token itself, so only check the static token without them.
    const kickClientCredentials = !!(
      secrets.kick.client.trim() && secrets.kick.secret.trim()
    );
    const missing = missingLiveSecrets(
      kickClientCredentials
        ? { ...secrets, kick: { ...secrets.kick, access: "client-credentials" } }
        : secrets,
    );
    if (missing.length)
      fix(
        `Missing private fields: ${missing.join(", ")}`,
        twitchStatus().kind === "partial"
          ? "Fill the remaining Twitch names, or leave every Twitch field empty to skip Twitch. Edit .env.local in your editor. Do not paste credentials into chat or command-line arguments."
          : "Fill those names in .env.local using your editor, then rerun. Do not paste credentials into chat or command-line arguments.",
      );
    if (!skipYoutube && !secrets.youtube.chat.trim()) {
      console.log(
        "YouTube live chat ID is empty; looking up the current broadcast…",
      );
      try {
        const id = await ensureYoutubeLiveChatId();
        console.log(`OK: using YouTube live chat ID ${id}`);
      } catch (error) {
        fix(
          error instanceof Error
            ? error.message
            : "YouTube live chat lookup failed",
          "Create or schedule a livestream in YouTube Studio so a liveChatId exists, then rerun. Do not paste tokens into chat.",
        );
      }
    } else if (skipYoutube)
      console.log("NOTE: YouTube chat skipped (--skip yt).");
    if (skipTwitch) {
      twitchPending = false;
      console.log("NOTE: Twitch chat skipped (--skip twitch).");
    } else if (twitchStatus().kind === "off") {
      twitchPending = false;
      console.log(
        "NOTE: Twitch is skipped because its .env.local fields are empty.",
      );
    }
    if (skipKick) console.log("NOTE: Kick chat skipped (--skip kick).");
    else {
      let webhook: URL;
      try {
        webhook = new URL(settings.kickWebhookUrl);
      } catch {
        fix(
          "Kick webhook URL is missing or invalid",
          "Set kickWebhookUrl in settings.json to your registered public HTTPS /kick endpoint, or rerun with --skip kick.",
        );
      }
      if (
        webhook!.protocol !== "https:" ||
        webhook!.pathname !== "/kick" ||
        ["localhost", "127.0.0.1", "[::1]"].includes(webhook!.hostname) ||
        webhook!.username ||
        webhook!.password
      )
        fix(
          "Kick webhook URL is not a public HTTPS /kick endpoint",
          "Register the correct HTTPS /kick URL in Kick developer settings and settings.json; tunnel only port 3212 (or your webhookPort). Or rerun with --skip kick.",
        );
    }
    if (!settings.stopObsOnEnd)
      fix(
        "Automatic OBS shutdown is disabled",
        "Set stopObsOnEnd to true in settings.json.",
      );
    const isRehearsed = (saved: any) =>
      saved?.rehearsalComplete === true &&
      (saved.rehearsalRunnerMode ?? "docker") === runnerMode;
    let rehearsed = isRehearsed(state);
    if (!rehearsed) {
      let saved: DatabaseSync | undefined;
      try {
        saved = new DatabaseSync(resolve(root, "runtime/show.sqlite"), {
          readOnly: true,
        });
        const row = saved
          .prepare("SELECT value FROM state WHERE id=1")
          .get() as any;
        rehearsed = row && isRehearsed(JSON.parse(row.value));
      } catch {
        /* No completed rehearsal yet. */
      } finally {
        saved?.close();
      }
    }
    if (!rehearsed && !settings.promptPlaylist)
      fix(
        "Private OBS rehearsal has not been confirmed for this runner mode",
        `Run ./start_stream.sh --mode rehearsal --runner ${runnerMode}, finish one round, check your private recording, and confirm the rehearsal in /control.`,
      );
  }
  if (
    command === "start" &&
    interactive &&
    !singleAgent &&
    !requestedSessions.length &&
    !existing
  ) {
    const selected = await chooseSessions(
      question,
      (cli) => runner.discover(cli),
      (line) => console.log(clean(line)),
    );
    if (selected)
      Object.assign(settings, selectStartupSessions(settings, selected, root));
  }
  // Send the same normalized startup contract that the child parses.
  Object.assign(settings, normalizeStartup(settings, root));
  process.env.ARENA_SESSIONS = JSON.stringify(settings.sessions);
  configurationId = startupConfigurationId(settings);
  if (existing && existingConfigurationId !== configurationId)
    fix(
      "The running app has different session or startup choices.",
      "Close its terminal and start again with the intended choices.",
    );
  await repair(
    "CLI subscription logins, requested models and stream formats",
    async () => {
      for (const line of await runner.preflight())
        console.log(`  ${clean(line)}`);
    },
    (error) => cliStartupAdvice(error, runnerMode!),
    async (error) => {
      const known = failedLoginAgent(error) ?? singleAgent;
      const choice = known
        ? undefined
        : await question(
            "Which login needs fixing? 1 = Codex, 2 = Cursor [cancel]: ",
          );
      const agent =
        known ??
        (choice === "1" ? "codex" : choice === "2" ? "cursor" : undefined);
      if (agent !== "codex" && agent !== "cursor")
        throw new Error("Login repair cancelled");
      if (known) console.log(`Running ${agent} login repair…`);
      const login = cliLoginCommand(agent, runnerMode!);
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
      const ready = await obs.readiness(`${origin}/overlay`);
      if (!ready.overlayConfigured)
        throw new Error("No OBS Browser Source uses this app overlay");
    },
    `Open OBS, enable Tools → WebSocket Server Settings, add OBS_PASSWORD privately, and add ${origin}/overlay as a Browser Source (1920 × 1080).`,
  );
  await repair(
    "actual isolated HTML rendering",
    async () => {
      const tempRoot = resolve(root, "runtime/readiness", randomUUID());
      const port = await freePort();
      const apiPort = await freePort();
      const engine = new BrowserSandbox(
        docker,
        tempRoot,
        settings.previewImage,
        port,
      );
      const previews = new Previews(
        tempRoot,
        `http://127.0.0.1:${apiPort}`,
        settings.visualPath,
        () => engine.start(),
        credentialGuard(privateValues),
        settings.previewView,
      );
      try {
        await mkdir(resolve(tempRoot, "main/codex"), {
          recursive: true,
          mode: 0o700,
        });
        const { writeFile } = await import("node:fs/promises");
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
  if (
    verify ||
    (command === "check" &&
      interactive &&
      (await yes(
        "Also run type checks, tests, fixture replay and rebuild now?",
      )))
  ) {
    for (const script of ["check", "test", "replay", "build"])
      await run("npm", ["run", script]);
    if (runnerMode === "docker")
      await run("node_modules/.bin/tsx", ["--test", "tests/sandbox.test.ts"], {
        ...toolEnv,
        STRAM_SANDBOX_TEST: "1",
      } as typeof toolEnv);
    console.log("OK: requested automated verification completed");
  } else
    console.log(
      "NOTE: tests/type checks were not run. Use --verify for them; a successful rehearsal still needs host confirmation.",
    );
  const pendingChats = [
    ...(skipYoutube ? [] : ["YouTube"]),
    ...(twitchPending ? ["Twitch"] : []),
    ...(skipKick ? [] : ["Kick"]),
  ];
  console.log(
    `\nREADY: ${mode} prerequisites passed.\nControl: ${origin}/control\nOverlay: ${origin}/overlay\nPending live-only check: ${
      pendingChats.length
        ? `actual ${pendingChats.join("/")} chat after broadcasting starts.`
        : "no chat platforms; live rounds can still run from a surprise task after collection waits."
    }`,
  );
  if (command === "check") {
    await shutdown();
  } else {
    if (runnerMode === "native") {
      console.log(
        "\nNATIVE WARNING: Codex/Cursor terminal commands can read and change files on your Mac, outside the project. Process-group cancellation cannot contain commands that deliberately escape it. Previews remain protected in Docker.",
      );
      if (
        (await question(
          "Type NATIVE to allow unprotected agent terminal commands: ",
        )) !== "NATIVE"
      )
        fix(
          "Native mode was not confirmed",
          "Use Docker mode, or rerun and explicitly confirm NATIVE.",
        );
    }
    if (
      mode === "live" &&
      (!interactive ||
        !(await yes(
          skipKick
            ? "Is the overlay visible in your intended OBS scene, with rehearsal audio checked?"
            : "Is the overlay visible in your intended OBS scene, with rehearsal audio checked, and is Kick configured to forward only its webhook port?",
        )))
    )
      fix(
        "Host scene/webhook checks are not confirmed",
        "Check your OBS scene/audio and Kick developer configuration, then rerun interactively.",
      );
    if (!existing) {
      if (stopping) throw new Error("Cancelled");
      app = spawn("npm", ["run", "dev"], {
        cwd: root,
        detached: true,
        stdio: ["ignore", "inherit", "inherit"],
        env: {
          ...process.env,
          ARENA_MODE: mode,
          ARENA_RUNNER: runnerMode,
          ARENA_SINGLE_AGENT: singleAgent ?? "",
          ARENA_NATIVE_APPROVED: runnerMode === "native" ? "1" : "0",
          ARENA_SKIP_YOUTUBE: skipYoutube ? "1" : "0",
          ARENA_SKIP_TWITCH: skipTwitch ? "1" : "0",
          ARENA_SKIP_KICK: skipKick ? "1" : "0",
          ARENA_PROMPTS: settings.promptPlaylist ? "1" : "0",
          ARENA_NO_PROMPTS: ignorePrompts ? "1" : "0",
        },
      });
      appExit = new Promise((done) => {
        app!.once("error", () => done(1));
        app!.once("close", done);
      });
      const until = Date.now() + 20000;
      let ready = false;
      while (!ready && Date.now() < until) {
        if (app.exitCode !== null)
          fix(
            "App exited during startup",
            "Fix the startup error shown above.",
          );
        try {
          const response = await fetch(`${origin}/api/boot`, {
            signal: AbortSignal.timeout(500),
          });
          const boot = (await response.json()) as any;
          ready =
            boot.rootId === rootId && boot.configurationId === configurationId;
        } catch {}
        if (!ready) await new Promise((r) => setTimeout(r, 250));
      }
      if (!ready)
        fix(
          "App did not confirm readiness",
          "Check port conflicts and the app startup messages.",
        );
      // /api/boot can respond while restart recovery is still settling.
      const recoveryUntil = Date.now() + 45000;
      let recovered = false;
      while (Date.now() < recoveryUntil && !recovered) {
        const response = await fetch(`${origin}/api/state`, {
          signal: AbortSignal.timeout(2000),
        });
        const current = (await response.json()) as any;
        recovered =
          current.status === "paused" &&
          current.reason === "Paused. Runner recovery completed.";
        if (/could not confirm|Docker is not ready/i.test(current.reason))
          fix(
            clean(current.reason),
            "Resolve process recovery or Docker errors before starting a round.",
          );
        if (!recovered) await new Promise((r) => setTimeout(r, 250));
      }
      if (!recovered)
        fix(
          "App recovery did not finish",
          "Check the control panel; no round will be started by this script.",
        );
    } else if (runnerMode === "native")
      fix(
        "An existing app cannot inherit this new native confirmation",
        "Close its terminal and rerun this file so consent applies to the correct process.",
      );
    let startedBroadcast = false;
    let showStarted = false;
    async function action(actionName: string, text?: string) {
      const hostResponse = await fetch(`${origin}/api/host`, {
        signal: AbortSignal.timeout(2000),
      });
      const { csrf } = (await hostResponse.json()) as any;
      const cookie =
        hostResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
      const response = await fetch(`${origin}/api/action`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Host-Token": csrf,
          Cookie: cookie,
        },
        body: JSON.stringify({ action: actionName, ...(text ? { text } : {}) }),
        signal: AbortSignal.timeout(180000),
      });
      const result = (await response.json()) as any;
      if (!response.ok)
        throw new Error(clean(String(result.error ?? "Host action failed")));
      return (await (await fetch(`${origin}/api/state`)).json()) as any;
    }
    closeShow = async () => {
      if (showStarted) {
        try {
          await action("stop");
        } catch {
          if (mode === "live") await obs.stop();
        }
      } else if (startedBroadcast) await obs.stop();
    };
    if (mode === "live") {
      if (
        !(await yes(
          settings.promptPlaylist
            ? "Start/continue the PUBLIC OBS broadcast and the prompt list now?"
            : "Start/continue the PUBLIC OBS broadcast and automatic audience rounds now?",
        ))
      )
        fix(
          "Public start cancelled",
          "The app remains paused. Run the start file when ready.",
        );
      startedBroadcast = !(await obs.streaming());
      if (startedBroadcast) await obs.start();
      const liveState = await action("start");
      if (!["collecting", "running", "results"].includes(liveState.status))
        fix(
          clean(liveState.reason || "Live startup failed"),
          "Resolve the reported connection/authentication issue and rerun. A broadcast started by this file will be stopped.",
        );
      showStarted = true;
      console.log(
        settings.promptPlaylist
          ? `\nLIVE: prompt list ${housePrompts.length} tasks. OBS overlay only; chat is skipped. The show ends after the last prompt.`
          : "\nLIVE: controller confirmed chat startup and enabled rounds. Confirm a real signed Kick message appears in /control.",
      );
    } else if (settings.promptPlaylist) {
      if (
        await yes(
          `Start the prompt list now? ${housePrompts.length} tasks go to ${configuredSessions(
            settings,
          )
            .map((s) => `${s.cli}/${s.model}`)
            .join(" and ")}, then the show ends.`,
        )
      ) {
        const privateState = await action("start");
        if (!["collecting", "running", "results"].includes(privateState.status))
          fix(
            clean(privateState.reason || "Prompt list startup failed"),
            "Fix the reported issue and rerun.",
          );
        showStarted = true;
        console.log(
          `PRIVATE: prompt list ${housePrompts.length} tasks from ${settings.promptFile}. Edit that file for the next stream.`,
        );
      }
    } else if (await yes("Start one PRIVATE rehearsal round now?")) {
      let rehearsalTask: string;
      do {
        rehearsalTask = await question(
          `Rehearsal task [${settings.jevProbe}]: `,
          settings.jevProbe,
        );
        if (rehearsalTask.length < 10)
          console.warn(
            "WARNING: Rehearsal task is too short. Enter at least 10 characters; please try again. Ctrl+C cancels.",
          );
      } while (rehearsalTask.length < 10);
      const privateState = await action("start");
      if (!["collecting", "running", "results"].includes(privateState.status))
        fix(
          clean(privateState.reason || "Rehearsal startup failed"),
          "Fix the reported issue and rerun.",
        );
      showStarted = true;
      await action("rehearsal-task", rehearsalTask);
      console.log(
        `PRIVATE: record OBS locally, inspect ${configuredSessions(settings).length === 1 ? "the session result" : "both session results"}, and confirm the rehearsal in /control.`,
      );
    }
    console.log(
      `\nOpen ${origin}/control. This terminal stays open. Ctrl+C ends the show and stops an OBS broadcast controlled by this session.`,
    );
    input?.close();
    if (appExit) {
      const code = await appExit;
      if (!stopping && code !== 0)
        throw new Error(
          "The app exited unexpectedly; inspect OBS and stop any remaining native processes.",
        );
    } else
      await new Promise<void>((done) => {
        process.once("SIGINT", done);
        process.once("SIGTERM", done);
      });
    await shutdown();
  }
} catch (error) {
  // Do not dump exception stacks, subprocess output, cookies, CLI account info or secret values.
  if (!stopping) {
    console.error(
      `\nERROR: ${safeMessage(error instanceof Error ? error.message : "Startup failed")}\nstopping....`,
    );
    process.exitCode = 1;
  }
  await shutdown();
}

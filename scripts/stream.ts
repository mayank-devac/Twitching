// Guided launcher entry point: parses flags, then walks the startup checklist in order (see scripts/stream/).
import {
  normalizeStartup,
  selectStartupSessions,
  startupConfigurationId,
} from "../server/startup-config.js";
import { redactor } from "../server/redact.js";
import { controlOrigin } from "../shared/boot.js";
import { rootIdentity } from "./boot-client.js";
import { chooseSessions } from "./session-selection.js";
import { inspectExistingApp } from "./stream/existing-app.js";
import { checkLivePreflight } from "./stream/live-preflight.js";
import { exportChatSkips, parseStreamOptions } from "./stream/options.js";
import { checkLocalSetup, checkServices } from "./stream/prerequisites.js";
import {
  fix,
  installSignalHandlers,
  launcher,
  openPrompt,
  question,
  root,
  shutdown,
} from "./stream/runtime.js";
import { checkSandbox } from "./stream/sandbox.js";
import { startShow } from "./stream/show.js";
import { maybeVerify } from "./stream/verify.js";

const args = process.argv.slice(2);
const command = args.shift();
// Flags retain the guided arena flow; no flags opens the idle local welcome UI.
if (command === "start" && args.length === 0) {
  await import("./welcome-launcher.js");
  await new Promise(() => {});
}
process.env.ARENA_EXPERIENCE = "arena";
const options = parseStreamOptions(command, args);
openPrompt(options.interactive);
installSignalHandlers();

try {
  if (options.command === "start" && options.interactive) {
    if (!options.mode) {
      const choice = await question(
        "Mode: 1 = private rehearsal, 2 = public live [1]: ",
        "1",
      );
      if (!["", "1", "2"].includes(choice))
        fix("Unknown mode", "Choose 1 or 2.");
      options.mode = choice === "2" ? "live" : "rehearsal";
    }
    if (!options.runnerMode) {
      const choice = await question(
        "Agents: 1 = sandbox (Docker protection), 2 = native Mac terminals [1]: ",
        "1",
      );
      if (!["", "1", "2"].includes(choice))
        fix("Unknown runner", "Choose 1 or 2.");
      options.runnerMode = choice === "2" ? "native" : "docker";
    }
  }
  const mode = (options.mode ??=
    options.command === "check" ? "live" : "rehearsal");
  if (options.runnerMode) process.env.ARENA_RUNNER = options.runnerMode;
  process.env.ARENA_MODE = mode;
  exportChatSkips(options);
  // Loaded only now: server config reads the ARENA_* env prepared above.
  const { settings, secrets, housePrompts } = await import(
    "../server/config.js"
  );
  const runnerMode = settings.runnerMode;
  options.runnerMode = runnerMode;
  if (settings.promptPlaylist) {
    if (!housePrompts.length)
      fix(
        `No tasks in ${settings.promptFile}`,
        "Add one prompt per line (comments start with #), or rerun with --no-prompts to use live chat.",
      );
    options.skipYoutube = true;
    options.skipTwitch = true;
    options.skipKick = true;
    exportChatSkips(options);
    process.env.ARENA_PROMPTS = "1";
    console.log(
      `NOTE: Prompt list · ${housePrompts.length} tasks from ${settings.promptFile}. Chat skipped. Each configured session gets each task; the show ends after the last one.`,
    );
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(settings.host)) {
    fix(
      `The control server host is ${settings.host}`,
      "Set host to 127.0.0.1 in settings.json. The control panel and credentials must stay local.",
    );
  }
  console.log(
    `\nPrompt Arena — ${mode.toUpperCase()} / ${runnerMode.toUpperCase()} AGENTS\nPreviews always use isolated Docker. No coding jobs have started.`,
  );
  const origin = controlOrigin(settings.host, settings.port);
  const { Store } = await import("../server/store.js");
  const { Docker } = await import("../server/docker.js");
  const { NativeHost } = await import("../server/native-host.js");
  const { CliRunner } = await import("../server/runner.js");
  const { Obs } = await import("../server/obs.js");
  const privateValues = [
    secrets.jev,
    ...Object.values(secrets.youtube),
    ...Object.values(secrets.twitch),
    secrets.kick.access,
    secrets.kick.secret,
    secrets.obs,
  ];
  const clean = redactor(privateValues, root);
  launcher.safeMessage = clean;
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
  launcher.closeResources = async () => {
    for (const close of resources.reverse()) await close().catch(() => {});
  };
  const rootId = rootIdentity(root);
  const running = await inspectExistingApp(
    options,
    origin,
    rootId,
    settings.port,
  );
  const existing = running.existing;
  await checkSandbox(docker, settings, runnerMode);
  await checkLocalSetup(settings, existing);
  const twitchPending =
    mode === "live"
      ? await checkLivePreflight(
          options,
          settings,
          secrets,
          runnerMode,
          running.state,
        )
      : true;
  if (
    options.command === "start" &&
    options.interactive &&
    !options.singleAgent &&
    !options.requestedSessions.length &&
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
  const configurationId = startupConfigurationId(settings);
  if (existing && running.configurationId !== configurationId)
    fix(
      "The running app has different session or startup choices.",
      "Close its terminal and start again with the intended choices.",
    );
  await checkServices({
    settings,
    secrets,
    runnerMode,
    singleAgent: options.singleAgent,
    runner,
    docker,
    obs,
    origin,
    clean,
    privateValues,
  });
  await maybeVerify(options, runnerMode);
  const pendingChats = [
    ...(options.skipYoutube ? [] : ["YouTube"]),
    ...(twitchPending ? ["Twitch"] : []),
    ...(options.skipKick ? [] : ["Kick"]),
  ];
  console.log(
    `\nREADY: ${mode} prerequisites passed.\nControl: ${origin}/control\nOverlay: ${origin}/overlay\nPending live-only check: ${
      pendingChats.length
        ? `actual ${pendingChats.join("/")} chat after broadcasting starts.`
        : "no chat platforms; live rounds can still run from a surprise task after collection waits."
    }`,
  );
  if (options.command === "check") {
    await shutdown();
  } else {
    await startShow({
      options,
      mode,
      runnerMode,
      settings,
      housePrompts,
      origin,
      rootId,
      configurationId,
      existing,
      obs,
      clean,
    });
  }
} catch (error) {
  // Do not dump exception stacks, subprocess output, cookies, CLI account info or secret values.
  if (!launcher.stopping) {
    console.error(
      `\nERROR: ${launcher.safeMessage(error instanceof Error ? error.message : "Startup failed")}\nstopping....`,
    );
    process.exitCode = 1;
  }
  await shutdown();
}

// Guided launcher entry point: parses flags, then walks the startup checklist in order (see scripts/stream/).
import {
  normalizeStartup,
  selectStartupSessions,
  startupConfigurationId,
} from "../server/startup-config.js";
import { createRedactor } from "../server/secrets.js";
import { controlOrigin } from "../shared/boot.js";
import { rootIdentity } from "./boot-client.js";
import { chooseSessions } from "./session-selection.js";
import { inspectExistingApp } from "./stream/existing-app.js";
import { checkLivePreflight } from "./stream/live-preflight.js";
import { exportChatSkips, parseStreamOptions } from "./stream/options.js";
import { skipRecord } from "../server/chat-skips.js";
import { CHAT_PLATFORMS, chatPlatformLabels } from "../shared/settings.js";
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
// --chats only turns the chat feed on, so it must not count as a guided-flow flag below.
// The server (or the launcher's child server) reads TWITCHING_CHATS from this env.
const chatsFlag = args.indexOf("--chats");
if (chatsFlag !== -1) {
  args.splice(chatsFlag, 1);
  process.env.TWITCHING_CHATS = "1";
}
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
    options.skips = skipRecord(true);
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
    `\nPrompt Arena — ${mode.toUpperCase()} / ${runnerMode.toUpperCase()} AGENTS\nPreviews use isolated Docker unless native agents opt into direct preview. No coding jobs have started.`,
  );
  const origin = controlOrigin(settings.host, settings.port);
  const { Store } = await import("../server/store.js");
  const { Docker } = await import("../server/docker.js");
  const { NativeHost } = await import("../server/native-host.js");
  const { CliRunner } = await import("../server/runner.js");
  const { Obs } = await import("../server/obs.js");
  const { clean, privateValues } = createRedactor(secrets, root);
  launcher.safeMessage = clean;
  const store = new Store(":memory:");
  const docker = new Docker(store, { root, image: settings.agentImage });
  const native = new NativeHost(store, root);
  const host = runnerMode === "native" ? native : docker;
  const runner = new CliRunner(host, settings, clean, undefined, { docker, native });
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
  if (options.directPreview && runnerMode !== "native")
    fix("--direct-preview needs native agents", "Add --runner native, or drop --direct-preview. Docker agents always use the isolated Docker preview.");
  const directPreview = await checkSandbox(docker, settings, runnerMode, options.directPreview);
  // The server child inherits this; it overrides the saved Quick Settings toggle for this run only.
  if (directPreview) process.env.ARENA_DIRECT_PREVIEW = "1";
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
    directPreview,
  });
  await maybeVerify(options, runnerMode);
  const pendingChats = [
    ...CHAT_PLATFORMS.filter(
      (platform) => platform !== "twitch" && !options.skips[platform],
    ).map((platform) => chatPlatformLabels[platform]),
    ...(twitchPending ? [chatPlatformLabels.twitch] : []),
  ];
  console.log(
    `\nREADY: ${mode} prerequisites passed.\nControl: ${origin}/control\nOverlay: ${origin}/overlay\n${
      process.env.TWITCHING_CHATS === "1"
        ? `All chats (OBS): ${origin}/chat\nPrompts only (OBS): ${origin}/chats/prompts`
        : "Chat feed: off (add --chats to enable)"
    }\nPending live-only check: ${
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

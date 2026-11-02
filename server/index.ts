import { PresentationControls } from "./presentation-controls.js";
import { startupConfigurationId } from "./startup-config.js";
import { QuickSettings, defaultCriteria } from "./quick-settings.js";
import { BreakMedia } from "./break-media.js";
import { defaultVisibility } from "../shared/settings.js";
import { enabledFromSkips, skipEnvKey, skipRecord } from "./chat-skips.js";
import { CHAT_PLATFORMS } from "../shared/settings.js";
import type { ChatPlatform, QuickPreferences } from "../shared/settings.js";
import { configuredSessions } from "../shared/types.js";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { settings, root, secrets, housePrompts } from "./config.js";
import { Store } from "./store.js";
import { credentialGuard } from "./redact.js";
import { createRedactor } from "./secrets.js";
import { readClaudeToken } from "./claude-profile.js";
import { Docker } from "./docker.js";
import { CliRunner } from "./runner.js";
import { Previews } from "./preview.js";
import { Filter } from "./filter.js";
import { ChatFeed } from "./chat-feed.js";
import { fakeChat } from "./chat-sim.js";
import { missingLiveSecrets, twitchStatus } from "./live-platforms.js";
import { Jev } from "./jev.js";
import {
  Controller,
  roundSessionCount,
  type ChatPlatforms,
} from "./controller.js";
import {
  YouTubeChat,
  TwitchChat,
  KickChat,
  KickToken,
  startChatSources,
  stopChatSources,
} from "./chat.js";
import { Obs } from "./obs.js";
import { makeHttp, urlHost } from "./http.js";
import { BrowserSandbox } from "./browser-sandbox.js";
import { NativeHost } from "./native-host.js";
import { Sessions } from "./sessions/service.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
await mkdir(resolve(root, "runtime"), { recursive: true, mode: 0o700 });
if (
  settings.experience === "arena" &&
  settings.promptPlaylist &&
  housePrompts.length === 0
)
  throw new Error(
    `No tasks in ${settings.promptFile}. Add one prompt per line, or set ARENA_NO_PROMPTS=1 to use live chat.`,
  );
// An exclusive local lock prevents two controllers from driving the same show.
const { open, unlink, readFile, rename, link } =
  await import("node:fs/promises");
const lockPath = resolve(root, "runtime/controller.lock");
const runningError = () =>
  new Error(
    "Another controller is running. Close it before starting this one.",
  );
const createLock = async () => {
  const handle = await open(lockPath, "wx", 0o600);
  await handle.writeFile(String(process.pid));
  await handle.close();
};
try {
  await createLock();
} catch {
  const pid = Number(await readFile(lockPath, "utf8"));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
  }
  if (alive) throw runningError();
  // Two starts can both see the same stale lock. Renaming is atomic, so only
  // one of them moves it aside; the other's rename fails and it backs off.
  const aside = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, aside);
  } catch {
    throw runningError();
  }
  // A slower racer may have renamed a fresh lock that a faster one just
  // created; put it back (link fails if a lock already exists) and back off.
  if (Number(await readFile(aside, "utf8")) !== pid) {
    await link(aside, lockPath).catch(() => {});
    await unlink(aside).catch(() => {});
    throw runningError();
  }
  await unlink(aside);
  try {
    await createLock();
  } catch {
    throw runningError();
  }
}
const bootConfigurationId = startupConfigurationId(settings);
const store = new Store(resolve(root, "runtime/show.sqlite"));
// Append-only tables are trimmed at startup and hourly; see Store.prune.
const pruneStore = () => {
  try {
    store.prune();
  } catch (error) {
    console.error(
      `Database pruning failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
pruneStore();
const pruneTimer = setInterval(pruneStore, 60 * 60 * 1000);
pruneTimer.unref();
// Durable web preferences overlay safe operational fields; process-only execution stays unchanged.
const preferences = new QuickSettings(
  store,
  {
    sessions: configuredSessions(settings),
    visibility: Object.fromEntries(
      configuredSessions(settings).map((s) => [s.id, { ...defaultVisibility }]),
    ),
    stream: {
      mode: settings.mode,
      ...enabledFromSkips(settings.skips),
      collectionMs: settings.collectionMs,
      extensionMs: settings.extensionMs,
      resultMs: settings.resultMs,
    },
    jevCriteria: defaultCriteria,
    jevProbe: settings.jevProbe,
    directPreview: false,
    media: { visualFit: "fit" },
  },
  {
    // The launcher sets this only when the host chose (or declined) direct preview for this run.
    directPreview:
      process.env.ARENA_DIRECT_PREVIEW === undefined
        ? undefined
        : process.env.ARENA_DIRECT_PREVIEW === "1",
    platforms: CHAT_PLATFORMS.some(
      (platform) => process.env[skipEnvKey(platform)] !== undefined,
    )
      ? enabledFromSkips(settings.skips)
      : undefined,
    mode: process.env.ARENA_MODE ? settings.mode : undefined,
    sessions:
      process.env.ARENA_SESSIONS || process.env.ARENA_SINGLE_AGENT
        ? configuredSessions(settings)
        : undefined,
  },
);
const applyPreferences = (value: QuickPreferences) => {
  settings.sessions = structuredClone(value.sessions);
  settings.mode = value.stream.mode;
  for (const platform of CHAT_PLATFORMS)
    settings.skips[platform] = !value.stream[platform];
  settings.collectionMs = value.stream.collectionMs;
  settings.extensionMs = value.stream.extensionMs;
  settings.resultMs = value.stream.resultMs;
  settings.jevProbe = value.jevProbe;
};
applyPreferences(preferences.get().value);
const media = new BreakMedia(root, store);
const kickToken = new KickToken(secrets.kick);
// The Kick app token is minted at runtime; createRedactor hides every token it has seen.
// The saved Claude token is hidden by value too, not only by its sk- shape.
// A token saved after startup is still caught by the shape check.
const claudeToken = await readClaudeToken(root).catch(() => undefined);
const { clean, privateValues } = createRedactor(
  secrets,
  root,
  () => kickToken.current(),
  [claudeToken],
);
const presentation = new PresentationControls(store, clean);
// Persist running elapsed time periodically; a restart restores the last checkpoint paused.
const presentationCheckpoint = setInterval(() => {
  if (!presentation.hasRunningClock()) return;
  try {
    presentation.checkpoint();
  } catch {
    console.error(
      "Stopwatch checkpoint could not be saved; check available disk space.",
    );
  }
}, 1000);
presentationCheckpoint.unref();
const docker = new Docker(store, { root, image: settings.agentImage });
const native = new NativeHost(store, root);
const runnerHost = settings.runnerMode === "native" ? native : docker;
const runner = new CliRunner(runnerHost, settings, clean, undefined, {
  docker,
  native,
});
const browserSandbox = new BrowserSandbox(
  docker,
  root,
  settings.previewImage,
  settings.browserPort,
);
const preview = new Previews(
  root,
  `http://${urlHost(settings.host)}:${settings.previewPort}`,
  settings.visualPath,
  () => browserSandbox.start(),
  credentialGuard(privateValues),
  settings.previewView,
);
// Direct preview skips the Docker browser; only native agents may use it, and the saved toggle applies at once.
// A per-session native runner counts only when every session is native, so a Docker agent's page never skips the sandbox.
// Both the running sessions and the saved ones (applied next round) must be native.
preview.direct = () => {
  const saved = preferences.get().value;
  return (
    [...configuredSessions(settings), ...saved.sessions].every(
      (s) => (s.runner ?? settings.runnerMode) === "native",
    ) && saved.directPreview
  );
};
preview.publicHidden = () => {
  const p = presentation.get("default");
  return p.hidden || !!p.breakActive;
};
const previewServer = preview.app().listen(settings.previewPort, settings.host);
let controller: Controller;
let sessionService: Sessions | undefined;
const failureText = (error: unknown) =>
  clean(error instanceof Error ? error.message : String(error), 300);
// Last resort: Node 24 exits on an unhandled rejection, which would drop a live
// show mid-round. Log a redacted reason and pause new rounds instead.
process.on("unhandledRejection", (error) => {
  console.error(`Unhandled controller error: ${failureText(error)}`);
  try {
    controller?.pause(
      "Unexpected controller error. Check the host log before resuming.",
    );
  } catch {
    console.error("Show could not be paused after an unexpected error.");
  }
});
const connection = (platform: string, status: string, fatal = false) => {
  if (platform === "obs" && status === "Disconnected")
    sessionService?.obsDisconnected();
  controller?.connection(platform, status, fatal);
};
const chatFeed = new ChatFeed(
  new Filter(settings.blockedWords),
  () => new Set(controller?.state.candidates.map((c) => c.message.id) ?? []),
);
// Off unless the launcher got --chats (it sets TWITCHING_CHATS=1). The host can still toggle it later.
if (process.env.TWITCHING_CHATS === "1") chatFeed.update({ enabled: true });
// Developer-only: TWITCHING_FAKE_CHAT=1 feeds fake viewers into the chat feed (never the
// arena) while the show is in private rehearsal, to test /chat and /chats/prompts.
// There is deliberately no UI or HTTP route for this.
if (process.env.TWITCHING_FAKE_CHAT === "1")
  setInterval(() => {
    if (controller?.state.mode !== "rehearsal") return;
    for (const message of fakeChat(settings.blockedWords[0]))
      chatFeed.add(message);
  }, 1500).unref();
const receive = (message: Parameters<Controller["ingest"]>[0]) => {
  // The feed sees every comment, including those the arena ignores while stopped.
  chatFeed.add(message);
  void controller.ingest(message).catch((error) => {
    console.error(`Chat message handling failed: ${failureText(error)}`);
    controller.pause(
      "Chat message handling failed. Check the host before resuming.",
    );
  });
};
const since = () => controller.collection.openedAt;
const youtube = new YouTubeChat(
  secrets.youtube,
  store,
  receive,
  connection,
  since,
);
const twitch = new TwitchChat(secrets.twitch, receive, connection);
const kick = new KickChat(
  secrets.kick,
  settings.webhookPort,
  settings.kickListenHost,
  settings.kickWebhookUrl,
  store,
  receive,
  connection,
  since,
  kickToken,
);
const obs = new Obs(
  settings.obsUrl,
  secrets.obs,
  settings.stopObsOnEnd,
  (status) => connection("obs", status),
  () => {
    sessionService?.obsDisconnected();
    if (
      controller?.state.mode === "live" &&
      controller.state.status !== "stopped"
    )
      void controller.stop("Host ended the OBS broadcast", false);
  },
  (active) => controller?.setReconnecting(active),
);
const chatSources = { youtube, twitch, kick };
const startSelectedChats = (
  platforms: Partial<Record<ChatPlatform, boolean>>,
) =>
  startChatSources(
    chatSources,
    platforms,
    () => controller.state.connections,
    connection,
  );
const integrations = {
  async preflight() {
    await preview.ready();
    await access(settings.musicPath);
    await access(settings.visualPath);
    const checks = [
      preview.direct()
        ? "Direct preview (no Docker): pages run in the browser without isolation"
        : "Restricted Chromium preview ready",
      "Break music and visual are readable",
    ];
    if (settings.mode === "live") {
      if (!secrets.jev) throw new Error("TypeSafe API key is missing");
      if (!settings.stopObsOnEnd)
        throw new Error("Enable stopObsOnEnd for automatic public rounds");
      // Startup probe uses the saved text; mandatory safety questions remain fixed.
      const probe = new Jev(secrets.jev);
      probe.setCriteria(preferences.get().value.jevCriteria);
      const result = await probe.evaluate(settings.jevProbe);
      if (result.safety < settings.safetyThreshold)
        throw new Error("Jev startup safety check failed");
      if (!(await obs.streaming()))
        throw new Error(
          "Start the OBS broadcast manually before enabling live rounds",
        );
      checks.push(
        "TypeSafe Jev reachable",
        "OBS broadcast active; automatic StopStream ready",
      );
    } else {
      try {
        await obs.connect();
        checks.push("OBS connected for private rehearsal");
      } catch {
        checks.push(
          "OBS not connected; add its password before the private rehearsal",
        );
      }
    }
    return checks;
  },
  async start() {
    if (settings.mode !== "live" || controller.state.playlistTotal) return;
    // Start/Resume reconnects the selected platforms using the latest saved switches.
    this.stop();
    try {
      await startSelectedChats(enabledFromSkips(settings.skips));
    } catch (error) {
      this.stop();
      throw error;
    }
  },
  async startChats(platforms: ChatPlatforms) {
    this.stop();
    await startSelectedChats({
      youtube: !!platforms.youtube,
      twitch: !!platforms.twitch,
      kick: !!platforms.kick,
    });
  },
  stop() {
    stopChatSources(chatSources, connection);
  },
  stopBroadcast() {
    return obs.stop(true);
  },
};
controller = new Controller(
  store,
  new Filter(settings.blockedWords),
  new Jev(secrets.jev),
  runner,
  preview,
  integrations,
  {
    ...settings,
    jevCriteria: preferences.get().value.jevCriteria,
    playlist: settings.promptPlaylist ? housePrompts : [],
  },
  clean,
);
// This callback is invoked only before preflight/start or a new round launch.
controller.configureQuick({
  get: () => preferences.get(),
  apply: applyPreferences,
});
// Welcome startup stays idle; provider discovery and model runs require explicit host actions.
const sessions = new Sessions(
  store,
  preferences,
  { docker, native },
  clean,
  settings.experience,
  () => obs.streaming(),
  () => controller.sessionReady,
  async (agent, round) => {
    await preview.ready();
    return preview.validate(agent, round, 1);
  },
  (choice) => controller.leaveArena(choice),
);
controller.arenaEnabled = () => sessions.experience === "arena";
sessionService = sessions;
controller.on("state", () => sessions.settingsChanged());
const http = makeHttp(controller, {
  chatFeed: {
    feed: chatFeed,
    configured: () => {
      const only = (platform: ChatPlatform) =>
        missingLiveSecrets(secrets, {
          ...skipRecord(true),
          [platform]: false,
        }).filter((name) => name !== "TYPESAFE_API_KEY").length === 0;
      return {
        youtube: only("youtube"),
        twitch: twitchStatus().kind === "on",
        kick: only("kick"),
      };
    },
    connections: () => controller.state.connections,
    arenaOpen: () =>
      sessions.experience === "arena" &&
      !["stopped", "break"].includes(controller.state.status),
    send: (message) => controller.ingest(message),
  },
  presentation,
  sessions,
  openObs: async () => {
    if (process.platform !== "darwin")
      throw new Error(
        "Open OBS from your computer's app menu, then retry publication",
      );
    await promisify(execFile)("open", ["-a", "OBS"], { timeout: 5000 });
  },
  quick: {
    runner: settings.runnerMode,
    preferences,
    media,
    store,
    discover: (cli, boundary) =>
      boundary ? sessions.models(cli, boundary) : runner.discover(cli),
    defaults: {
      audio: settings.musicPath,
      visual: settings.visualPath,
      visualUrl: "/media/break-visual.gif",
    },
  },
  host: settings.host,
  port: settings.port,
  previewOrigin: preview.origin,
  root,
  musicPath: settings.musicPath,
  boot: {
    rootId: createHash("sha256").update(root).digest("hex"),
    configurationId: bootConfigurationId,
    startedAt: Date.now(),
  },
});
await controller.recover();
// Recover only app-owned orphan runners; external provider sessions have no managed PID here.
if (sessions.recoveryRunners.has("native") && settings.runnerMode !== "native")
  await native.recover();
if (sessions.recoveryRunners.has("docker") && settings.runnerMode !== "docker")
  await docker.recover();
if (settings.experience === "arena")
  await browserSandbox.recover().catch(() => {
    if (!preview.direct())
      controller.pause(
        "Docker is not ready. Start Docker Desktop before running the show.",
      );
  });
if (settings.experience === "arena" && controller.state.round)
  for (const [agent, attempt] of Object.entries(
    controller.state.round.attempts,
  )) {
    if (attempt.status === "complete") {
      try {
        await preview.ready();
        attempt.preview = await preview.restore(
          agent,
          controller.state.round.id,
          roundSessionCount(controller.state.round),
        );
      } catch {
        attempt.preview = undefined;
      }
      if (!attempt.preview) {
        attempt.status = "error";
        attempt.error = "Previous preview could not be restored";
      }
    }
  }
http.server.listen(settings.port, settings.host, () =>
  console.log(
    `Prompt Arena: http://${urlHost(settings.host)}:${settings.port}/control · OBS: http://${urlHost(settings.host)}:${settings.port}/overlay`,
  ),
);
const timer = setInterval(() => {
  if (sessions.experience === "arena") void controller.tick();
}, 250);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  clearInterval(pruneTimer);
  clearInterval(presentationCheckpoint);
  presentation.checkpoint();
  presentation.close();
  await sessions.close();
  await controller.stop("Controller shut down", false);
  await http.close();
  await preview.close();
  await browserSandbox.close().catch(() => {});
  await obs.close();
  previewServer.close();
  store.close();
  await unlink(lockPath);
};
process.once("SIGINT", () => {
  void close();
});
process.once("SIGTERM", () => {
  void close();
});

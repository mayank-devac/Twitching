import { PresentationControls } from "./presentation-controls.js";
import { startupConfigurationId } from "./startup-config.js";
import { QuickSettings, defaultCriteria } from "./quick-settings.js";
import { BreakMedia } from "./break-media.js";
import { defaultVisibility } from "../shared/settings.js";
import type { ChatPlatform, QuickPreferences } from "../shared/settings.js";
import { configuredSessions } from "../shared/types.js";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { settings, root, secrets, housePrompts } from "./config.js";
import { Store } from "./store.js";
import { redactor, credentialGuard } from "./redact.js";
import { Docker } from "./docker.js";
import { CliRunner } from "./runner.js";
import { Previews } from "./preview.js";
import { Filter } from "./filter.js";
import { Jev } from "./jev.js";
import { Controller, roundSessionCount, type ChatPlatforms } from "./controller.js";
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
if (settings.experience === "arena" && settings.promptPlaylist && housePrompts.length === 0)
  throw new Error(
    `No tasks in ${settings.promptFile}. Add one prompt per line, or set ARENA_NO_PROMPTS=1 to use live chat.`,
  );
// An exclusive local lock prevents two controllers from driving the same show.
const { open, unlink, readFile, rename, link } = await import("node:fs/promises");
const lockPath = resolve(root, "runtime/controller.lock");
const runningError = () =>
  new Error("Another controller is running. Close it before starting this one.");
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
    console.error(`Database pruning failed: ${error instanceof Error ? error.message : String(error)}`);
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
      youtube: !settings.skipYoutube,
      twitch: !settings.skipTwitch,
      kick: !settings.skipKick,
      collectionMs: settings.collectionMs,
      extensionMs: settings.extensionMs,
      resultMs: settings.resultMs,
    },
    jevCriteria: defaultCriteria,
    jevProbe: settings.jevProbe,
    media: { visualFit: "fit" },
  },
  {
    platforms: [
      process.env.ARENA_SKIP_YOUTUBE,
      process.env.ARENA_SKIP_TWITCH,
      process.env.ARENA_SKIP_KICK,
    ].some((value) => value !== undefined)
      ? {
          youtube: !settings.skipYoutube,
          twitch: !settings.skipTwitch,
          kick: !settings.skipKick,
        }
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
  settings.skipYoutube = !value.stream.youtube;
  settings.skipTwitch = !value.stream.twitch;
  settings.skipKick = !value.stream.kick;
  settings.collectionMs = value.stream.collectionMs;
  settings.extensionMs = value.stream.extensionMs;
  settings.resultMs = value.stream.resultMs;
  settings.jevProbe = value.jevProbe;
};
applyPreferences(preferences.get().value);
const media = new BreakMedia(root, store);
const privateValues = [
  secrets.jev,
  secrets.youtube.access,
  secrets.youtube.refresh,
  secrets.youtube.secret,
  secrets.twitch.access,
  secrets.twitch.refresh,
  secrets.twitch.secret,
  secrets.kick.access,
  secrets.kick.secret,
  secrets.obs,
];
const kickToken = new KickToken(secrets.kick);
const mintedKickTokens: string[] = [];
let redactKnown = redactor(privateValues, root);
// The Kick app token is minted at runtime, so rebuild the redactor whenever it
// rotates; earlier tokens stay redacted too.
const clean: typeof redactKnown = (value, limit, streaming) => {
  const live = kickToken.current();
  if (live && !mintedKickTokens.includes(live)) {
    mintedKickTokens.push(live);
    redactKnown = redactor([...privateValues, ...mintedKickTokens], root);
  }
  return redactKnown(value, limit, streaming);
};
const presentation = new PresentationControls(store, clean);
// Persist running elapsed time periodically; a restart restores the last checkpoint paused.
const presentationCheckpoint = setInterval(() => {
  if (!presentation.hasRunningClock()) return;
  try { presentation.checkpoint(); }
  catch { console.error("Stopwatch checkpoint could not be saved; check available disk space."); }
}, 1000);
presentationCheckpoint.unref();
const docker = new Docker(store, { root, image: settings.agentImage });
const native = new NativeHost(store, root);
const runnerHost = settings.runnerMode === "native" ? native : docker;
const runner = new CliRunner(runnerHost, settings, clean);
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
preview.publicHidden = () => { const p = presentation.get("default"); return p.hidden || !!p.breakActive; };
const previewServer = preview.app().listen(settings.previewPort, settings.host);
let controller: Controller;
let sessionService: Sessions | undefined;
const failureText = (error: unknown) => clean(error instanceof Error ? error.message : String(error), 300);
// Last resort: Node 24 exits on an unhandled rejection, which would drop a live
// show mid-round. Log a redacted reason and pause new rounds instead.
process.on("unhandledRejection", (error) => {
  console.error(`Unhandled controller error: ${failureText(error)}`);
  try { controller?.pause("Unexpected controller error. Check the host log before resuming."); }
  catch { console.error("Show could not be paused after an unexpected error."); }
});
const connection = (platform: string, status: string, fatal = false) => {
  if (platform === "obs" && status === "Disconnected") sessionService?.obsDisconnected();
  controller?.connection(platform, status, fatal);
};
const receive = (message: Parameters<Controller["ingest"]>[0]) => {
  void controller.ingest(message).catch((error) => {
    console.error(`Chat message handling failed: ${failureText(error)}`);
    controller.pause("Chat message handling failed. Check the host before resuming.");
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
const startSelectedChats = (platforms: Partial<Record<ChatPlatform, boolean>>) =>
  startChatSources(chatSources, platforms, () => controller.state.connections, connection);
const integrations = {
  async preflight() {
    await preview.ready();
    await access(settings.musicPath);
    await access(settings.visualPath);
    const checks = [
      "Restricted Chromium preview ready",
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
      await startSelectedChats({
        youtube: !settings.skipYoutube,
        twitch: !settings.skipTwitch,
        kick: !settings.skipKick,
      });
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
const sessions = new Sessions(store, preferences, { docker, native }, clean, settings.experience,
  () => obs.streaming(), () => controller.sessionReady,
  async (agent, round) => { await preview.ready(); return preview.validate(agent, round, 1); },
  (choice) => controller.leaveArena(choice));
controller.arenaEnabled = () => sessions.experience === "arena";
sessionService = sessions;
controller.on("state", () => sessions.settingsChanged());
const http = makeHttp(controller, {
  presentation,
  sessions,
  openObs: async () => {
    if (process.platform !== "darwin") throw new Error("Open OBS from your computer's app menu, then retry publication");
    await promisify(execFile)("open", ["-a", "OBS"], { timeout: 5000 });
  },
  quick: {
    runner: settings.runnerMode,
    preferences,
    media,
    store,
    discover: (cli, boundary) => boundary ? sessions.models(cli, boundary) : runner.discover(cli),
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
if (sessions.recoveryRunners.has("native") && settings.runnerMode !== "native") await native.recover();
if (sessions.recoveryRunners.has("docker") && settings.runnerMode !== "docker") await docker.recover();
if (settings.experience === "arena") await browserSandbox
  .recover()
  .catch(() =>
    controller.pause(
      "Docker is not ready. Start Docker Desktop before running the show.",
    ),
  );
if (settings.experience === "arena" && controller.state.round)
  for (const [agent, attempt] of Object.entries(controller.state.round.attempts)) {
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

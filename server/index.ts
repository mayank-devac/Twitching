import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { settings, root, secrets, housePrompts } from "./config.js";
import { ensureYoutubeLiveChatId, twitchStatus } from "./live-platforms.js";
import { Store } from "./store.js";
import { redactor, credentialGuard } from "./redact.js";
import { Docker } from "./docker.js";
import { CliRunner } from "./runner.js";
import { Previews } from "./preview.js";
import { Filter } from "./filter.js";
import { Jev } from "./jev.js";
import { Controller, type ChatPlatforms } from "./controller.js";
import { YouTubeChat, TwitchChat, KickChat } from "./chat.js";
import { Obs } from "./obs.js";
import { makeHttp } from "./http.js";
import { BrowserSandbox } from "./browser-sandbox.js";
import { NativeHost } from "./native-host.js";
await mkdir(resolve(root, "runtime"), { recursive: true, mode: 0o700 });
if (settings.promptPlaylist && housePrompts.length === 0)
  throw new Error(
    `No tasks in ${settings.promptFile}. Add one prompt per line, or set ARENA_NO_PROMPTS=1 to use live chat.`,
  );
// An exclusive local lock prevents two controllers from driving the same show.
const { open, unlink } = await import("node:fs/promises");
const lockPath = resolve(root, "runtime/controller.lock");
try {
  const handle = await open(lockPath, "wx", 0o600);
  await handle.writeFile(String(process.pid));
  await handle.close();
} catch {
  const { readFile } = await import("node:fs/promises");
  const pid = Number(await readFile(lockPath, "utf8"));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
  }
  if (alive)
    throw new Error(
      "Another controller is running. Close it before starting this one.",
    );
  await unlink(lockPath);
  const handle = await open(lockPath, "wx", 0o600);
  await handle.writeFile(String(process.pid));
  await handle.close();
}
const store = new Store(resolve(root, "runtime/show.sqlite"));
const privateValues = [
  secrets.jev,
  secrets.youtube.access,
  secrets.youtube.refresh,
  secrets.youtube.secret,
  secrets.twitch.access,
  secrets.twitch.refresh,
  secrets.twitch.secret,
  secrets.kick.access,
  secrets.obs,
];
const clean = redactor(privateValues, root);
const docker = new Docker(store, { root, image: settings.agentImage });
const runnerHost =
  settings.runnerMode === "native" ? new NativeHost(store, root) : docker;
const runner = new CliRunner(runnerHost, settings, clean);
const browserSandbox = new BrowserSandbox(
  docker,
  root,
  settings.previewImage,
  settings.browserPort,
);
const preview = new Previews(
  root,
  `http://${settings.host}:${settings.previewPort}`,
  settings.visualPath,
  () => browserSandbox.start(),
  credentialGuard(privateValues),
  settings.previewView,
  settings.singleAgent ? { width: 1920, height: 1044 } : undefined,
);
const previewServer = preview.app().listen(settings.previewPort, settings.host);
let controller: Controller;
const connection = (platform: string, status: string, fatal = false) =>
  controller?.connection(platform, status, fatal);
const receive = (message: Parameters<Controller["ingest"]>[0]) => {
  void controller.ingest(message);
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
);
const obs = new Obs(
  settings.obsUrl,
  secrets.obs,
  settings.stopObsOnEnd,
  (status) => connection("obs", status),
  () => {
    if (
      controller?.state.mode === "live" &&
      controller.state.status !== "stopped"
    )
      void controller.stop("Host ended the OBS broadcast", false);
  },
  (active) => controller?.setReconnecting(active),
);
let chatsStarted = false;
async function startSelectedChats(platforms: {
  youtube: boolean;
  twitch: boolean;
  kick: boolean;
}) {
  const skips = {
    youtube: !platforms.youtube,
    twitch: !platforms.twitch,
    kick: !platforms.kick,
  };
  if (skips.youtube) {
    if (controller.state.connections.youtube !== "Connected")
      connection("youtube", "Skipped");
  } else if (
    !["Connected", "Connecting"].includes(
      controller.state.connections.youtube ?? "",
    )
  ) {
    await ensureYoutubeLiveChatId();
    youtube.start();
  }
  const twitchChat = skips.twitch ? { kind: "off" as const } : twitchStatus();
  if (twitchChat.kind === "partial")
    throw new Error(
      `Twitch is partially filled. Add ${twitchChat.missing.join(", ")} or leave every Twitch field empty to skip Twitch.`,
    );
  if (twitchChat.kind === "on") {
    if (
      !["Connected", "Connecting"].includes(
        controller.state.connections.twitch ?? "",
      )
    )
      twitch.start();
  } else if (controller.state.connections.twitch !== "Connected")
    connection("twitch", "Skipped");
  if (skips.kick) {
    if (controller.state.connections.kick !== "Connected")
      connection("kick", "Skipped");
  } else if (controller.state.connections.kick !== "Connected")
    await kick.start();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const youtubeReady =
      skips.youtube || controller.state.connections.youtube === "Connected";
    const twitchReady =
      twitchChat.kind !== "on" ||
      controller.state.connections.twitch === "Connected";
    if (youtubeReady && twitchReady) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!skips.youtube && controller.state.connections.youtube !== "Connected")
    throw new Error("YouTube did not confirm a chat connection");
  if (
    twitchChat.kind === "on" &&
    controller.state.connections.twitch !== "Connected"
  )
    throw new Error("Twitch did not confirm a chat connection");
}
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
      const result = await new Jev(secrets.jev).evaluate(settings.jevProbe);
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
    if (settings.mode !== "live" || chatsStarted) return;
    chatsStarted = true;
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
    chatsStarted = true;
    await startSelectedChats({
      youtube: !!platforms.youtube,
      twitch: !!platforms.twitch,
      kick: !!platforms.kick,
    });
  },
  stop() {
    youtube.stop();
    twitch.stop();
    kick.stop();
    chatsStarted = false;
  },
  stopBroadcast() {
    return obs.stop();
  },
};
controller = new Controller(
  store,
  new Filter(settings.blockedWords),
  new Jev(secrets.jev),
  runner,
  preview,
  integrations,
  { ...settings, playlist: settings.promptPlaylist ? housePrompts : [] },
  clean,
);
const http = makeHttp(controller, {
  host: settings.host,
  port: settings.port,
  previewOrigin: preview.origin,
  root,
  musicPath: settings.musicPath,
  boot: {
    rootId: createHash("sha256").update(root).digest("hex"),
    configurationId: createHash("sha256")
      .update(JSON.stringify(settings))
      .digest("hex"),
    startedAt: Date.now(),
  },
});
http.server.listen(settings.port, settings.host, () =>
  console.log(
    `Prompt Arena: http://${settings.host}:${settings.port}/control · OBS: http://${settings.host}:${settings.port}/overlay`,
  ),
);
await controller.recover();
await browserSandbox
  .recover()
  .catch(() =>
    controller.pause(
      "Docker is not ready. Start Docker Desktop before running the show.",
    ),
  );
if (controller.state.round)
  for (const agent of settings.singleAgent ? [settings.singleAgent] : ["codex", "cursor"] as const) {
    const attempt = controller.state.round.attempts[agent];
    if (attempt.status === "complete") {
      try {
        await preview.ready();
        attempt.preview = await preview.restore(
          agent,
          controller.state.round.id,
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
const timer = setInterval(() => {
  void controller.tick();
}, 250);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  clearInterval(timer);
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

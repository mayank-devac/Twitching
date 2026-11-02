// Owns the start phase: native consent, launching the app and its boot handshake, then starting the show.
import type { RunnerMode } from "../../shared/types.js";
import { spawn } from "node:child_process";
import type { Obs } from "../../server/obs.js";
import { configuredSessions } from "../../shared/types.js";
import { fetchBoot } from "../boot-client.js";
import { skipEnvRecord } from "../../server/chat-skips.js";
import { fetchState, hostAction } from "./control-api.js";
import { offerSaveDefaultOnExit } from "./save-default.js";
import {
  fix,
  launcher,
  question,
  root,
  shutdown,
  throwIfStopping,
  yes,
  type Settings,
} from "./runtime.js";
import type { StreamOptions } from "./options.js";

export interface ShowStart {
  options: StreamOptions;
  mode: "live" | "rehearsal";
  runnerMode: RunnerMode;
  settings: Settings;
  housePrompts: string[];
  origin: string;
  rootId: string;
  configurationId: string;
  existing: boolean;
  obs: Obs;
  clean: (text: string) => string;
}

const started = (status: string | undefined) =>
  ["collecting", "running", "results"].includes(status ?? "");

async function launchApp(show: ShowStart) {
  const { options, settings, origin, clean } = show;
  throwIfStopping();
  const app = spawn("npm", ["run", "dev"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      ARENA_MODE: show.mode,
      ARENA_RUNNER: show.runnerMode,
      ARENA_SINGLE_AGENT: options.singleAgent ?? "",
      ARENA_NATIVE_APPROVED: show.runnerMode === "native" ? "1" : "0",
      ARENA_NATIVE_LIVE_CHAT:
        show.runnerMode === "native" && options.allowNativeChat ? "1" : "0",
      ARENA_PROMPTS: settings.promptPlaylist ? "1" : "0",
      ARENA_NO_PROMPTS: options.ignorePrompts ? "1" : "0",
      ...skipEnvRecord(options.skips),
    },
  });
  launcher.app = app;
  launcher.appExit = new Promise((done) => {
    app.once("error", () => done(1));
    app.once("close", done);
  });
  const until = Date.now() + 20000;
  let ready = false;
  while (!ready && Date.now() < until) {
    if (app.exitCode !== null)
      fix("App exited during startup", "Fix the startup error shown above.");
    try {
      const boot = await fetchBoot(origin, 500);
      // Only this checkout's server with this exact startup contract counts as ready.
      ready =
        boot.rootId === show.rootId &&
        boot.configurationId === show.configurationId;
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
    const current = await fetchState(origin, 2000);
    recovered =
      current?.status === "paused" &&
      current.reason === "Paused. Runner recovery completed.";
    if (current?.reason && /could not confirm|Docker is not ready/i.test(current.reason))
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
}

export async function startShow(show: ShowStart) {
  const { options, mode, runnerMode, settings, housePrompts, origin, obs, clean } =
    show;
  if (runnerMode === "native") {
    console.log(
      "\nNATIVE WARNING: Codex/Cursor/Claude Code terminal commands can read and change files on your Mac, outside the project. Process-group cancellation cannot contain commands that deliberately escape it. " +
        (process.env.ARENA_DIRECT_PREVIEW === "1"
          ? "Direct preview is on: generated pages run in the browser without Docker isolation."
          : "Previews remain protected in Docker."),
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
    if (options.allowNativeChat) {
      console.log(
        "\nNATIVE CHAT WARNING: viewer chat prompts will run with your local-user permissions. Only enable this if you fully trust the environment.",
      );
      if (
        (await question("Type NATIVE CHAT to allow live chat on the native runner: ")) !==
        "NATIVE CHAT"
      )
        fix(
          "Native live chat was not confirmed",
          "Rerun without --allow-native-chat for host prompts only, or confirm NATIVE CHAT.",
        );
    }
  }
  if (
    mode === "live" &&
    (!options.interactive ||
      !(await yes(
        options.skips.kick
          ? "Is the overlay visible in your intended OBS scene, with rehearsal audio checked?"
          : "Is the overlay visible in your intended OBS scene, with rehearsal audio checked, and is Kick configured to forward only its webhook port?",
      )))
  )
    fix(
      "Host scene/webhook checks are not confirmed",
      "Check your OBS scene/audio and Kick developer configuration, then rerun interactively.",
    );
  if (!show.existing) await launchApp(show);
  else if (runnerMode === "native")
    fix(
      "An existing app cannot inherit this new native confirmation",
      "Close its terminal and rerun this file so consent applies to the correct process.",
    );
  offerSaveDefaultOnExit(origin, options.interactive);
  let startedBroadcast = false;
  let showStarted = false;
  const action = (actionName: string, text?: string) =>
    hostAction(origin, clean, actionName, text);
  // Ctrl+C stops what this terminal started: the show via the app, or OBS directly.
  launcher.closeShow = async () => {
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
    if (!started(liveState?.status))
      fix(
        clean(liveState?.reason || "Live startup failed"),
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
      if (!started(privateState?.status))
        fix(
          clean(privateState?.reason || "Prompt list startup failed"),
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
    if (!started(privateState?.status))
      fix(
        clean(privateState?.reason || "Rehearsal startup failed"),
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
  launcher.input?.close();
  if (launcher.appExit) {
    const code = await launcher.appExit;
    if (!launcher.stopping && code !== 0)
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

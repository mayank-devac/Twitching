// Owns attaching to (or restarting) a control server that already answers on the configured port.
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { chooseExistingServer, stopExistingServer } from "../existing-server.js";
import { fetchBoot, newestSource, sameBoot } from "../boot-client.js";
import {
  parseLauncherState,
  showIsBusy,
  type LauncherState,
} from "./control-api.js";
import { fix, launcher, question, root, shutdown } from "./runtime.js";
import type { StreamOptions } from "./options.js";

export interface ExistingApp {
  existing: boolean;
  configurationId?: string;
  state?: LauncherState;
}

export async function inspectExistingApp(
  options: StreamOptions,
  origin: string,
  rootId: string,
  port: number,
): Promise<ExistingApp> {
  let existing = false;
  let state: LauncherState | undefined;
  try {
    const response = await fetch(`${origin}/api/state`, {
      signal: AbortSignal.timeout(1000),
    });
    if (response.ok) {
      state = parseLauncherState(await response.json());
      existing = true;
    }
  } catch {
    /* The start script can launch the app after checks. */
  }
  if (!existing) return { existing };
  const boot = await fetchBoot(origin, 1000);
  if (boot.rootId !== rootId)
    fix(
      "A different mode, older app, or another project is already on this port.",
      "Close its terminal process, then rerun this file. The script will not kill an unknown app.",
    );
  // Only file timestamps are read here; .env.local is never opened.
  const newest = Math.max(
    await newestSource(resolve(root, "server")),
    await newestSource(resolve(root, "shared")),
    (await stat(resolve(root, "settings.json"))).mtimeMs,
    await stat(resolve(root, ".env.local"))
      .then((s) => s.mtimeMs)
      .catch(() => 0),
  );
  const stale = newest > (boot.startedAt ?? Infinity);
  // Starting against an owned server is an explicit choice, including stale or active shows.
  if (options.command === "start") {
    if (stale)
      console.log("The running server predates local code/settings changes.");
    console.log(
      "Keep leaves the old server untouched. Restart stops active coding and may end an OBS broadcast managed by its old startup terminal.",
    );
    const choice = options.interactive
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
      port,
      async () => {
        // boot.rootId was already confirmed to equal this checkout's rootId.
        if (!sameBoot(await fetchBoot(origin, 1000), boot))
          throw new Error("The running server changed");
      },
      () => launcher.stopping,
    );
    console.log("Old server stopped. Continuing normal startup checks.");
    return { existing: false };
  }
  if (stale)
    fix(
      "The running app has older code/settings/credentials.",
      "Close it and rerun start_stream.sh to load your changes.",
    );
  if (showIsBusy(state))
    fix(
      "The show is already active.",
      "Use its control panel to Pause and let current work finish, or Stop. Then rerun this file.",
    );
  return { existing, configurationId: boot.configurationId, state };
}

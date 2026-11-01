// Owns the public-live gate: private fields, chat platform readiness, OBS auto-stop and a confirmed rehearsal.
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { rehearsalSchema, type LauncherState } from "./control-api.js";
import { fix, root, type Secrets, type Settings } from "./runtime.js";
import type { StreamOptions } from "./options.js";

const savedStateRow = z.object({ value: z.string() });

// A rehearsal counts only for the runner mode it was confirmed with.
function rehearsedFor(runnerMode: string, value: unknown) {
  const saved = rehearsalSchema.safeParse(value);
  return (
    saved.success &&
    saved.data.rehearsalComplete === true &&
    (saved.data.rehearsalRunnerMode ?? "docker") === runnerMode
  );
}
function savedRehearsal(runnerMode: string) {
  let saved: DatabaseSync | undefined;
  try {
    saved = new DatabaseSync(resolve(root, "runtime/show.sqlite"), {
      readOnly: true,
    });
    const row = savedStateRow.safeParse(
      saved.prepare("SELECT value FROM documents WHERE key='state'").get(),
    );
    return row.success && rehearsedFor(runnerMode, JSON.parse(row.data.value));
  } catch {
    /* No completed rehearsal yet. */
    return false;
  } finally {
    saved?.close();
  }
}

// Returns whether Twitch still needs its live-only check after broadcasting starts.
export async function checkLivePreflight(
  options: StreamOptions,
  settings: Settings,
  secrets: Secrets,
  runnerMode: "docker" | "native",
  state: LauncherState | undefined,
) {
  let twitchPending = true;
  const { missingLiveSecrets, twitchStatus, ensureYoutubeLiveChatId } =
    await import("../../server/live-platforms.js");
  const missing = missingLiveSecrets(secrets);
  if (missing.length)
    fix(
      `Missing private fields: ${missing.join(", ")}`,
      twitchStatus().kind === "partial"
        ? "Fill the remaining Twitch names, or leave every Twitch field empty to skip Twitch. Edit .env.local in your editor. Do not paste credentials into chat or command-line arguments."
        : "Fill those names in .env.local using your editor, then rerun. Do not paste credentials into chat or command-line arguments.",
    );
  if (!options.skipYoutube && !secrets.youtube.chat.trim()) {
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
  } else if (options.skipYoutube)
    console.log("NOTE: YouTube chat skipped (--skip yt).");
  if (options.skipTwitch) {
    twitchPending = false;
    console.log("NOTE: Twitch chat skipped (--skip twitch).");
  } else if (twitchStatus().kind === "off") {
    twitchPending = false;
    console.log(
      "NOTE: Twitch is skipped because its .env.local fields are empty.",
    );
  }
  if (options.skipKick) console.log("NOTE: Kick chat skipped (--skip kick).");
  else checkKickWebhook(settings.kickWebhookUrl);
  if (!settings.stopObsOnEnd)
    fix(
      "Automatic OBS shutdown is disabled",
      "Set stopObsOnEnd to true in settings.json.",
    );
  const rehearsed =
    rehearsedFor(runnerMode, state) || savedRehearsal(runnerMode);
  if (!rehearsed && !settings.promptPlaylist)
    fix(
      "Private OBS rehearsal has not been confirmed for this runner mode",
      `Run ./start_stream.sh --mode rehearsal --runner ${runnerMode}, finish one round, check your private recording, and confirm the rehearsal in /control.`,
    );
  return twitchPending;
}

function checkKickWebhook(url: string) {
  let webhook: URL;
  try {
    webhook = new URL(url);
  } catch {
    return fix(
      "Kick webhook URL is missing or invalid",
      "Set kickWebhookUrl in settings.json to your registered public HTTPS /kick endpoint, or rerun with --skip kick.",
    );
  }
  if (
    webhook.protocol !== "https:" ||
    webhook.pathname !== "/kick" ||
    ["localhost", "127.0.0.1", "[::1]"].includes(webhook.hostname) ||
    webhook.username ||
    webhook.password
  )
    fix(
      "Kick webhook URL is not a public HTTPS /kick endpoint",
      "Register the correct HTTPS /kick URL in Kick developer settings and settings.json; tunnel only port 3212 (or your webhookPort). Or rerun with --skip kick.",
    );
}

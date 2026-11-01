// Side-effect-free chat platform setup checks: no config.js import, so chat
// sources and tests can use them without loading .env.local.
import { z } from "zod";

const youtubeBroadcasts = "https://www.googleapis.com/youtube/v3/liveBroadcasts";
// Only liveChatId is read; an unexpected body counts as "no broadcast found".
const broadcastListSchema = z.object({
  items: z
    .array(z.object({ snippet: z.object({ liveChatId: z.unknown() }).nullish() }))
    .optional(),
});

// Twitch is optional: every field empty means off, some empty means a setup error.
export function twitchFieldStatus(twitch: {
  access: string;
  client: string;
  broadcaster: string;
  user: string;
}) {
  const fields = [
    ["TWITCH_CLIENT_ID", twitch.client],
    ["TWITCH_ACCESS_TOKEN", twitch.access],
    ["TWITCH_BROADCASTER_ID", twitch.broadcaster],
    ["TWITCH_BOT_USER_ID", twitch.user],
  ] as const;
  const missing = fields
    .filter(([, value]) => !value.trim())
    .map(([name]) => name);
  if (missing.length === fields.length) return { kind: "off" as const };
  if (missing.length) return { kind: "partial" as const, missing };
  return { kind: "on" as const };
}

export async function resolveYoutubeLiveChatId(
  access: string,
  fetchImpl: typeof fetch = fetch,
) {
  const token = access.trim();
  if (!token)
    throw new Error(
      "YOUTUBE_ACCESS_TOKEN is missing; fill it in .env.local before looking up a live chat ID",
    );
  for (const broadcastStatus of ["active", "upcoming"] as const) {
    const id = await chatIdForBroadcasts(token, broadcastStatus, fetchImpl);
    if (id) return id;
  }
  throw new Error(
    "No YouTube live chat ID found. Create or schedule a livestream in YouTube Studio, then rerun.",
  );
}

async function chatIdForBroadcasts(
  access: string,
  broadcastStatus: "active" | "upcoming",
  fetchImpl: typeof fetch,
) {
  const url = new URL(youtubeBroadcasts);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("mine", "true");
  url.searchParams.set("broadcastStatus", broadcastStatus);
  url.searchParams.set("maxResults", "5");
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${access}` },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 401 || response.status === 403)
    throw new Error(
      "YouTube access token could not list live broadcasts; update YOUTUBE_ACCESS_TOKEN",
    );
  if (!response.ok)
    throw new Error(
      `YouTube live broadcast lookup failed (HTTP ${response.status})`,
    );
  const data = broadcastListSchema.safeParse(await response.json());
  for (const item of (data.success && data.data.items) || []) {
    const id = item.snippet?.liveChatId;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
}

// Fills an empty saved chat ID from the account's current or upcoming broadcast.
export async function ensureYoutubeChatId(
  youtube: { access: string; chat: string },
  fetchImpl: typeof fetch = fetch,
) {
  if (youtube.chat.trim()) return youtube.chat.trim();
  const id = await resolveYoutubeLiveChatId(youtube.access, fetchImpl);
  youtube.chat = id;
  process.env.YOUTUBE_LIVE_CHAT_ID = id;
  return id;
}

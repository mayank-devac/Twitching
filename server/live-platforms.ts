import { z } from "zod";
import { secrets } from "./config.js";
import { chatSkips } from "./chat-skips.js";
import { CHAT_PLATFORMS, type ChatPlatform } from "../shared/settings.js";

const youtubeBroadcasts = "https://www.googleapis.com/youtube/v3/liveBroadcasts";
// Only liveChatId is read; an unexpected body counts as "no broadcast found".
const broadcastListSchema = z.object({
  items: z
    .array(z.object({ snippet: z.object({ liveChatId: z.unknown() }).nullish() }))
    .optional(),
});

export function twitchStatus(
  twitch: {
    access: string;
    client: string;
    broadcaster: string;
    user: string;
  } = secrets.twitch,
) {
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

type LiveSecretValues = {
  jev: string;
  youtube: { access: string; chat: string };
  twitch: {
    access: string;
    client: string;
    broadcaster: string;
    user: string;
  };
  kick: { access: string; broadcaster: string; client?: string; secret?: string };
};
type Field = [name: string, value: string];
// Fields each enabled platform needs; `missing` lists names that are absent regardless of value.
const liveRequirements: Record<
  ChatPlatform,
  (values: LiveSecretValues) => { required: Field[]; missing?: string[] }
> = {
  youtube: (values) => ({
    required: [["YOUTUBE_ACCESS_TOKEN", values.youtube.access]],
  }),
  twitch: (values) => {
    // An entirely empty Twitch block means "skip Twitch"; a partial one is an error.
    const status = twitchStatus(values.twitch);
    if (status.kind === "partial") return { required: [], missing: status.missing };
    if (status.kind === "off") return { required: [] };
    return {
      required: [
        ["TWITCH_CLIENT_ID", values.twitch.client],
        ["TWITCH_ACCESS_TOKEN", values.twitch.access],
        ["TWITCH_BROADCASTER_ID", values.twitch.broadcaster],
        ["TWITCH_BOT_USER_ID", values.twitch.user],
      ],
    };
  },
  kick: (values) => {
    const required: Field[] = [];
    // KICK_CLIENT_ID + KICK_CLIENT_SECRET replace KICK_ACCESS_TOKEN: the server
    // mints the app token itself, so the static token is required only without them.
    if (!(values.kick.client?.trim() && values.kick.secret?.trim()))
      required.push(["KICK_ACCESS_TOKEN", values.kick.access]);
    required.push(["KICK_BROADCASTER_ID", values.kick.broadcaster]);
    return { required };
  },
};

export function missingLiveSecrets(
  values: LiveSecretValues = secrets,
  skips: Partial<Record<ChatPlatform, boolean>> = chatSkips(),
) {
  const fields: Field[] = [["TYPESAFE_API_KEY", values.jev]];
  const absent: string[] = [];
  for (const platform of CHAT_PLATFORMS) {
    if (skips[platform]) continue;
    const need = liveRequirements[platform](values);
    fields.push(...need.required);
    absent.push(...(need.missing ?? []));
  }
  return [
    ...fields.filter(([, value]) => !value.trim()).map(([name]) => name),
    ...absent,
  ];
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

export async function ensureYoutubeLiveChatId(
  youtube: { access: string; chat: string } = secrets.youtube,
  fetchImpl: typeof fetch = fetch,
) {
  if (youtube.chat.trim()) return youtube.chat.trim();
  const id = await resolveYoutubeLiveChatId(youtube.access, fetchImpl);
  youtube.chat = id;
  process.env.YOUTUBE_LIVE_CHAT_ID = id;
  return id;
}

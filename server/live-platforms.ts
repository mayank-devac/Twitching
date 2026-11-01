import { secrets } from "./config.js";
import { chatSkips } from "./chat-skips.js";
import {
  ensureYoutubeChatId,
  resolveYoutubeLiveChatId,
  twitchFieldStatus,
} from "./chat/platform-setup.js";
import { CHAT_PLATFORMS, type ChatPlatform } from "../shared/settings.js";

export { resolveYoutubeLiveChatId };

export function twitchStatus(
  twitch: {
    access: string;
    client: string;
    broadcaster: string;
    user: string;
  } = secrets.twitch,
) {
  return twitchFieldStatus(twitch);
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
    const status = twitchFieldStatus(values.twitch);
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

export function ensureYoutubeLiveChatId(
  youtube: { access: string; chat: string } = secrets.youtube,
  fetchImpl: typeof fetch = fetch,
) {
  return ensureYoutubeChatId(youtube, fetchImpl);
}

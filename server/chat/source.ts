import type { ChatMessage } from "../../shared/types.js";
import {
  CHAT_PLATFORMS,
  chatPlatformLabels,
  type ChatPlatform,
} from "../../shared/settings.js";
import { z } from "zod";

export type Status = (platform: string, status: string, fatal?: boolean) => void;
export type Receive = (message: ChatMessage) => void;

// What the show needs from every chat platform client. Each client keeps its own
// protocol; messages and connection states flow out through Receive and Status.
export interface ChatSource {
  readonly platform: ChatPlatform;
  // Statuses meaning a connection is already up or on its way, so start would duplicate it.
  readonly runningStatuses: readonly string[];
  // Whether going live waits for this source to report "Connected".
  readonly confirmsConnection: boolean;
  // False when the platform is configured off; throws when its setup is incomplete.
  configured?(): boolean;
  // Setup that must finish before start, such as resolving the YouTube live chat ID.
  prepare?(): Promise<unknown>;
  start(): void | Promise<void>;
  stop(): void;
}
export type ChatSources = Record<ChatPlatform, ChatSource>;

// Starts the enabled sources in platform order and waits for the ones that confirm.
export async function startChatSources(
  sources: ChatSources,
  enabled: Partial<Record<ChatPlatform, boolean>>,
  connections: () => Record<string, string>,
  status: Status,
  timeoutMs = 15000,
) {
  const awaited: ChatPlatform[] = [];
  for (const platform of CHAT_PLATFORMS) {
    const source = sources[platform];
    if (!enabled[platform] || source.configured?.() === false) {
      if (connections()[platform] !== "Connected") status(platform, "Skipped");
      continue;
    }
    if (!source.runningStatuses.includes(connections()[platform] ?? "")) {
      await source.prepare?.();
      await source.start();
    }
    if (source.confirmsConnection) awaited.push(platform);
  }
  const unconfirmed = () =>
    awaited.filter((platform) => connections()[platform] !== "Connected");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && unconfirmed().length)
    await new Promise((r) => setTimeout(r, 200));
  const late = unconfirmed()[0];
  if (late)
    throw new Error(
      `${chatPlatformLabels[late]} did not confirm a chat connection`,
    );
}
export function stopChatSources(sources: ChatSources, status: Status) {
  for (const platform of CHAT_PLATFORMS) sources[platform].stop();
  // Closed connections must not look Connected when the selected chats restart.
  for (const platform of CHAT_PLATFORMS) status(platform, "Stopped");
}

// Untrusted OAuth refresh body shared by the YouTube and Twitch clients.
export const oauthRefreshSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().nullish(),
});

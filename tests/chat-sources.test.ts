import test from "node:test";
import assert from "node:assert/strict";
import {
  startChatSources,
  stopChatSources,
  type ChatSource,
  type ChatSources,
} from "../server/chat.js";
import type { ChatPlatform } from "../shared/settings.js";

function fakeSources(connections: Record<string, string>, log: string[]) {
  const make = (
    platform: ChatPlatform,
    extra: Partial<ChatSource> = {},
  ): ChatSource => ({
    platform,
    runningStatuses: ["Connected", "Connecting"],
    confirmsConnection: true,
    start() {
      log.push(`start ${platform}`);
      connections[platform] = "Connected";
    },
    stop() {
      log.push(`stop ${platform}`);
    },
    ...extra,
  });
  return {
    youtube: make("youtube", {
      prepare: async () => log.push("prepare youtube"),
    }),
    twitch: make("twitch", { configured: () => false }),
    kick: make("kick", {
      runningStatuses: ["Connected"],
      confirmsConnection: false,
      start() {
        log.push("start kick");
      },
    }),
  } satisfies ChatSources;
}

test("startChatSources starts enabled sources in platform order and skips the rest", async () => {
  const connections: Record<string, string> = {};
  const log: string[] = [];
  const status = (platform: string, value: string) => {
    log.push(`${platform}: ${value}`);
    connections[platform] = value;
  };
  await startChatSources(
    fakeSources(connections, log),
    { youtube: true, twitch: true, kick: true },
    () => connections,
    status,
  );
  assert.deepEqual(log, [
    "prepare youtube",
    "start youtube",
    "twitch: Skipped",
    "start kick",
  ]);
  // An already running source is not started twice.
  log.length = 0;
  await startChatSources(
    fakeSources(connections, log),
    { youtube: true },
    () => connections,
    status,
  );
  assert.deepEqual(log, ["twitch: Skipped", "kick: Skipped"]);
});

test("startChatSources fails when a confirming source never connects", async () => {
  const connections: Record<string, string> = {};
  const sources = fakeSources(connections, []);
  sources.youtube = { ...sources.youtube, start() {} };
  await assert.rejects(
    startChatSources(sources, { youtube: true }, () => connections, () => {}, 50),
    /YouTube did not confirm a chat connection/,
  );
});

test("stopChatSources stops every source and reports each as Stopped", () => {
  const log: string[] = [];
  stopChatSources(fakeSources({}, log), (platform, value) =>
    log.push(`${platform}: ${value}`),
  );
  assert.deepEqual(log, [
    "stop youtube",
    "stop twitch",
    "stop kick",
    "youtube: Stopped",
    "twitch: Stopped",
    "kick: Stopped",
  ]);
});

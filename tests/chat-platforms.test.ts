import test from "node:test";
import assert from "node:assert/strict";
import { CHAT_PLATFORMS, chatPlatformLabels } from "../shared/settings.js";
import { chatSkips, parseSkipPlatform, skipEnvKey, skipFlags } from "../server/chat-skips.js";
import { missingLiveSecrets } from "../server/live-platforms.js";

test("every chat platform has a label, a --skip name and a skip env key", () => {
  assert.deepEqual([...CHAT_PLATFORMS], ["youtube", "twitch", "kick"]);
  for (const platform of CHAT_PLATFORMS) {
    assert.ok(chatPlatformLabels[platform]);
    assert.equal(parseSkipPlatform(skipFlags[platform]), platform);
    assert.equal(parseSkipPlatform(platform), platform);
  }
  assert.equal(skipEnvKey("youtube"), "ARENA_SKIP_YOUTUBE");
  assert.throws(() => parseSkipPlatform("constructor"), /Unknown --skip target/);
});

test("chatSkips reads one ARENA_SKIP_* flag per platform", () => {
  assert.deepEqual(chatSkips({}), { youtube: false, twitch: false, kick: false });
  assert.deepEqual(
    chatSkips({ ARENA_SKIP_YOUTUBE: "1", ARENA_SKIP_TWITCH: "0", ARENA_SKIP_KICK: "1" }),
    { youtube: true, twitch: false, kick: true },
  );
});

test("missingLiveSecrets lists empty fields in platform order, then partial Twitch names", () => {
  const empty = {
    jev: "",
    youtube: { access: "", chat: "" },
    twitch: { access: "", client: "c", broadcaster: "", user: "" },
    kick: { access: "", broadcaster: "" },
  };
  assert.deepEqual(missingLiveSecrets(empty, {}), [
    "TYPESAFE_API_KEY",
    "YOUTUBE_ACCESS_TOKEN",
    "KICK_ACCESS_TOKEN",
    "KICK_BROADCASTER_ID",
    "TWITCH_ACCESS_TOKEN",
    "TWITCH_BROADCASTER_ID",
    "TWITCH_BOT_USER_ID",
  ]);
  assert.deepEqual(missingLiveSecrets(empty, { youtube: true, twitch: true, kick: true }), [
    "TYPESAFE_API_KEY",
  ]);
});

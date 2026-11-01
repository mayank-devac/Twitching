import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureYoutubeLiveChatId,
  missingLiveSecrets,
  resolveYoutubeLiveChatId,
  twitchStatus,
} from "../server/live-platforms.js";
import { parseSkipPlatform } from "../server/chat-skips.js";

const filled = {
  jev: "jev",
  youtube: { access: "ya29.example", chat: "" },
  twitch: {
    access: "",
    client: "",
    broadcaster: "",
    user: "",
  },
  kick: { access: "kick", broadcaster: "1" },
};

test("empty Twitch fields skip Twitch; a partial Twitch setup is still missing", () => {
  assert.deepEqual(twitchStatus(filled.twitch), { kind: "off" });
  assert.deepEqual(missingLiveSecrets(filled, { youtube: false, twitch: false }), []);
  assert.deepEqual(
    twitchStatus({ ...filled.twitch, client: "client" }),
    {
      kind: "partial",
      missing: [
        "TWITCH_ACCESS_TOKEN",
        "TWITCH_BROADCASTER_ID",
        "TWITCH_BOT_USER_ID",
      ],
    },
  );
  assert.ok(
    missingLiveSecrets(
      {
        ...filled,
        twitch: { ...filled.twitch, client: "client" },
      },
      { youtube: false, twitch: false },
    ).includes("TWITCH_ACCESS_TOKEN"),
  );
  assert.deepEqual(
    missingLiveSecrets(
      {
        ...filled,
        twitch: { ...filled.twitch, client: "client" },
      },
      { youtube: false, twitch: true },
    ),
    [],
  );
  assert.deepEqual(
    missingLiveSecrets(
      { ...filled, youtube: { access: "", chat: "" } },
      { youtube: true, twitch: true },
    ),
    [],
  );
  assert.deepEqual(
    missingLiveSecrets(
      {
        ...filled,
        kick: { access: "", broadcaster: "" },
      },
      { youtube: true, twitch: true, kick: true },
    ),
    [],
  );
  // A Kick client ID + secret pair stands in for the static access token.
  const noKickToken = { ...filled, kick: { access: "", broadcaster: "1" } };
  assert.deepEqual(
    missingLiveSecrets(noKickToken, { youtube: false, twitch: true }),
    ["KICK_ACCESS_TOKEN"],
  );
  assert.deepEqual(
    missingLiveSecrets(
      { ...noKickToken, kick: { ...noKickToken.kick, client: "id", secret: "s" } },
      { youtube: false, twitch: true },
    ),
    [],
  );
  assert.deepEqual(
    missingLiveSecrets(
      { ...noKickToken, kick: { ...noKickToken.kick, client: "id", secret: " " } },
      { youtube: false, twitch: true },
    ),
    ["KICK_ACCESS_TOKEN"],
  );
  assert.deepEqual(
    twitchStatus({
      access: "token",
      client: "client",
      broadcaster: "1",
      user: "2",
    }),
    { kind: "on" },
  );
});

test("parseSkipPlatform accepts yt/youtube, twitch and kick", () => {
  assert.equal(parseSkipPlatform("yt"), "youtube");
  assert.equal(parseSkipPlatform("YouTube"), "youtube");
  assert.equal(parseSkipPlatform("twitch"), "twitch");
  assert.equal(parseSkipPlatform("kick"), "kick");
  assert.throws(() => parseSkipPlatform("discord"), /--skip yt, --skip twitch, or --skip kick/);
});

test("YouTube live chat lookup prefers an active broadcast and fails when none exist", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: URL | RequestInfo) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("broadcastStatus=active"))
      return new Response(
        JSON.stringify({
          items: [{ snippet: { liveChatId: "chat-active" } }],
        }),
        { status: 200 },
      );
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }) as typeof fetch;
  assert.equal(
    await resolveYoutubeLiveChatId("ya29.example", fetchImpl),
    "chat-active",
  );
  assert.ok(calls[0]?.includes("broadcastStatus=active"));
  await assert.rejects(
    resolveYoutubeLiveChatId(
      "ya29.example",
      (async () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
        })) as typeof fetch,
    ),
    /No YouTube live chat ID found/,
  );
  await assert.rejects(
    resolveYoutubeLiveChatId(
      "ya29.example",
      (async () => new Response("denied", { status: 401 })) as typeof fetch,
    ),
    /update YOUTUBE_ACCESS_TOKEN/,
  );
  // A malformed list body reads as "no broadcast" rather than a TypeError.
  await assert.rejects(
    resolveYoutubeLiveChatId(
      "ya29.example",
      (async () =>
        new Response(JSON.stringify({ items: "nope" }), {
          status: 200,
        })) as typeof fetch,
    ),
    /No YouTube live chat ID found/,
  );
});

test("an empty saved chat ID is filled from the lookup without reading other secrets", async () => {
  const youtube = { access: "ya29.example", chat: "  " };
  const id = await ensureYoutubeLiveChatId(
    youtube,
    (async () =>
      new Response(
        JSON.stringify({
          items: [{ snippet: { liveChatId: " chat-from-api " } }],
        }),
        { status: 200 },
      )) as typeof fetch,
  );
  assert.equal(id, "chat-from-api");
  assert.equal(youtube.chat, "chat-from-api");
  assert.equal(process.env.YOUTUBE_LIVE_CHAT_ID, "chat-from-api");
  delete process.env.YOUTUBE_LIVE_CHAT_ID;
});

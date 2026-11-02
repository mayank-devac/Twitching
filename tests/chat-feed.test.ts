import test from "node:test";
import assert from "node:assert/strict";
import { ChatFeed } from "../server/chat-feed.js";
import { Filter } from "../server/filter.js";
import type { ChatMessage } from "../shared/types.js";

const message = (id: string, text: string, platform: ChatMessage["platform"] = "twitch"): ChatMessage => ({
  id, platform, authorId: `a-${id}`, author: `viewer ${id}`, text, timestamp: Date.now(),
  membership: { verified: false, member: false, gift: false },
});
const filter = new Filter(["fuck", "shit"]);
const on = (feed: ChatFeed) => (feed.update({ enabled: true }), feed);

test("the feed is off by default: nothing is stored, and turning it off clears it", () => {
  const feed = new ChatFeed(filter);
  feed.add(message("1", "hello"));
  feed.update({ enabled: true });
  assert.equal(feed.view([]).entries.length, 0);
  feed.add(message("2", "hello"));
  assert.equal(feed.view([]).entries.length, 1);
  feed.update({ enabled: false });
  feed.update({ enabled: true });
  assert.equal(feed.view([]).entries.length, 0);
});

test("blocked comments are hidden by default and never leave the server", () => {
  const feed = on(new ChatFeed(filter));
  feed.add(message("1", "hello everyone"));
  feed.add(message("2", "what the fuck is this"));
  assert.deepEqual(feed.view([]).entries.map((e) => e.id), ["1"]);
});

test("mask mode bullets only the listed word; off shows everything", () => {
  const feed = on(new ChatFeed(filter));
  feed.add(message("1", "this is shit lol"));
  feed.update({ mode: "mask" });
  assert.equal(feed.view([]).entries[0]?.text, "this is •••• lol");
  feed.update({ hideBlocked: false });
  assert.equal(feed.view([]).entries[0]?.text, "this is shit lol");
});

test("platform filter, prompt filter, cursor and Jev selection", () => {
  const feed = on(new ChatFeed(filter, () => new Set(["2"])));
  feed.add(message("1", "plain chat", "kick"));
  feed.add(message("2", "!prompt make a calm rain scene for me", "twitch"));
  const all = feed.view([]);
  assert.deepEqual(all.selected, ["2"]);
  assert.deepEqual(feed.view([], { only: ["kick"] }).entries.map((e) => e.id), ["1"]);
  assert.deepEqual(feed.view([], { prompts: true }).entries.map((e) => e.id), ["2"]);
  assert.equal(feed.view([], { since: all.cursor, rev: all.rev }).entries.length, 0);
});

test("a stale cursor or a changed rev resets the client instead of returning nothing", () => {
  const feed = on(new ChatFeed(filter));
  feed.add(message("1", "hello"));
  const first = feed.view([]);
  assert.equal(first.reset, true);
  assert.equal(feed.view([], { since: first.cursor, rev: first.rev }).reset, false);
  // A cursor from before a restart is ahead of this run's counter.
  assert.equal(feed.view([], { since: 500, rev: first.rev }).reset, true);
  // A setting change must make clients drop rows shown under the old rule.
  feed.update({ mode: "mask" });
  const after = feed.view([], { since: first.cursor, rev: first.rev });
  assert.equal(after.reset, true);
  assert.equal(after.entries.length, 1);
});

test("author names follow the same hide and mask rules", () => {
  const feed = on(new ChatFeed(filter));
  feed.add({ ...message("1", "hello"), author: "shit_lord" });
  assert.equal(feed.view([]).entries.length, 0);
  feed.update({ mode: "mask" });
  assert.equal(feed.view([]).entries.length, 1);
  assert.match(feed.view([]).entries[0]!.author, /•/);
  assert.equal(feed.asPrompt("twitch", "1")?.text, "!prompt hello");
  feed.update({ mode: "hide" });
  assert.equal(feed.asPrompt("twitch", "1"), undefined);
});

test("a selected comment that is hidden is not reported as selected", () => {
  const feed = on(new ChatFeed(filter, () => new Set(["1"])));
  feed.add(message("1", "this is shit"));
  assert.deepEqual(feed.view([]).selected, []);
});

test("send-as-prompt makes a fresh id and adds the !prompt prefix once", () => {
  const feed = on(new ChatFeed(filter));
  feed.add(message("1", "make a calm rain scene for me"));
  const sent = feed.asPrompt("twitch", "1");
  assert.match(sent?.text ?? "", /^!prompt make a calm/);
  assert.notEqual(sent?.id, "1");
  assert.equal(feed.asPrompt("twitch", "missing"), undefined);
  // The same id on another platform is a different comment.
  assert.equal(feed.asPrompt("kick", "1"), undefined);
});

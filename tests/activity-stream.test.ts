import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityAdapter, JsonLines } from "../server/activity.js";
import { redactor } from "../server/redact.js";
import { fileDiff, HtmlDiffs } from "../server/file-diff.js";
import type { Activity } from "../shared/types.js";
import {
  activityPatches,
  mergeActivityPatches,
} from "../shared/activity-stream.js";

for (const agent of ["codex", "cursor"] as const)
  test(`${agent} streams complete long messages and thinking without freezing`, () => {
    const events: Activity[] = [];
    const adapter = new ActivityAdapter(
      agent,
      1,
      redactor([], "/workspace"),
      (event) => events.push(event),
    );
    const first = "x".repeat(90_000);
    for (const thinking of [false, true]) {
      for (const [index, text] of [first, "TAIL!"].entries()) {
        if (agent === "codex")
          adapter.receive({
            type: "item.updated",
            item: {
              id: thinking ? "thinking" : "message",
              type: thinking ? "reasoning" : "agent_message",
              text: index ? first + text : text,
            },
          });
        else if (thinking)
          adapter.receive({ type: "thinking", subtype: "delta", text });
        else
          adapter.receive({
            type: "assistant",
            timestamp_ms: index + 1,
            message: { content: [{ type: "text", text }] },
          });
      }
      const shown = events.filter(
        (event) => event.kind === (thinking ? "summary" : "message"),
      );
      assert.equal(shown[0].text, first);
      assert.equal(shown.at(-1)?.text, first + "TAIL!");
    }
  });

test("long commands keep whitespace and long HTML writes retain their tail", () => {
  const events: Activity[] = [];
  const clean = redactor(["secret-token"], "/workspace");
  const codex = new ActivityAdapter("codex", 1, clean, (event) =>
    events.push(event),
  );
  const command = `printf  ${"x".repeat(90_000)} secret-token`;
  codex.receive({
    type: "item.completed",
    item: {
      id: "command",
      type: "command_execution",
      command,
    },
  });
  assert.equal(
    events.find((event) => event.lane === "terminal")?.text,
    `done printf  ${"x".repeat(90_000)} [redacted]`,
  );
  const cursor = new ActivityAdapter("cursor", 1, clean, (event) =>
    events.push(event),
  );
  const html = `<p>${"x".repeat(90_000)}END</p>`;
  cursor.receive({
    type: "tool_call",
    subtype: "completed",
    call_id: "write",
    tool_call: {
      writeToolCall: { args: { path: "prompt_1.html", fileText: html } },
    },
  });
  assert.equal(
    events.find((event) => event.text.startsWith("<p>"))?.text,
    html,
  );
});

test("streaming holds only possible secret fragments and publishes short safe text immediately", () => {
  const clean = redactor(["secret-token"], "/workspace");
  assert.equal(clean("Hello!", Infinity, true), "Hello!");
  assert.equal(clean("Hello! secret-", Infinity, true), "Hello! ");
  assert.equal(
    clean("Hello! secret-token", Infinity, true),
    "Hello! [redacted]",
  );
  for (const prefix of ["s", "sk", "sk-", "ghp", "eyJabc", "/Us"])
    assert.equal(clean(prefix, Infinity, true), "");
  assert.equal(clean("sk-abcdef", Infinity, true), "[redacted]");
  assert.equal(clean("/Users/mayank/file", Infinity, true), "[private path]");
});

test("valid CLI records larger than 2 MB are not discarded between chunks", () => {
  const events: unknown[] = [];
  const lines = new JsonLines(
    (event) => events.push(event),
    () => assert.fail("valid JSON"),
  );
  const text = "x".repeat(2_000_001);
  lines.push(`{"text":"${text}`);
  lines.push('"}\n');
  assert.deepEqual(events, [{ text }]);
});

test("file diffs show additions, removals and newline-only edits", () => {
  assert.equal(fileDiff("same\n", "same\n", "page.html"), "");
  assert.equal(
    fileDiff("a\nold\nz\n", "a\nnew\nz\n", "page.html"),
    "--- page.html\n+++ page.html\n@@ -2,1 +2,1 @@\n-old\n+new\n",
  );
  assert.match(
    fileDiff("", "new\n", "page.html"),
    /@@ -0,0 \+1,1 @@\n\+new\n$/,
  );
  assert.match(fileDiff("old\n", "", "page.html"), /@@ -1,1 \+0,0 @@\n-old\n$/);
  assert.match(
    fileDiff("same", "same\n", "page.html"),
    /No newline at end of file/,
  );
});

test("live updates send only new text and reconstruct replacements, removals and reconnect snapshots", () => {
  const event: Activity = {
    id: "message",
    agent: "codex",
    round: 1,
    at: 1,
    kind: "message",
    text: "x".repeat(90_000),
  };
  const next = { ...event, at: 2, text: event.text + "TAIL!" };
  const patches = activityPatches([event], [next]);
  assert.equal(patches[0].event.text, "TAIL!");
  assert.deepEqual(mergeActivityPatches([event], patches, [event.id]), [next]);
  const replaced = { ...next, text: "[redacted]" };
  assert.deepEqual(
    mergeActivityPatches([next], activityPatches([next], [replaced]), [
      event.id,
    ]),
    [replaced],
  );
  assert.deepEqual(mergeActivityPatches([event], [], []), []);
  assert.deepEqual(
    mergeActivityPatches([], activityPatches([], [next]), [event.id]),
    [next],
  );
  assert.throws(
    () => mergeActivityPatches([], patches, [event.id]),
    /reconnect/,
  );
});

test("HTML snapshots emit redacted diffs without reading unrelated files or following links", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arena-diffs-"));
  try {
    const events: Activity[] = [];
    const diffs = new HtmlDiffs(
      dir,
      1,
      "codex",
      redactor(["secret-token"], dir),
      (event) => events.push(event),
    );
    await writeFile(join(dir, "other.html"), "UNRELATED_CONTENT");
    await diffs.begin();
    await writeFile(join(dir, "prompt_1.html"), "<p>secret-token</p>\n");
    await diffs.capture();
    await diffs.capture();
    await writeFile(join(dir, "prompt_1.html"), "<p>new</p>\n");
    await diffs.capture();
    const shown = events.filter((event) => event.diff && !event.lane);
    assert.equal(shown.length, 2);
    assert.match(shown[1].text, /-<p>\[redacted\]<\/p>\n\+<p>new<\/p>/);
    assert.ok(!JSON.stringify(events).includes("secret-token"));
    assert.ok(!JSON.stringify(events).includes("UNRELATED_CONTENT"));
    await rm(join(dir, "prompt_1.html"));
    await symlink(join(dir, "other.html"), join(dir, "prompt_1.html"));
    await diffs.capture();
    assert.match(events.at(-1)?.text ?? "", /diff unavailable/);
    assert.ok(!JSON.stringify(events).includes("UNRELATED_CONTENT"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

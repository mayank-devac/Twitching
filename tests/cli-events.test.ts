import test from "node:test";
import assert from "node:assert/strict";
import { ActivityAdapter } from "../server/activity.js";
import { parseCliEvent } from "../server/cli/events.js";
import { cliAdapters } from "../server/cli/index.js";
import type { Activity } from "../shared/types.js";

test("malformed nested CLI data is ignored without exposing its contents", () => {
  const events: Activity[] = [];
  const adapter = new ActivityAdapter("codex", 1, (text) => text, (event) => events.push(event));
  for (const value of [null, [], { type: "item.completed", item: { type: "file_change", changes: "private-invalid" } }, { type: "assistant", message: { content: "private-invalid" } }]) {
    assert.equal(parseCliEvent(value), undefined);
    assert.doesNotThrow(() => adapter.receive(value));
  }
  assert.deepEqual(events, []);
});
test("validated events select only the correct CLI's edit trigger", () => {
  const codex = parseCliEvent({ type: "item.completed", item: { type: "file_change", changes: [{ path: "/workspace/prompt_1.html" }] } })!;
  const cursor = parseCliEvent({ type: "tool_call", subtype: "completed", tool_call: {} })!;
  assert.equal(cliAdapters.codex.edited(codex), true);
  assert.equal(cliAdapters.cursor.edited(codex), false);
  assert.equal(cliAdapters.cursor.edited(cursor), true);
  assert.equal(cliAdapters.codex.edited(cursor), false);
  assert.ok(parseCliEvent({ type: "turn.completed", error: null }));
});
test("runner-validated events and raw values produce the same activity", async () => {
  const { parseValidatedCliEvent } = await import("../server/activity.js");
  const raw = { type: "item.completed", item: { id: "m", type: "agent_message", text: "hello" } };
  const fromRaw: Activity[] = [], fromParsed: Activity[] = [];
  new ActivityAdapter("codex", 1, (text) => text, (e) => fromRaw.push(e), () => 1).receive(raw);
  new ActivityAdapter("codex", 1, (text) => text, (e) => fromParsed.push(e), () => 1).receive(parseValidatedCliEvent(raw));
  assert.deepEqual(fromParsed, fromRaw);
  assert.equal(parseValidatedCliEvent({ type: "assistant", message: { content: "private-invalid" } }), undefined);
});

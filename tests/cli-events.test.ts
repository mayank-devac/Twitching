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

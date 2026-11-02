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
// Each run's parser owns its edit trigger.
const run = (cli: keyof typeof cliAdapters) =>
  cliAdapters[cli].activity({ id: "session-1", cli, model: "m" }, 1, (text) => text, () => {}, { boundary: "docker", general: false });
test("validated events select only the correct CLI's edit trigger", () => {
  const codex = parseCliEvent({ type: "item.completed", item: { type: "file_change", changes: [{ path: "/workspace/prompt_1.html" }] } })!;
  const cursor = parseCliEvent({ type: "tool_call", subtype: "completed", tool_call: {} })!;
  assert.equal(run("codex").edited(codex), true);
  assert.equal(run("cursor").edited(codex), false);
  assert.equal(run("cursor").edited(cursor), true);
  assert.equal(run("codex").edited(cursor), false);
  assert.ok(parseCliEvent({ type: "turn.completed", error: null }));
});
test("Claude edit trigger fires only on results of its write and command calls", () => {
  const write = parseCliEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: {} }] } })!;
  const result = parseCliEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } })!;
  const text = parseCliEvent({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })!;
  const cursor = parseCliEvent({ type: "tool_call", subtype: "completed", tool_call: {} })!;
  const claude = run("claude");
  assert.equal(claude.edited(result), false, "a result with no known write call");
  assert.equal(claude.edited(write), false);
  assert.equal(claude.edited(text), false);
  assert.equal(claude.edited(cursor), false);
  assert.equal(claude.edited(result), true);
  // Another run never sees this run's pending calls.
  assert.equal(run("claude").edited(result), false);
  assert.equal(run("cursor").edited(result), false);
  assert.equal(run("codex").edited(result), false);
});
test("Claude events keep tool_use fields and string error kinds", () => {
  const use = parseCliEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "a.html" } }] } });
  assert.ok(use && typeof use.message === "object");
  assert.deepEqual(use.message?.content?.[0], { type: "tool_use", id: "t1", name: "Write", input: { file_path: "a.html" } });
  const retry = parseCliEvent({ type: "system", subtype: "api_retry", error: "rate_limit", attempt: 1 });
  assert.equal(retry?.error, "rate_limit");
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

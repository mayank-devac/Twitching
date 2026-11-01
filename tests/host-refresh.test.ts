import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { hostRefresh } from "../web/host-refresh.js";
import { applyHostState, applySnapshot, applyUpdate } from "../web/show-state.js";
import type { UpdateMessage } from "../shared/server-message.js";
import type { Activity, ShowState } from "../shared/types.js";

test("bursts use one active request and one follow-up; stale sessions never apply", async () => {
  const requests: { signal: AbortSignal; resolve(value: number): void; reject(error: Error): void }[] = [];
  const applied: number[] = [];
  const refresh = hostRefresh((signal) => new Promise<number>((resolve, reject) => requests.push({ signal, resolve, reject })), (value) => applied.push(value), 0);
  try {
    for (let n = 0; n < 100; n++) refresh.request();
    assert.equal(requests.length, 1);
    requests[0]!.resolve(1);
    await settle();
    assert.equal(requests.length, 2);
    requests[1]!.resolve(2);
    await settle();
    assert.deepEqual(applied, [1, 2]);
    assert.equal(requests.length, 2);
    refresh.request();
    refresh.invalidate();
    refresh.request();
    assert.equal(requests[2]!.signal.aborted, true);
    requests[2]!.resolve(3); // Even a fetch implementation ignoring abort cannot apply old content.
    await settle();
    assert.deepEqual(applied, [1, 2]);
    requests[3]!.reject(new Error("Disconnected"));
    await settle();
    refresh.request();
    requests[4]!.resolve(4);
    await settle();
    assert.deepEqual(applied, [1, 2, 4]);
    refresh.request();
    refresh.close();
    requests[5]!.resolve(5);
    await settle();
    assert.deepEqual(applied, [1, 2, 4]);
  } finally { refresh.close(); }
});

test("continuous output cannot start host fetches faster than the minimum interval", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const requests: ((value: number) => void)[] = [];
  const refresh = hostRefresh(() => new Promise<number>((resolve) => requests.push(resolve)), () => {});
  try {
    refresh.request();
    refresh.request();
    requests[0]!(1);
    await settle();
    assert.equal(requests.length, 1);
    t.mock.timers.tick(749);
    assert.equal(requests.length, 1);
    t.mock.timers.tick(1);
    assert.equal(requests.length, 2);
    refresh.request();
    requests[1]!(2);
    await settle();
    t.mock.timers.tick(750);
    assert.equal(requests.length, 3);
    requests[2]!(3);
    await settle();
  } finally { refresh.close(); }
});

const event = (id: string, lane?: Activity["lane"]) =>
  ({ id, agent: "session-1", kind: "message", text: id, ...(lane ? { lane } : {}) }) as Activity;
const show = (fields: Partial<ShowState> = {}) =>
  ({ status: "running", mode: "rehearsal", reason: "", candidates: [], candidateCount: 0, events: [], connections: {}, checks: [], rehearsalComplete: false, ...fields }) as ShowState;
const update = (state: ShowState, eventIds: string[] = [], patches: UpdateMessage["patches"] = []): UpdateMessage =>
  ({ type: "update", state, previewOrigin: "", patches, eventIds, overlayPatches: [], sessionPatches: [], sessionItemIds: [] });

test("a hidden frame keeps the host's private view, only marking it hidden", () => {
  const current = show({ events: [event("private", "terminal")], presentation: { hidden: false } as ShowState["presentation"] });
  const hidden = show({ status: "paused", presentation: { hidden: true } as ShowState["presentation"] });
  const kept = applyUpdate(current, update(hidden), true, false);
  assert.equal(kept.status, "running");
  assert.deepEqual(kept.events, current.events);
  assert.equal(kept.presentation?.hidden, true);
  assert.equal(applySnapshot(current, hidden, true, false).status, "running");
  // Public pages always take the frame as sent.
  assert.equal(applyUpdate(current, update(hidden), false, false).status, "paused");
});

test("frames carry host lanes over until the host context changes", () => {
  const current = show({ events: [event("public"), event("lane", "tool")] });
  const next = show({ events: [event("fresh")] });
  assert.deepEqual(applySnapshot(current, next, true, false).events.map((e) => e.id), ["fresh", "lane"]);
  assert.deepEqual(applySnapshot(current, next, true, true).events.map((e) => e.id), ["fresh"]);
  assert.deepEqual(applySnapshot(current, next, false, false).events.map((e) => e.id), ["fresh"]);
  const patched = applyUpdate(current, update(show(), ["public", "new"], [{ event: event("new") }]), true, false);
  assert.deepEqual(patched.events.map((e) => e.id), ["public", "new", "lane"]);
  assert.throws(() => applyUpdate(current, update(show(), ["missing"]), true, false));
});

test("a single-frame overlay snapshot doubles as the shared session", () => {
  const frame = { conversation: { id: "c1" }, page: { items: [] } };
  const one = applySnapshot(undefined, show({ sharedOverlay: { id: "o", frames: [frame] } as unknown as ShowState["sharedOverlay"] }), false, false);
  assert.equal(one.sharedSession, frame);
  const two = applySnapshot(undefined, show({ sharedOverlay: { id: "o", frames: [frame, frame] } as unknown as ShowState["sharedOverlay"] }), false, false);
  assert.equal(two.sharedSession, undefined);
});

test("a host refresh keeps the live public transcript and takes the private lanes", () => {
  const current = show({ events: [event("public"), event("old-lane", "read")] });
  const hostState = show({ status: "paused", events: [event("stale-public"), event("new-lane", "read")] });
  const merged = applyHostState(current, hostState);
  assert.equal(merged.status, "paused");
  assert.deepEqual(merged.events.map((e) => e.id), ["public", "new-lane"]);
  const hidden = show({ events: hostState.events, presentation: { hidden: true } as ShowState["presentation"] });
  assert.deepEqual(applyHostState(current, hidden).events, hidden.events);
});

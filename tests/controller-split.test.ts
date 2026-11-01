import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.js";
import { selectedPlatforms } from "../server/controller/options.js";
import { newRound, recordActivity } from "../server/controller/round-state.js";
import type { Activity, ShowState } from "../shared/types.js";

test("recordActivity stores new events once and replaces only changed text", () => {
  const store = new Store(":memory:");
  try {
    const state = { events: [] } as unknown as ShowState;
    const event = { id: "e1", round: 1, at: 1, agent: "codex", kind: "output", text: "a" } as Activity;
    assert.equal(recordActivity(state, store, event), true);
    assert.equal(recordActivity(state, store, { ...event }), false);
    assert.equal(recordActivity(state, store, { ...event, text: "b" }), true);
    assert.deepEqual(store.recent(1).map((e) => e.text), ["b"]);
    // An ID already in SQLite but not in memory is not re-announced.
    assert.equal(recordActivity({ events: [] } as unknown as ShowState, store, event), false);
  } finally {
    store.close();
  }
});

test("round and platform helpers keep their previous results", () => {
  const round = newRound(7, { text: "t", author: "a", platform: "fallback" }, [{ id: "codex", cli: "codex", model: "m" }] as never, 5);
  assert.deepEqual(round.attempts.codex, { cli: "codex", model: "m", effort: undefined, status: "running", startedAt: 5 });
  assert.deepEqual(selectedPlatforms({ kick: true }), { youtube: false, twitch: false, kick: true });
  assert.throws(() => selectedPlatforms({}), /Pick YouTube/);
});

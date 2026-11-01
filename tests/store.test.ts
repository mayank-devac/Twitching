import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/store.js";
import type { ShowState } from "../shared/types.js";

const legacyRows = {
  presentation: { revision: 3, outputs: { default: { source: "shared" } }, breakActive: false },
  last_setup: { savedAt: 42, path: "arena", runner: "docker", sessions: [] },
  overlay_settings: { revision: 2, overlays: [{ id: "default", name: "Main overlay" }] },
  quick_settings: { revision: 5, value: { future: true } },
  state: { status: "paused", mode: "rehearsal", reason: "old", candidates: [], candidateCount: 0, events: [], connections: {}, checks: [], rehearsalComplete: true },
};

function legacyDatabase() {
  const dir = mkdtempSync(resolve(tmpdir(), "store-test-"));
  const path = resolve(dir, "show.sqlite");
  const db = new DatabaseSync(path);
  for (const [table, value] of Object.entries(legacyRows)) {
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)`);
    db.prepare(`INSERT INTO ${table} VALUES (1,?)`).run(JSON.stringify(value));
  }
  db.close();
  return { dir, path };
}

test("legacy single-row tables migrate into documents once and keep their data", () => {
  const { dir, path } = legacyDatabase();
  try {
    let store = new Store(path);
    assert.deepEqual(store.presentation(), legacyRows.presentation);
    assert.deepEqual(store.lastSetup(), legacyRows.last_setup);
    assert.deepEqual(store.overlays(), legacyRows.overlay_settings);
    assert.deepEqual(store.quickSettings(), legacyRows.quick_settings);
    assert.equal(store.state()!.reason, "old");
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const legacy of Object.keys(legacyRows)) assert.ok(tables.includes(legacy), legacy);
    store.saveLastSetup({ ...legacyRows.last_setup, savedAt: 43 } as never);
    store.close();
    // Reopening must not re-run the copy or lose newer writes.
    store = new Store(path);
    assert.equal(store.lastSetup()!.savedAt, 43);
    assert.deepEqual(store.overlays(), legacyRows.overlay_settings);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid stored documents fall back to the missing-document default", () => {
  const store = new Store(":memory:");
  try {
    const put = store.db.prepare("INSERT OR REPLACE INTO documents VALUES (?,?)");
    put.run("overlays", JSON.stringify({ revision: "x", overlays: [] }));
    put.run("last_setup", "{not json");
    put.run("state", JSON.stringify({ round: { id: 1 } }));
    assert.equal(store.overlays(), undefined);
    assert.equal(store.lastSetup(), undefined);
    assert.equal(store.state(), undefined);
  } finally {
    store.close();
  }
});

test("saving state writes the round history row and state together", () => {
  const store = new Store(":memory:");
  try {
    const id = store.roundId();
    const state = {
      ...legacyRows.state,
      round: { id, task: { text: "draw a lighthouse", author: "a", platform: "fallback" }, launchedAt: 1, sessions: [], attempts: {} },
    } as unknown as ShowState;
    store.save(state);
    assert.equal(store.history().rounds[0]!.id, id);
    assert.equal(store.state()!.round!.id, id);
    // A failing write inside a transaction leaves neither half behind.
    assert.throws(() => store.transaction(() => {
      store.saveLastSetup({ savedAt: 1 } as never);
      throw new Error("boom");
    }), /boom/);
    assert.equal(store.lastSetup(), undefined);
  } finally {
    store.close();
  }
});

test("prune trims old append-only rows but keeps the current round and recent data", () => {
  const store = new Store(":memory:");
  try {
    const day = 24 * 60 * 60 * 1000, now = 100 * day;
    const current = store.roundId();
    store.save({ ...legacyRows.state, round: { id: current, task: { text: "t", author: "a", platform: "fallback" }, launchedAt: 1, sessions: [], attempts: {} } } as unknown as ShowState);
    const placeholder = store.roundId();
    const event = (id: string, round: number, at: number) =>
      store.event({ id, round, at, agent: "codex", kind: "output", text: id } as never);
    event("old-current", current, now - 60 * day);
    event("old-other", placeholder, now - 60 * day);
    event("recent-other", placeholder, now - day);
    const insertMessage = store.db.prepare("INSERT INTO messages VALUES (?,?)");
    insertMessage.run("old", now - 8 * day);
    insertMessage.run("new", now - day);
    const insertDecision = store.db.prepare("INSERT INTO decisions(at,window,value) VALUES (?,?,'{}')");
    insertDecision.run(now - 31 * day, 1);
    insertDecision.run(now - day, 2);
    for (let i = 0; i < 5003; i++) store.cachePut(`k${i}`, { safe: true } as never);

    assert.deepEqual(store.prune(now), { messages: 1, decisions: 1, events: 1, evaluations: 3, placeholders: 1 });
    const ids = (sql: string) => (store.db.prepare(sql).all() as { id: string }[]).map((r) => String(r.id));
    assert.deepEqual(ids("SELECT id FROM events ORDER BY id"), ["old-current", "recent-other"]);
    assert.deepEqual(ids("SELECT id FROM messages"), ["new"]);
    assert.deepEqual(ids("SELECT window AS id FROM decisions"), ["2"]);
    assert.equal(store.cache("k0"), undefined);
    assert.ok(store.cache("k5002"));
    assert.equal(store.history().rounds[0]!.id, current);
    // A second pass finds nothing more to remove.
    assert.deepEqual(store.prune(now), { messages: 0, decisions: 0, events: 0, evaluations: 0, placeholders: 0 });
  } finally {
    store.close();
  }
});

test("managed run IDs share the round sequence without leaving rounds rows", () => {
  const store = new Store(":memory:");
  try {
    const first = store.roundId();
    const run = store.runId();
    const next = store.roundId();
    assert.ok(run > first && next > run);
    const rows = store.db.prepare("SELECT id FROM rounds ORDER BY id").all() as { id: number }[];
    assert.deepEqual(rows.map((r) => r.id), [first, next]);
    // Deleting the newest row must not let SQLite hand its ID out again.
    const last = store.runId();
    assert.ok(last > next);
    assert.ok(store.runId() > last);
  } finally {
    store.close();
  }
});

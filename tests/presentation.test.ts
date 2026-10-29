import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import WebSocket from "ws";
import { Store } from "../server/store.js";
import { PresentationControls, presentationAction } from "../server/presentation-controls.js";
import { elapsed, stopwatch, privacyCommand } from "../shared/presentation.js";
import { makeHttp } from "../server/http.js";
import type { Controller } from "../server/controller.js";
import type { ShowState } from "../shared/types.js";
import { QuickSettings, defaultCriteria } from "../server/quick-settings.js";
import { defaultVisibility } from "../shared/settings.js";
import type { BreakMedia } from "../server/break-media.js";

const base = (): ShowState => ({
  status: "running", mode: "rehearsal", reason: "Private task", candidates: [], candidateCount: 0,
  events: [{ id: "answer", agent: "session-1", at: 1, round: 1, kind: "message", text: "Private answer" }],
  connections: {}, checks: [], rehearsalComplete: false,
});

// A controllable server clock checks timing and restart policy without waiting.
test("privacy persists independently; stopwatch survives goal changes and restores paused", () => {
  const store = new Store(":memory:");
  let now = 1000;
  try {
    const controls = new PresentationControls(store, (text) => text.replace("secret", "[redacted]"), () => now);
    controls.act({ action: "start" });
    now += 5000;
    controls.act({ action: "goal", text: "Fix secret\ncheckout", show: true });
    controls.act({ action: "hide" });
    controls.act({ action: "hide" });
    assert.equal(elapsed(controls.get()), 5000);
    assert.equal(controls.get().goal, "Fix [redacted] checkout");
    const hidden = controls.publicSnapshot({ ...base(), prepared: { text: "Private prompt", author: "Host", platform: "fallback" } });
    assert.equal(hidden.events.length, 0);
    assert.equal(hidden.prepared, undefined);
    assert.equal(hidden.presentation?.goal, "");
    assert.equal(JSON.stringify(hidden).includes("Private"), false);
    now += 2000;
    controls.checkpoint();
    const restored = new PresentationControls(store, (text) => text, () => now + 60_000);
    assert.equal(restored.get().hidden, true);
    assert.equal(restored.get().runningSince, undefined);
    assert.equal(elapsed(restored.get()), 7000);
    restored.act({ action: "show" });
    restored.act({ action: "show" });
    assert.equal(restored.get().hidden, false);
    assert.equal(restored.publicSnapshot(base()).events[0].text, "Private answer");
    controls.act({ action: "pause" });
    now += 1000;
    assert.equal(elapsed(controls.get()), 7000);
    controls.act({ action: "start" });
    now += 1000;
    controls.act({ action: "reset" });
    assert.equal(elapsed(controls.get()), 0);
    assert.equal(controls.get().runningSince, now);
    assert.equal(stopwatch(3_661_000), "01:01:01");
    assert.equal(presentationAction.safeParse({ action: "goal", text: "x".repeat(161), show: true }).success, false);
  } finally { store.close(); }
});

test("privacy shortcuts ignore editing, composition and key repeat", () => {
  const key = { altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, repeat: false, isComposing: false, keyCode: 72, code: "KeyH" };
  assert.equal(privacyCommand(key, false), "hide");
  assert.equal(privacyCommand({ ...key, code: "KeyS" }, false), "show");
  for (const changed of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { metaKey: true }, { ctrlKey: true }, { altKey: false }])
    assert.equal(privacyCommand({ ...key, ...changed }, false), undefined);
  assert.equal(privacyCommand(key, true), undefined);
});

test("outputs retain independent privacy, goals and clocks, or explicitly use the shared pair", () => {
  const store = new Store(":memory:");
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const definition = (id: string) => ({ id, name: id, selection: "selected" as const, sessionIds: [], published: false });
  let now = 1000;
  try {
    // The pre-existing Main output keeps the former shared goal.
    const controls = new PresentationControls(store, (text) => text, () => now);
    controls.act({ action: "goal", text: "Shared task", show: true });
    store.saveOverlays({ revision: 1, overlays: [definition("default"), definition(first), definition(second)] });
    assert.equal(controls.selection(first).source, "own");
    assert.equal(controls.get(first).goal, "");
    controls.act({ action: "goal", overlay: first, source: "own", text: "First task", show: true });
    controls.act({ action: "start", overlay: first, source: "own" });
    now += 3000;
    controls.act({ action: "goal", overlay: second, source: "own", text: "Second task", show: true });
    controls.act({ action: "start" });
    now += 2000;
    assert.equal(elapsed(controls.get(first)), 5000);
    assert.equal(elapsed(controls.get(second)), 0);
    controls.act({ action: "goal-source", overlay: second, source: "shared" });
    assert.equal(controls.get(second).goal, "Shared task");
    assert.equal(elapsed(controls.get(second)), 2000);
    assert.throws(() => controls.act({ action: "goal", overlay: second, source: "own", text: "Stale editor", show: true }), /source changed/);
    assert.equal(controls.get().goal, "Shared task");
    controls.act({ action: "goal", overlay: second, source: "shared", text: "Edited shared task", show: true });
    assert.equal(controls.get("default").goal, "Edited shared task");
    assert.equal(controls.get(first).goal, "First task");
    controls.act({ action: "hide", overlay: first });
    assert.equal(controls.publicSnapshot(base(), first).events.length, 0);
    assert.equal(controls.publicSnapshot(base(), second).events.length, 1);
    assert.equal(controls.get(second).hidden, false);
    assert.equal(JSON.stringify(controls.publicSnapshot(base(), second)).includes("First task"), false);
    assert.equal("outputs" in controls.get(), false);
    controls.act({ action: "hide-all" });
    controls.act({ action: "show", overlay: first });
    assert.equal(controls.get(first).hidden, true);
    controls.act({ action: "hide", overlay: first });
    controls.act({ action: "show-all" });
    assert.equal(controls.get(first).hidden, true);
    assert.equal(controls.get(second).hidden, false);
    controls.act({ action: "goal-source", overlay: second, source: "own" });
    assert.equal(controls.get(second).goal, "Second task");
    assert.equal(elapsed(controls.get(second)), 0);
    controls.checkpoint();
    const restored = new PresentationControls(store, (text) => text, () => now + 100_000);
    assert.equal(restored.get(first).hidden, true);
    assert.equal(restored.get(first).runningSince, undefined);
    assert.equal(elapsed(restored.get(first)), 5000);
    assert.equal(restored.selection(second).source, "own");
    assert.equal(restored.get(second).goal, "Second task");
    assert.equal(restored.get("default").runningSince, undefined);
    assert.equal(elapsed(restored.get("default")), 2000);
    store.saveOverlays({ revision: 2, overlays: [definition("default"), definition(second)] });
    assert.throws(() => restored.act({ action: "show", overlay: first }), /no longer exists/);
    assert.equal(restored.publicSnapshot(base(), first).events.length, 0);
  } finally { store.close(); }
});

// Exercise the real HTTP/WebSocket boundary; these fixtures never run a CLI or OBS.
test("hide clears public snapshots, reconnect stays hidden, reveal sends a full current snapshot", async () => {
  const store = new Store(":memory:");
  const presentation = new PresentationControls(store, (text) => text);
  const current = base();
  let starts = 0;
  const controller = Object.assign(new EventEmitter(), {
    state: current, snapshot: () => structuredClone(current), hostSnapshot: () => structuredClone(current),
    start: async () => { starts++; }, assertSettingsChange: () => {}, settingsChanged: () => {},
  }) as unknown as Controller;
  const preferences = new QuickSettings(store, {
    sessions: [{ id: "session-1", cli: "codex", model: "fixture" }],
    visibility: { "session-1": { ...defaultVisibility } },
    stream: { mode: "rehearsal", youtube: false, twitch: false, kick: false, collectionMs: 1000, extensionMs: 1000, resultMs: 1000 },
    jevCriteria: defaultCriteria, jevProbe: "Explain this function safely", media: {},
  });
  const origin = "http://127.0.0.1:39233";
  const http = makeHttp(controller, {
    presentation, host: "127.0.0.1", port: 39233, root: "/unused-presentation-fixture",
    previewOrigin: "http://127.0.0.1:39234", musicPath: "/unused.mp3",
    quick: { store, preferences, media: {} as BreakMedia, runner: "docker", discover: async () => [{ id: "fixture", efforts: [] }] },
  });
  await new Promise<void>((resolve) => http.server.listen(39233, "127.0.0.1", resolve));
  const socket = new WebSocket(origin.replace("http", "ws") + "/events", { origin });
  try {
    await once(socket, "message");
    const host = await fetch(origin + "/api/host");
    const { csrf } = await host.json() as { csrf: string };
    const headers = { Origin: origin, "Content-Type": "application/json", "X-Host-Token": csrf, Cookie: host.headers.get("set-cookie")!.split(";")[0] };
    const post = (path: string, body: unknown) => fetch(origin + path, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await fetch(origin + "/api/presentation", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: '{"action":"hide"}' })).status, 403);
    const hiddenMessage = once(socket, "message");
    assert.equal((await post("/api/presentation", { action: "hide" })).status, 200);
    const hidden = JSON.parse(String((await hiddenMessage)[0]));
    assert.equal(hidden.type, "snapshot");
    assert.equal(hidden.state.presentation.hidden, true);
    assert.equal(JSON.stringify(hidden).includes("Private answer"), false);
    current.events[0].text += " while hidden";
    const update = once(socket, "message");
    controller.emit("state");
    assert.equal(String((await update)[0]).includes("while hidden"), false);
    const reconnect = new WebSocket(origin.replace("http", "ws") + "/events", { origin });
    const reconnected = JSON.parse(String((await once(reconnect, "message"))[0]));
    assert.equal(reconnected.state.presentation.hidden, true);
    reconnect.terminate();
    const hostState = await fetch(origin + "/api/host-state", { headers });
    assert.equal((await hostState.json()).events[0].text, "Private answer while hidden");
    const revealedMessage = once(socket, "message");
    await post("/api/presentation", { action: "show" });
    const revealed = JSON.parse(String((await revealedMessage)[0]));
    assert.equal(revealed.type, "snapshot");
    assert.equal(revealed.state.events[0].text, "Private answer while hidden");
    assert.equal(starts, 0);

    // Restoring reviewed choices keeps privacy hidden and never invokes Start.
    await post("/api/last-setup", { path: "arena", runner: "docker" });
    const saved = (await (await fetch(origin + "/api/last-setup", { headers })).json()).setup;
    assert.equal(saved.jevProbe, undefined);
    await post("/api/presentation", { action: "hide" });
    assert.equal((await post("/api/last-setup/apply", { revision: preferences.get().revision, savedAt: saved.savedAt })).status, 200);
    assert.equal(presentation.get().hidden, true);
    assert.equal(starts, 0);

    const review = await (await fetch(origin + "/api/rehearsal?context=arena", { headers })).json();
    const confirmed = { context: "arena", key: review.key, session: true, readable: true, visible: true, audible: true };
    assert.equal((await post("/api/rehearsal", confirmed)).status, 409);
    await post("/api/presentation", { action: "show" });
    assert.equal((await post("/api/rehearsal", confirmed)).status, 200);
    const doc = preferences.get();
    preferences.save(doc.revision, { ...doc.value, stream: { ...doc.value.stream, collectionMs: 2000 } });
    assert.equal((await (await fetch(origin + "/api/rehearsal?context=arena", { headers })).json()).confirmed, true);
    presentation.act({ action: "goal", text: "Changed text to check", show: true });
    assert.equal((await (await fetch(origin + "/api/rehearsal?context=arena", { headers })).json()).confirmed, false);

    // A named output hides through its own socket without hiding Main.
    const namedId = "33333333-3333-4333-8333-333333333333";
    store.saveOverlays({ revision: 1, overlays: [
      { id: "default", name: "Main", selection: "selected", sessionIds: [], published: false },
      { id: namedId, name: "Named", selection: "selected", sessionIds: [], published: false },
    ] });
    const named = new WebSocket(origin.replace("http", "ws") + `/events?overlay=${namedId}`, { origin });
    const first = JSON.parse(String((await once(named, "message"))[0]));
    assert.equal(first.state.presentation.goal, "");
    const namedHidden = once(named, "message");
    assert.equal((await post("/api/presentation", { action: "hide", overlay: namedId })).status, 200);
    const namedPayload = JSON.parse(String((await namedHidden)[0]));
    assert.equal(namedPayload.type, "snapshot");
    assert.equal(namedPayload.state.presentation.hidden, true);
    assert.equal(JSON.stringify(namedPayload).includes("Private answer"), false);
    assert.equal((await (await fetch(origin + "/api/state")).json()).presentation.hidden, false);
    const namedShown = once(named, "message");
    await post("/api/presentation", { action: "show", overlay: namedId });
    assert.equal(JSON.parse(String((await namedShown)[0])).state.events[0].text, "Private answer while hidden");
    named.terminate();
  } finally { socket.terminate(); await http.close(); store.close(); }
});

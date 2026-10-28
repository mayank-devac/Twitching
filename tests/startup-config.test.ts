import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeStartup, resolveStartup, selectStartupSessions, startupConfigurationId,
} from "../server/startup-config.js";
import { chooseSessions, parseSessionSpec } from "../scripts/session-selection.js";

// Public fixture only; importing the parser must never load .env.local.
const raw = {
  host: "127.0.0.1", port: 3210, previewPort: 3211, webhookPort: 3212, browserPort: 3213,
  collectionMs: 30000, extensionMs: 30000, resultMs: 10000,
  quotaGraceMs: 600000, quotaPollMs: 10000,
  codexModel: "model-a", cursorModel: "model-b", agentImage: "fixture:local", previewImage: "fixture:local",
  mode: "rehearsal", safetyThreshold: 0.9, relevanceThreshold: 0.8, minScore: 50,
  jevProbe: "Choose a colourful visual", blockedWords: [], musicPath: "assets/break.mp3", visualPath: "assets/break.html",
  obsUrl: "ws://127.0.0.1:4455", stopObsOnEnd: false, kickWebhookUrl: "", kickListenHost: "127.0.0.1",
};
const root = "/tmp/arena-startup-fixture";
test("parent choices and child environment resolve to the same normalized startup hash", () => {
  const initial = resolveStartup(raw, {}, root, false);
  const selected = selectStartupSessions(initial, [parseSessionSpec(" codex : model-a : high ", 0)], root);
  const child = resolveStartup(raw, { ARENA_SESSIONS: JSON.stringify(selected.sessions) }, root, false);
  assert.equal(startupConfigurationId(selected), startupConfigurationId(child));
  assert.equal(startupConfigurationId(normalizeStartup(selected, root)), startupConfigurationId(selected));
  // Saved web timing preferences are applied after this immutable boot identity.
  const boot = startupConfigurationId(child);
  child.collectionMs = 60000;
  assert.notEqual(startupConfigurationId(child), boot);
  assert.equal(boot, startupConfigurationId(selected));
});
test("explicit single CLI and explicit sessions each override file sessions", () => {
  const saved = { ...raw, sessions: [parseSessionSpec("codex:old-model", 0)] };
  const solo = resolveStartup(saved, { ARENA_SINGLE_AGENT: "cursor" }, root, false);
  assert.deepEqual(solo.sessions, [{ id: "cursor", cli: "cursor", model: "model-b" }]);
  const chosen = [parseSessionSpec("codex:model-a", 0), parseSessionSpec("codex:model-c:high", 1)];
  assert.deepEqual(resolveStartup(saved, { ARENA_SESSIONS: JSON.stringify(chosen) }, root, false).sessions, chosen);
});
test("session flags reject missing models, empty efforts and a third session", () => {
  for (const spec of ["codex", "codex:", "codex:m:", "other:m", "codex:m:high:extra"])
    assert.throws(() => parseSessionSpec(spec, 0), /Use --session/);
  assert.throws(() => parseSessionSpec("codex:m", 2), /at most twice/);
});
test("interactive selection discovers once for two sessions of the same CLI", async () => {
  const answers = ["2", "1", "1", "high", "1", "2", ""];
  let discoveries = 0;
  const selected = await chooseSessions(async () => answers.shift()!, async () => {
    discoveries++;
    return [{ id: "a", efforts: ["high"] }, { id: "b", efforts: [] }];
  }, () => {});
  assert.equal(discoveries, 1);
  assert.deepEqual(selected, [parseSessionSpec("codex:a:high", 0), parseSessionSpec("codex:b", 1)]);
});

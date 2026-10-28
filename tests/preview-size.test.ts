import test from "node:test";
import assert from "node:assert/strict";
import { viewportFor } from "../server/preview.js";
import { legacyModel, SESSION_IDS, sessionCli, sessionCount, sessionLabel, validSessionId } from "../shared/types.js";

test("every result size is explicitly based on one or two sessions", () => {
  assert.deepEqual(viewportFor(1), { width: 1920, height: 1044 });
  assert.deepEqual(viewportFor(2), { width: 960, height: 1044 });
  assert.throws(() => sessionCount([]), /one or two/);
  assert.throws(() => sessionCount([1, 2, 3]), /one or two/);
});
test("session helpers keep legacy CLI IDs distinct from numbered session IDs", () => {
  assert.ok(SESSION_IDS.every(validSessionId));
  assert.equal(validSessionId("../other"), false);
  assert.equal(sessionCli({ sessions: [{ id: "session-2", cli: "codex", model: "m" }] }, "session-2"), "codex");
  assert.equal(sessionCli({}, "cursor"), "cursor");
  assert.equal(sessionCli({}, "session-1"), undefined);
  assert.deepEqual(legacyModel("m · high"), { model: "m", effort: "high" });
  assert.equal(sessionLabel(legacyModel("m · high")), "m · high");
  assert.deepEqual(legacyModel("m · other"), { model: "m · other" });
});

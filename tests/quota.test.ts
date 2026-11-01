import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuota } from "../server/runner.js";

test("parseQuota reads the five-hour window from either bucket", () => {
  assert.deepEqual(
    parseQuota({
      rateLimits: { primary: { windowDurationMins: 15, usedPercent: 1, resetsAt: 1 } },
      rateLimitsByLimitId: {
        codex: {
          primary: null,
          secondary: { windowDurationMins: 300, usedPercent: 40, resetsAt: 10 },
        },
      },
    }),
    { remainingPercent: 60, resetsAt: 10000 },
  );
  assert.deepEqual(
    parseQuota({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 120, resetsAt: 2 } } }),
    { remainingPercent: 0, resetsAt: 2000 },
  );
});

test("parseQuota rejects malformed or incomplete usage reports clearly", () => {
  for (const bad of [null, "limits", { rateLimits: { primary: { usedPercent: "50" } } }])
    assert.throws(() => parseQuota(bad), /unreadable usage report/);
  assert.throws(() => parseQuota({}), /did not expose/);
  assert.throws(
    () => parseQuota({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 10 } } }),
    /did not expose/,
  );
});

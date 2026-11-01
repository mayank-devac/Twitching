import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  cliSchema,
  runnerModeSchema,
  sessionConfigSchema,
  sessionIdSchema,
  sessionListSchema,
  streamModeSchema,
} from "../shared/schema.js";
import {
  CLIS,
  SESSION_IDS,
  configuredSessions,
  isCli,
  legacyCli,
  startupModels,
} from "../shared/types.js";
import { startupSchema } from "../server/startup-config.js";

const ok = (schema: z.ZodType, value: unknown) =>
  assert.equal(schema.safeParse(value).success, true, JSON.stringify(value));
const bad = (schema: z.ZodType, value: unknown) =>
  assert.equal(schema.safeParse(value).success, false, JSON.stringify(value));

test("CLI and runner enums accept exactly the known values", () => {
  assert.deepEqual([...CLIS], ["codex", "cursor"]);
  for (const cli of CLIS) ok(cliSchema, cli);
  for (const value of ["", "Codex", "claude", "managed", undefined, 1]) bad(cliSchema, value);
  assert.equal(isCli("cursor"), true);
  assert.equal(isCli("session-1"), false);
  assert.equal(legacyCli("codex"), "codex");
  assert.equal(legacyCli("session-2"), undefined);
  ok(runnerModeSchema, "docker");
  ok(runnerModeSchema, "native");
  for (const value of ["", "Docker", "host", undefined]) bad(runnerModeSchema, value);
  ok(streamModeSchema, "live");
  ok(streamModeSchema, "rehearsal");
  bad(streamModeSchema, "preview");
});

test("session ids are limited to the fixed slot names", () => {
  for (const id of SESSION_IDS) ok(sessionIdSchema, id);
  for (const id of ["session-3", "managed:abc", "", "CODEX"]) bad(sessionIdSchema, id);
});

test("saved session configs stay strict and bounded", () => {
  const base = { id: "session-1", cli: "codex", model: "m" };
  ok(sessionConfigSchema, base);
  ok(sessionConfigSchema, { ...base, effort: "high" });
  assert.deepEqual(sessionConfigSchema.parse({ ...base, model: "  m  " }), base);
  ok(sessionConfigSchema, { ...base, model: "x".repeat(160) });
  bad(sessionConfigSchema, { ...base, model: "x".repeat(161) });
  bad(sessionConfigSchema, { ...base, model: "   " });
  bad(sessionConfigSchema, { ...base, effort: "" });
  bad(sessionConfigSchema, { ...base, effort: "x".repeat(41) });
  bad(sessionConfigSchema, { ...base, cli: "claude" });
  bad(sessionConfigSchema, { ...base, id: "session-9" });
  bad(sessionConfigSchema, { ...base, extra: true });
});

test("session lists hold one or two unique ids", () => {
  const list = sessionListSchema(sessionConfigSchema);
  const a = { id: "codex", cli: "codex", model: "a" };
  const b = { id: "cursor", cli: "cursor", model: "b" };
  ok(list, [a]);
  ok(list, [a, b]);
  bad(list, []);
  bad(list, [a, b, { ...a, id: "session-1" }]);
  bad(list, [a, { ...b, id: "codex" }]);
});

test("startup sessions keep their looser text limits and error messages", () => {
  const sessions = startupSchema.shape.sessions;
  // No length cap and unknown keys are stripped rather than rejected.
  assert.deepEqual(
    sessions.parse([{ id: "session-1", cli: "cursor", model: "x".repeat(300), extra: 1 }]),
    [{ id: "session-1", cli: "cursor", model: "x".repeat(300) }],
  );
  ok(sessions, undefined);
  const duplicate = sessions.safeParse([
    { id: "codex", cli: "codex", model: "a" },
    { id: "codex", cli: "codex", model: "b" },
  ]);
  assert.equal(duplicate.error?.issues[0]?.message, "Session IDs must be unique");
  const unknown = sessions.safeParse([{ id: "nope", cli: "codex", model: "a" }]);
  assert.equal(unknown.error?.issues[0]?.message, `Use ${SESSION_IDS.join(", ")}`);
  ok(startupSchema.shape.singleAgent, "cursor");
  bad(startupSchema.shape.singleAgent, "claude");
  assert.equal(startupSchema.shape.runnerMode.parse(undefined), "docker");
  bad(startupSchema.shape.runnerMode, "host");
});

test("flat startup model keys read as a per-CLI map without changing session shape", () => {
  const options = { codexModel: "a", cursorModel: "b" };
  assert.deepEqual(startupModels(options), {
    codex: { model: "a", effort: "high" },
    cursor: { model: "b" },
  });
  assert.deepEqual(configuredSessions(options), [
    { id: "cursor", cli: "cursor", model: "b" },
    { id: "codex", cli: "codex", model: "a", effort: "high" },
  ]);
  assert.deepEqual(
    Object.keys(configuredSessions({ ...options, codexEffort: "low", singleAgent: "codex" })[0]),
    ["id", "cli", "model", "effort"],
  );
});

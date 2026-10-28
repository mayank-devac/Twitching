import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  availableSandboxResults,
  parseSandboxResultSelection,
  preserveSandboxResult,
  preserveSelectedSandboxResults,
  preserveUnexportedSandboxResults,
} from "../server/sandbox-results.js";

test("parses one, many, deduplicated, and all export selections", () => {
  assert.deepEqual(parseSandboxResultSelection("1", 3), [0]);
  assert.deepEqual(parseSandboxResultSelection("1, 3,2,1", 3), [0, 2, 1]);
  assert.equal(parseSandboxResultSelection("A", 3), "all");
  assert.equal(parseSandboxResultSelection("1,4", 3), undefined);
  assert.equal(parseSandboxResultSelection("1,,2", 3), undefined);
});

test("lists only existing Docker prompts and marks exported results", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-results-"));
  const live = resolve(root, "runtime/workspaces/codex/3");
  const archived = resolve(root, "runtime/archive/workspaces/cursor/2");
  const native = resolve(root, "runtime/native-workspaces/codex/4");
  try {
    for (const dir of [live, archived, native])
      await mkdir(dir, { recursive: true });
    await writeFile(resolve(live, "prompt_3.html"), "<h1>live</h1>");
    await writeFile(resolve(archived, "prompt_2.html"), "<h1>old</h1>");
    await writeFile(resolve(native, "prompt_4.html"), "<h1>native</h1>");
    await preserveSandboxResult(root, "codex", 3, live);

    const results = await availableSandboxResults(root);
    assert.deepEqual(
      results.map(({ agent, round, archived, exported }) => ({
        agent,
        round,
        archived,
        exported,
      })),
      [
        { agent: "codex", round: 3, archived: false, exported: true },
        { agent: "cursor", round: 2, archived: true, exported: false },
      ],
    );
    assert.equal(
      await readFile(
        resolve(root, "runtime/sandbox_results/codex/prompt_3.html"),
        "utf8",
      ),
      "<h1>live</h1>",
    );

    const bulk = await preserveUnexportedSandboxResults(root, results);
    assert.deepEqual(
      bulk.saved.map(({ agent, round }) => ({ agent, round })),
      [{ agent: "cursor", round: 2 }],
    );
    assert.deepEqual(bulk.failed, []);
    assert.equal(
      await readFile(
        resolve(root, "runtime/sandbox_results/cursor/prompt_2.html"),
        "utf8",
      ),
      "<h1>old</h1>",
    );

    const selected = await preserveSelectedSandboxResults(root, results);
    assert.equal(selected.saved.length, 2);
    assert.deepEqual(selected.failed, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

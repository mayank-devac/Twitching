import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { enforceDiskBudget } from "../server/disk-budget.js";

const limits = { soft: 20, hard: 80 };

async function plant(root: string) {
  const round1 = resolve(root, "runtime/workspaces/codex/1");
  const round2 = resolve(root, "runtime/workspaces/codex/2");
  const auth = resolve(root, "runtime/auth/codex");
  await mkdir(resolve(round1, ".tmp"), { recursive: true });
  await mkdir(round2, { recursive: true });
  await mkdir(auth, { recursive: true });
  await writeFile(resolve(round1, ".tmp", "scratch"), "temporary-bytes-aaaa");
  await writeFile(resolve(round1, "old.html"), "old-round-output-bbbb");
  await mkdir(resolve(round2, ".tmp"), { recursive: true });
  await writeFile(resolve(round2, "live.html"), "newest-round-keep-cccc");
  await writeFile(resolve(round2, ".tmp", "live"), "keep");
  await writeFile(resolve(auth, "secret"), "do-not-touch-this-file");
}

test("temporary files are removed and the newest round stays", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-disk-"));
  await plant(root);
  const result = await enforceDiskBudget(root, limits);
  assert.equal(result.deletedTmp, 2);
  assert.equal(result.moved, 1);
  await assert.rejects(lstat(resolve(root, "runtime/workspaces/codex/1/.tmp")));
  await lstat(resolve(root, "runtime/archive/workspaces/codex/1/old.html"));
  await lstat(resolve(root, "runtime/workspaces/codex/2/live.html"));
  await lstat(resolve(root, "runtime/auth/codex/secret"));
});

test("archived rounds are deleted only after the 1 GB ceiling", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-disk-"));
  await plant(root);
  const tight = { soft: 10, hard: 25 };
  const result = await enforceDiskBudget(root, tight);
  assert.equal(result.deletedArchive, 1);
  await assert.rejects(
    lstat(resolve(root, "runtime/archive/workspaces/codex/1/old.html")),
  );
  await lstat(resolve(root, "runtime/workspaces/codex/2/live.html"));
});

test("temporary files go away even when the tree is under the cap", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-disk-"));
  await plant(root);
  const result = await enforceDiskBudget(root, { soft: 10_000, hard: 20_000 });
  assert.equal(result.deletedTmp, 2);
  assert.equal(result.moved, 0);
  await assert.rejects(lstat(resolve(root, "runtime/workspaces/codex/1/.tmp")));
  await lstat(resolve(root, "runtime/workspaces/codex/1/old.html"));
  await assert.rejects(lstat(resolve(root, "runtime/workspaces/codex/2/.tmp")));
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Docker } from "../server/docker.js";
import { Store } from "../server/store.js";
import { loginGuard, LoginRefreshConflict, copyLoginFile } from "../server/login-guard.js";

for (const cli of ["codex", "cursor"] as const)
  test(`${cli}: simultaneous refreshes from separate hosts cannot overwrite the winning login`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), "arena-login-guard-"));
    const store = new Store(":memory:");
    try {
      const file = cli === "codex" ? ".codex/auth.json" : ".cursor/auth.json";
      const saved = resolve(root, "runtime/auth", cli, file);
      await mkdir(resolve(saved, ".."), { recursive: true });
      await writeFile(saved, "fixture-original");
      const hosts = [new Docker(store, { root, image: "unused" }), new Docker(store, { root, image: "unused" })];
      const homes = await Promise.all(hosts.map((host, i) => host.workspace({ cli, round: 1, session: `session-${i + 1}` })));
      await Promise.all(homes.map((home, i) => writeFile(resolve(home, ".home", file), `fixture-refresh-${i}`)));
      const results = await Promise.allSettled(hosts.map((host, i) => host.retainAuth(cli, homes[i])));
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const failure = results.find((result) => result.status === "rejected");
      assert.ok(failure?.status === "rejected" && failure.reason instanceof LoginRefreshConflict);
      const winner = results.findIndex((result) => result.status === "fulfilled");
      assert.equal(await readFile(saved, "utf8"), `fixture-refresh-${winner}`);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

test("a failed retained write releases the lock and keeps the previous baseline", async () => {
  const guard = loginGuard("/tmp/arena-failed-retention-fixture", "codex");
  let saved = "old";
  await guard.prepare("home", async () => {}, async () => saved);
  await assert.rejects(guard.retain("home", async () => "new", async () => saved, async () => { throw new Error("fixture write denied"); }), /write denied/);
  await guard.retain("home", async () => "new", async () => saved, async () => { saved = "new"; });
  assert.equal(saved, "new");
});

test("unsafe login destination is rejected without replacing its original contents", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "arena-login-atomic-"));
  try {
    const profile = resolve(root, "profile");
    await mkdir(profile);
    const source = resolve(profile, "auth.json");
    const outside = resolve(root, "saved.json");
    await writeFile(source, "fixture-new");
    await writeFile(outside, "fixture-original");
    await assert.rejects(copyLoginFile(source, outside, profile, profile), /inside its profile/);
    assert.equal(await readFile(outside, "utf8"), "fixture-original");
  } finally { await rm(root, { recursive: true, force: true }); }
});

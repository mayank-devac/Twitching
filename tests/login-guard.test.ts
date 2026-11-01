import test from "node:test";
import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Docker } from "../server/docker.js";
import { Store } from "../server/store.js";
import { writeFileAtomic, writeFileAtomicSync } from "../server/atomic-file.js";
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
      const results = await Promise.allSettled(hosts.map((host, i) => host.retainAuth(cli, homes[i]!)));
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

test("a reused workspace whose .home is a planted symlink is refused", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "arena-home-link-"));
  const store = new Store(":memory:");
  try {
    const outside = resolve(root, "outside");
    await mkdir(outside);
    const dir = resolve(root, "runtime/workspaces/session-1/reused");
    await mkdir(dir, { recursive: true });
    await symlink(outside, resolve(dir, ".home"));
    const host = new Docker(store, { root, image: "unused" });
    await assert.rejects(host.workspace({ cli: "codex", round: "reused", session: "session-1", auth: false }), /real directory/);
    assert.deepEqual(await readdir(outside), []);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("cursor retains only auth.json; agent-edited config is seeded but never copied back", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "arena-cursor-retain-"));
  const store = new Store(":memory:");
  try {
    const saved = resolve(root, "runtime/auth/cursor/.cursor");
    await mkdir(saved, { recursive: true });
    await writeFile(resolve(saved, "auth.json"), "fixture-original");
    await writeFile(resolve(saved, "cli-config.json"), "fixture-trusted");
    const host = new Docker(store, { root, image: "unused" });
    const dir = await host.workspace({ cli: "cursor", round: 1 });
    const home = resolve(dir, ".home/.cursor");
    assert.equal(await readFile(resolve(home, "cli-config.json"), "utf8"), "fixture-trusted");
    await writeFile(resolve(home, "cli-config.json"), "fixture-agent");
    await writeFile(resolve(home, "auth.json"), "fixture-refresh");
    await host.retainAuth("cursor", dir);
    assert.equal(await readFile(resolve(saved, "auth.json"), "utf8"), "fixture-refresh");
    assert.equal(await readFile(resolve(saved, "cli-config.json"), "utf8"), "fixture-trusted");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a retained arena login discards its .home copy; a failed retain keeps it", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "arena-discard-home-"));
  const store = new Store(":memory:");
  try {
    const saved = resolve(root, "runtime/auth/cursor/.cursor/auth.json");
    await mkdir(resolve(saved, ".."), { recursive: true });
    await writeFile(saved, "fixture-original");
    const host = new Docker(store, { root, image: "unused" });
    const kept = await host.workspace({ cli: "cursor", round: 1, session: "session-1" });
    const discarded = await host.workspace({ cli: "cursor", round: 1, session: "session-2" });
    await writeFile(resolve(kept, ".home/.cursor/auth.json"), "fixture-refresh-a");
    await writeFile(resolve(discarded, ".home/.cursor/auth.json"), "fixture-refresh-b");
    await host.retainAuth("cursor", discarded, { discardHome: true });
    await assert.rejects(access(resolve(discarded, ".home")), { code: "ENOENT" });
    await assert.rejects(host.retainAuth("cursor", kept, { discardHome: true }), LoginRefreshConflict);
    assert.equal(await readFile(resolve(kept, ".home/.cursor/auth.json"), "utf8"), "fixture-refresh-a");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("atomic runtime writes replace a planted link instead of following it", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "arena-atomic-"));
  try {
    const target = resolve(root, "outside.txt");
    await writeFile(target, "keep");
    for (const [name, write] of [
      ["async.json", writeFileAtomic],
      ["sync.json", writeFileAtomicSync],
    ] as const) {
      const path = resolve(root, name);
      await symlink(target, path);
      await write(path, "fresh", 0o600);
      assert.ok((await lstat(path)).isFile());
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal(await readFile(path, "utf8"), "fresh");
    }
    assert.equal(await readFile(target, "utf8"), "keep");
    assert.deepEqual((await readdir(root)).sort(), ["async.json", "outside.txt", "sync.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

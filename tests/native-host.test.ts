import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { NativeHost } from "../server/native-host.js";
import {
  cleanupProbeWorkspaces,
  removeProbeWorkspace,
} from "../server/probe-workspace-cleanup.js";
import { Store } from "../server/store.js";
import { instructions } from "../server/runner.js";

class MetadataHost extends NativeHost {
  override async capture(_agent: "codex" | "cursor", args: string[]) {
    return args.includes("--help") ? "--sandbox --print --model" : "test CLI";
  }
}
test("native coding requires explicit confirmation and leaves no runner when rejected", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-native-"));
  const store = new Store(":memory:");
  const host = new NativeHost(store, root);
  const previous = process.env.ARENA_NATIVE_APPROVED;
  delete process.env.ARENA_NATIVE_APPROVED;
  try {
    await assert.rejects(
      () => host.create("codex", 1, ["codex", "exec", "task"]),
      /not confirmed/,
    );
    assert.deepEqual(store.containers(), []);
  } finally {
    if (previous === undefined) delete process.env.ARENA_NATIVE_APPROVED;
    else process.env.ARENA_NATIVE_APPROVED = previous;
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("native cleanup handles a fast CLI exit but refuses unverified recovered groups", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-native-"));
  const store = new Store(":memory:");
  const host = new NativeHost(store, root);
  const name = host.name("codex", "check-fast-exit");
  const pid = 123456;
  const signals: string[] = [];
  let alive = true;
  const originalKill = process.kill;
  try {
    (host as any).prepared.set(name, {
      record: { pid, stamp: "" },
      process: { pid },
    });
    (host as any).groupAlive = () => alive;
    (host as any).stamp = () => "";
    process.kill = ((target: number, signal: string) => {
      assert.equal(target, -pid);
      signals.push(signal);
      alive = false;
      return true;
    }) as typeof process.kill;
    await host.stop(name);
    assert.deepEqual(signals, ["SIGTERM"]);

    (host as any).prepared.set(name, { record: { pid, stamp: "" } });
    alive = true;
    await assert.rejects(() => host.stop(name), /Cannot verify ownership/);
    assert.deepEqual(signals, ["SIGTERM"]);
  } finally {
    process.kill = originalKill;
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  "absent",
  "descendant",
  "ps-failure",
  "incomplete",
] as const)
  test(`EPERM cleanup verifies the whole group: ${scenario}`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), "stram-native-permission-"));
    const store = new Store(":memory:");
    const host = new NativeHost(store, root);
    const name = host.name(
      "cursor",
      "check-11111111-1111-4111-8111-111111111111",
    );
    const recordPath = resolve(
      root,
      "runtime/native-processes",
      `${name}.json`,
    );
    const pid = 123456;
    const checks: Array<string | number> = [];
    const originalKill = process.kill;
    await mkdir(resolve(root, "runtime/native-processes"), { recursive: true });
    await writeFile(
      recordPath,
      JSON.stringify({ pid, stamp: "fixture-start" }),
    );
    store.container(name);
    (host as any).processGroups = () => {
      if (scenario === "ps-failure") throw new Error("process listing denied");
      if (scenario === "incomplete") return "555 555\n";
      return `${process.pid} ${process.pid}\n${scenario === "descendant" ? `98765 ${pid}\n` : ""}`;
    };
    try {
      process.kill = ((target: number, signal: string | number) => {
        assert.equal(target, -pid);
        checks.push(signal);
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      }) as typeof process.kill;
      if (scenario === "absent") {
        await host.stop(name);
        assert.deepEqual(store.containers(), []);
        await assert.rejects(stat(recordPath), { code: "ENOENT" });
      } else {
        await assert.rejects(
          host.stop(name),
          (error: any) =>
            error.code === "EPERM" && /record is kept/.test(error.message),
        );
        assert.deepEqual(store.containers(), [name]);
        await stat(recordPath);
      }
      assert.deepEqual(checks, [0]);
    } finally {
      process.kill = originalKill;
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

test("Codex exec help is metadata before native consent; coding still requires consent", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-native-help-"));
  const store = new Store(":memory:");
  const host = new NativeHost(store, root);
  const previous = process.env.ARENA_NATIVE_APPROVED;
  delete process.env.ARENA_NATIVE_APPROVED;
  try {
    const help = await host.create(
      "codex",
      "check-11111111-1111-4111-8111-111111111111",
      ["codex", "exec", "--help"],
    );
    await host.stop(help.name);
    await assert.rejects(
      host.create("codex", 1, ["codex", "exec", "--help", "task"]),
      /not confirmed/,
    );
    await assert.rejects(
      host.create("codex", 1, ["codex", "exec", "task"]),
      /not confirmed/,
    );
    assert.deepEqual(store.containers(), []);
  } finally {
    if (previous === undefined) delete process.env.ARENA_NATIVE_APPROVED;
    else process.env.ARENA_NATIVE_APPROVED = previous;
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a group exiting before SIGTERM is harmless; denied SIGTERM keeps its record", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-native-signal-"));
  const store = new Store(":memory:");
  const host = new NativeHost(store, root);
  const pid = 123456;
  const originalKill = process.kill;
  try {
    for (const code of ["ESRCH", "EPERM"] as const) {
      const name = host.name("cursor", `check-${code}`);
      (host as any).prepared.set(name, {
        record: { pid, stamp: "" },
        process: { pid },
      });
      store.container(name);
      let first = true;
      (host as any).groupAlive = () => {
        const alive = first;
        first = false;
        return alive;
      };
      process.kill = ((target: number, signal: string) => {
        assert.equal(target, -pid);
        assert.equal(signal, "SIGTERM");
        throw Object.assign(new Error(`kill ${code}`), { code });
      }) as typeof process.kill;
      if (code === "ESRCH") {
        await host.stop(name);
        assert.ok(!store.containers().includes(name));
      } else {
        await assert.rejects(
          host.stop(name),
          (error: any) =>
            error.code === "EPERM" && /record is kept/.test(error.message),
        );
        assert.ok(store.containers().includes(name));
      }
    }
  } finally {
    process.kill = originalKill;
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("native jobs keep identical task text, use cwd output, and keep each CLI sandbox", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-native-"));
  const store = new Store(":memory:");
  const host = new MetadataHost(store, root);
  const previous = process.env.ARENA_NATIVE_APPROVED;
  const previousHome = process.env.HOME;
  process.env.ARENA_NATIVE_APPROVED = "1";
  const loginHome = await mkdtemp(resolve(tmpdir(), "stram-cursor-login-"));
  process.env.HOME = loginHome;
  await mkdir(resolve(loginHome, ".cursor"), { recursive: true });
  await writeFile(resolve(loginHome, ".cursor", "auth.json"), "fixture-login\n", {
    mode: 0o600,
  });
  const keychain = resolve(
    loginHome,
    "Library",
    "Keychains",
    "login.keychain-db",
  );
  await mkdir(resolve(loginHome, "Library", "Keychains"), { recursive: true });
  await writeFile(keychain, "fixture-keychain\n", { mode: 0o600 });
  try {
    await host.inspect();
    const prompt = instructions(
      {
        text: "Build a colourful card game with a score",
        author: "Host",
        platform: "fallback",
      },
      1,
    );
    const codex = await host.create("codex", 1, [
      "codex",
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      prompt,
    ]);
    const cursor = await host.create("cursor", 1, [
      "cursor-agent",
      "--print",
      prompt,
    ]);
    const entries = (host as any).prepared as Map<
      string,
      { command: string[]; env?: NodeJS.ProcessEnv }
    >;
    assert.equal(
      entries.get(codex.name)!.command.at(-1),
      entries.get(cursor.name)!.command.at(-1),
    );
    assert.match(
      entries.get(codex.name)!.command.at(-1)!,
      /\.\/prompt_1\.html/,
    );
    assert.ok(!entries.get(cursor.name)!.command.some((arg) => arg.startsWith("--sandbox")));
    assert.ok(!entries.get(codex.name)!.command.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(entries.get(codex.name)!.command.includes("--sandbox=workspace-write"));
    assert.equal(
      entries.get(cursor.name)!.env?.HOME,
      resolve(cursor.dir, ".cli-home"),
    );
    assert.equal(
      await readFile(
        resolve(cursor.dir, ".cli-home", ".cursor", "mcp.json"),
        "utf8",
      ),
      '{"mcpServers":{}}\n',
    );
    assert.equal(
      await readFile(
        resolve(cursor.dir, ".cli-home", ".cursor", "auth.json"),
        "utf8",
      ),
      "fixture-login\n",
    );
    assert.equal(
      await readlink(
        resolve(
          cursor.dir,
          ".cli-home",
          "Library",
          "Keychains",
          "login.keychain-db",
        ),
      ),
      keychain,
    );
    assert.equal(
      entries.get(codex.name)!.env?.HOME,
      resolve(codex.dir, ".cli-home"),
    );
    assert.equal(
      entries.get(codex.name)!.env?.CODEX_HOME,
      resolve(codex.dir, ".cli-home/.codex"),
    );
    const config = await readFile(
      resolve(codex.dir, ".cli-home/.codex/config.toml"),
      "utf8",
    );
    assert.match(config, /apps = false/);
    assert.match(config, /plugins = false/);
    assert.match(config, /hooks = false/);
    await host.recover();
    assert.deepEqual(store.containers(), []);
  } finally {
    if (previous === undefined) delete process.env.ARENA_NATIVE_APPROVED;
    else process.env.ARENA_NATIVE_APPROVED = previous;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    store.close();
    await rm(root, { recursive: true, force: true });
    await rm(loginHome, { recursive: true, force: true });
  }
});
test("probe cleanup deletes generated files and keeps round directories", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-probe-"));
  const probe = resolve(
    root,
    "runtime/native-workspaces/cursor/check-11111111-1111-4111-8111-111111111111",
  );
  const round = resolve(root, "runtime/native-workspaces/cursor/3");
  await mkdir(resolve(probe, ".git"), { recursive: true });
  await mkdir(resolve(probe, ".cli-home"), { recursive: true });
  await writeFile(resolve(probe, ".cli-home", "mcp.json"), "{}\n");
  await mkdir(resolve(round, ".git"), { recursive: true });
  await writeFile(resolve(round, "prompt_3.html"), "<p>keep</p>");
  try {
    assert.equal(await removeProbeWorkspace(round), false);
    const cleaned = await cleanupProbeWorkspaces(root);
    assert.equal(cleaned.removed.length, 1);
    assert.equal(
      await readFile(resolve(round, "prompt_3.html"), "utf8"),
      "<p>keep</p>",
    );
    await assert.rejects(() =>
      readFile(resolve(probe, ".cli-home", "mcp.json")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a finished native Codex probe retains its arena login before deleting its home", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-native-auth-"));
  const store = new Store(":memory:");
  const host = new NativeHost(store, root);
  try {
    const probe = await host.create(
      "codex",
      "check-11111111-1111-4111-8111-111111111111",
      ["codex", "--version"],
    );
    await writeFile(resolve(probe.dir, ".cli-home/.codex/auth.json"), "{}");
    await host.stop(probe.name);
    assert.equal(
      (await stat(resolve(root, "runtime/auth/codex/.codex/auth.json"))).size,
      2,
    );
    await assert.rejects(stat(probe.dir), { code: "ENOENT" });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

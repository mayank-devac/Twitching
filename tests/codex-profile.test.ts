import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Docker } from "../server/docker.js";
import { Store } from "../server/store.js";
import { CliRunner } from "../server/runner.js";
import {
  assertCodexProfile,
  CODEX_EXEC_PROFILE_ARGS,
  prepareCodexHome,
  retainCodexLogin,
} from "../server/codex-profile.js";

test("fresh Codex homes copy only the arena login, not config, skills, hooks or plugins", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-codex-profile-"));
  const store = new Store(":memory:");
  try {
    const saved = resolve(root, "runtime/auth/codex/.codex");
    await mkdir(resolve(saved, "skills/user-marker"), { recursive: true });
    await mkdir(resolve(saved, "plugins/user-marker"), { recursive: true });
    await mkdir(
      resolve(root, "runtime/auth/codex/.agents/skills/home-marker"),
      { recursive: true },
    );
    await writeFile(resolve(saved, "auth.json"), "{}");
    await writeFile(
      resolve(saved, "config.toml"),
      '[mcp_servers.user_marker]\ncommand="false"\n',
    );
    await writeFile(resolve(saved, "AGENTS.md"), "USER_RULE_MARKER");
    await writeFile(
      resolve(saved, "hooks.json"),
      '{"hooks":{"SessionStart":[]}}',
    );
    const docker = new Docker(store, { root, image: "unused" });
    const first = await docker.workspace({ cli: "codex", round: 1 });
    const second = await docker.workspace({ cli: "codex", round: 2 });
    for (const dir of [first, second]) {
      const home = resolve(dir, ".home/.codex");
      assert.equal((await stat(resolve(home, "auth.json"))).size, 2);
      const config = await readFile(resolve(home, "config.toml"), "utf8");
      assert.ok(!config.includes("user_marker"));
      assert.match(config, /apps = false/);
      assert.match(config, /plugins = false/);
      assert.match(config, /hooks = false/);
      assert.match(config, /project_doc_max_bytes = 0/);
      for (const entry of ["skills", "plugins", "AGENTS.md", "hooks.json"])
        await assert.rejects(stat(resolve(home, entry)), { code: "ENOENT" });
      await assert.rejects(stat(resolve(dir, ".home/.agents")), {
        code: "ENOENT",
      });
    }
    await writeFile(
      resolve(first, ".home/.codex/config.toml"),
      "SESSION_CONFIG_MARKER",
    );
    await retainCodexLogin(root, resolve(first, ".home"));
    assert.ok(
      (await readFile(resolve(saved, "config.toml"), "utf8")).includes(
        "user_marker",
      ),
    );
    assert.notEqual(first, second);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty arena profile can be prepared before its first login", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-codex-profile-"));
  const previousHome = process.env.HOME;
  const emptyHome = await mkdtemp(resolve(tmpdir(), "stram-codex-empty-home-"));
  process.env.HOME = emptyHome;
  try {
    const home = await prepareCodexHome(root, resolve(root, "session"));
    await stat(resolve(home, "config.toml"));
    await assert.rejects(stat(resolve(home, "auth.json")), { code: "ENOENT" });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
    await rm(emptyHome, { recursive: true, force: true });
  }
});

test("a missing arena Codex login is seeded once from this Mac's Codex login file", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-codex-seed-"));
  const loginHome = await mkdtemp(resolve(tmpdir(), "stram-codex-mac-"));
  const previousHome = process.env.HOME;
  process.env.HOME = loginHome;
  await mkdir(resolve(loginHome, ".codex"), { recursive: true });
  await writeFile(resolve(loginHome, ".codex/auth.json"), "fixture-codex\n", {
    mode: 0o600,
  });
  try {
    const first = await prepareCodexHome(root, resolve(root, "session-1"));
    assert.equal(
      await readFile(resolve(first, "auth.json"), "utf8"),
      "fixture-codex\n",
    );
    assert.equal(
      await readFile(
        resolve(root, "runtime/auth/codex/.codex/auth.json"),
        "utf8",
      ),
      "fixture-codex\n",
    );
    await writeFile(resolve(loginHome, ".codex/auth.json"), "ignored-later\n");
    const second = await prepareCodexHome(root, resolve(root, "session-2"));
    assert.equal(
      await readFile(resolve(second, "auth.json"), "utf8"),
      "fixture-codex\n",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
    await rm(loginHome, { recursive: true, force: true });
  }
});

test("readiness rejects an effective profile exposing integrations or project instructions", () => {
  const clean = {
    features: { apps: false, plugins: false, hooks: false },
    project_doc_max_bytes: 0,
    mcp_servers: {},
  };
  assert.doesNotThrow(() => assertCodexProfile(clean));
  for (const name of ["apps", "plugins", "hooks"])
    assert.throws(
      () =>
        assertCodexProfile({
          ...clean,
          features: { ...clean.features, [name]: true },
        }),
      /startup paused/,
    );
  assert.throws(
    () => assertCodexProfile({ ...clean, mcp_servers: { user_marker: {} } }),
    /startup paused/,
  );
  assert.throws(
    () => assertCodexProfile({ ...clean, project_doc_max_bytes: 1 }),
    /startup paused/,
  );
});

test("paired launch uses runtime isolation controls and the same autonomous prompt", async () => {
  const commands: string[][] = [];
  const cleanup: string[] = [];
  const host = {
    inspect: async () => {},
    capture: async (_agent: string, args: string[]) =>
      args.includes("status")
        ? "Logged in"
        : args.includes("--list-models")
          ? "requested-cursor - Fixture model"
          : "--ignore-user-config --ignore-rules --disable --print --stream-partial-output --output-format --model --force",
    codexInfo: async () => ({
      account: "chatgpt",
      models: [
        {
          model: "requested-codex",
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        },
      ],
      limits: {
        rateLimits: {
          primary: { windowDurationMins: 300, usedPercent: 10, resetsAt: 9000 },
        },
      },
    }),
    create: async (_agent: string, _round: number, command: string[]) => {
      commands.push(command);
      return { name: _agent, dir: "fixture" };
    },
    attach: (agent: string) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
      });
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify(
            agent === "codex"
              ? { type: "turn.completed" }
              : { type: "result", subtype: "success", is_error: false },
          ) + "\n",
        );
        child.emit("close", 0);
      });
      return child;
    },
    preserveOutput: async (agent: string) => {
      cleanup.push(`preserve:${agent}`);
      return true;
    },
    stop: async (agent: string) => {
      cleanup.push(`stop:${agent}`);
    },
    output: async () => {},
    retainAuth: async () => {},
  } as unknown as Docker;
  const runner = new CliRunner(
    host,
    {
      codexModel: "requested-codex",
      cursorModel: "requested-cursor",
      codexEffort: "high",
    },
    (s) => s,
  );
  const handles = await runner.launch(
    1,
    { text: "Build colourful waves", author: "Fixture", platform: "fallback" },
    Date.now(),
    () => {},
  );
  assert.ok(handles.codex);
  assert.ok(handles.cursor);
  assert.equal((await handles.codex.done).status, "complete");
  assert.equal((await handles.cursor.done).status, "complete");
  for (const agent of ["codex", "cursor"]) {
    assert.ok(cleanup.indexOf(`preserve:${agent}`) >= 0);
    assert.ok(
      cleanup.indexOf(`preserve:${agent}`) < cleanup.indexOf(`stop:${agent}`),
    );
  }
  const codexCommand = commands.find((command) => command[0] === "codex")!;
  for (const argument of CODEX_EXEC_PROFILE_ARGS)
    assert.ok(codexCommand.includes(argument));
  assert.ok(codexCommand.includes("requested-codex"));
  assert.ok(commands.some((command) => command.includes("requested-cursor")));
  assert.equal(commands[0].at(-1), commands[1].at(-1));
  assert.match(
    commands[0].at(-1)!,
    /Choose a safe self-contained interpretation and continue/,
  );
});

test("sandbox output is kept in runtime before the workspace is cleaned", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-output-"));
  const store = new Store(":memory:");
  const docker = new Docker(store, { root, image: "unused" });
  const workspace = resolve(root, "runtime/workspaces/codex/7");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(resolve(workspace, "prompt_7.html"), "<h1>partial</h1>");
    assert.equal(await docker.preserveOutput("codex", 7, workspace), true);
    assert.equal(
      await readFile(
        resolve(root, "runtime/sandbox_results/codex/prompt_7.html"),
        "utf8",
      ),
      "<h1>partial</h1>",
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("readiness fails before launch when required CLI controls or arena login are missing", async () => {
  const options = {
    singleAgent: "codex" as const,
    codexModel: "requested-codex",
    cursorModel: "requested-cursor",
    codexEffort: "high",
  };
  const unsupported = {
    inspect: async () => {},
    capture: async () => "--json",
  } as unknown as Docker;
  await assert.rejects(
    new CliRunner(unsupported, options, (s) => s).preflight(),
    /required isolation control/,
  );
  const noLogin = {
    inspect: async () => {},
    capture: async () => "--ignore-user-config --ignore-rules --disable",
    codexInfo: async () => ({ account: undefined, models: [], limits: {} }),
  } as unknown as Docker;
  await assert.rejects(
    new CliRunner(noLogin, options, (s) => s).preflight(),
    /sandbox:login:codex/,
  );
});

test("same-round Codex homes are distinct and stale refreshes cannot overwrite newer login", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "arena-login-race-"));
  const store = new Store(":memory:");
  try {
    const saved = resolve(root, "runtime/auth/codex/.codex");
    await mkdir(saved, { recursive: true });
    await writeFile(resolve(saved, "auth.json"), "fixture-original");
    const host = new Docker(store, { root, image: "unused" });
    const first = await host.workspace({ cli: "codex", round: 1, session: "session-1" });
    const second = await host.workspace({ cli: "codex", round: 1, session: "session-2" });
    assert.notEqual(first, second);
    assert.notEqual(host.name("session-1", 1), host.name("session-2", 1));
    await writeFile(
      resolve(first, ".home/.codex/auth.json"),
      "fixture-first-refresh",
    );
    await retainCodexLogin(root, resolve(first, ".home"));
    // A session with unchanged credentials must not restore the old copy.
    await retainCodexLogin(root, resolve(second, ".home"));
    assert.equal(
      await readFile(resolve(saved, "auth.json"), "utf8"),
      "fixture-first-refresh",
    );
    await writeFile(
      resolve(second, ".home/.codex/auth.json"),
      "fixture-conflicting-refresh",
    );
    await assert.rejects(
      retainCodexLogin(root, resolve(second, ".home")),
      /conflicted/,
    );
    assert.equal(
      await readFile(resolve(saved, "auth.json"), "utf8"),
      "fixture-first-refresh",
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a reused session workspace re-prepares its Codex profile on every prompt", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-codex-reuse-"));
  try {
    const home = resolve(root, "session");
    const codexHome = await prepareCodexHome(root, home, false);
    await writeFile(resolve(codexHome, "config.toml"), "AGENT_EDIT");
    // The second prompt used to fail here with EEXIST.
    await prepareCodexHome(root, home, false);
    const config = await readFile(resolve(codexHome, "config.toml"), "utf8");
    assert.doesNotMatch(config, /AGENT_EDIT/);
    assert.match(config, /hooks = false/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a planted .codex symlink is refused, not written through", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-codex-link-"));
  try {
    const home = resolve(root, "session");
    const outside = resolve(root, "outside");
    await mkdir(home, { recursive: true });
    await mkdir(outside);
    await symlink(outside, resolve(home, ".codex"));
    await assert.rejects(
      prepareCodexHome(root, home, false),
      /must be a real directory/,
    );
    await assert.rejects(stat(resolve(outside, "config.toml")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

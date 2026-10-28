import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Docker } from "../server/docker.js";
import { Store } from "../server/store.js";
import { CliRunner } from "../server/runner.js";
import {
  cliAdapters,
  validateModel,
  validateSessions,
} from "../server/cli/index.js";
import {
  activityPatches,
  mergeActivityPatches,
} from "../shared/activity-stream.js";
import {
  configuredSessions,
  type Activity,
  type Agent,
  type SessionConfig,
} from "../shared/types.js";
import { availableSandboxResults } from "../server/sandbox-results.js";

const sessions: SessionConfig[] = [
  { id: "session-1", cli: "codex", model: "model-a", effort: "high" },
  { id: "session-2", cli: "codex", model: "model-b" },
];
const options = {
  codexModel: "model-a",
  cursorModel: "cursor-model",
  sessions,
};
const task = {
  text: "Draw an ocean",
  author: "Fixture",
  platform: "fallback" as const,
};
class SessionHost extends Docker {
  created: Array<{
    cli: Agent;
    id: string;
    command: string[];
    dir: string;
    name: string;
  }> = [];
  stopped: string[] = [];
  children = new Map<string, ChildProcessWithoutNullStreams>();
  failCreate?: string;
  failAttach?: string;
  failStop?: string;
  probes = 0;
  inspections = 0;
  helpChecks = 0;
  models = ["model-a", "model-b"];
  constructor(
    store: Store,
    private fixtureRoot: string,
  ) {
    super(store, { root: fixtureRoot, image: "unused" });
  }
  override async inspect() { this.inspections++; }
  override async capture() {
    this.helpChecks++;
    return "--ignore-user-config --ignore-rules --disable";
  }
  override async codexInfo() {
    this.probes++;
    return {
      account: "chatgpt",
      models: this.models.map((model) => ({
        model,
        supportedReasoningEfforts: [{ reasoningEffort: "high" }],
      })),
      limits: {
        rateLimits: {
          primary: { windowDurationMins: 300, usedPercent: 10, resetsAt: 9000 },
        },
      },
    };
  }
  override async create(
    cli: Agent,
    round: number | string,
    command: string[],
    _dir?: string,
    id = cli as string,
  ) {
    if (id === this.failCreate) throw new Error("fixture create failure");
    const dir = resolve(
      this.fixtureRoot,
      "runtime/workspaces",
      id,
      String(round),
    );
    await mkdir(dir, { recursive: true });
    const name = this.name(id, round);
    this.created.push({ cli, id, command, dir, name });
    return { name, dir };
  }
  override attach(name: string) {
    if (name.includes(this.failAttach ?? "no-failure"))
      throw new Error("fixture attach failure");
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
    }) as unknown as ChildProcessWithoutNullStreams;
    this.children.set(name, child);
    return child;
  }
  override async stop(name: string) {
    if (this.failStop && name.includes(this.failStop)) throw new Error("fixture cleanup failure");
    this.stopped.push(name);
    const child = this.children.get(name);
    this.children.delete(name);
    child?.emit("close", 1);
  }
  override async retainAuth() {}
  finish(name: string) {
    const child = this.children.get(name)!;
    child.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ type: "turn.completed" }) + "\n"),
    );
    child.emit("close", 0);
  }
}
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "arena-sessions-"));
  const store = new Store(":memory:");
  const host = new SessionHost(store, root);
  return {
    root,
    store,
    host,
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("two Codex models have separate handles, prompts, files and exports; discovery runs once", async () => {
  const f = await fixture();
  try {
    const runner = new CliRunner(f.host, options, (text) => text);
    const handles = await runner.launch(1, task, 0, () => {});
    assert.deepEqual(Object.keys(handles), ["session-1", "session-2"]);
    assert.equal(f.host.probes, 1);
    assert.equal(f.host.children.size, 2);
    assert.equal(
      f.host.created[0].command.at(-1),
      f.host.created[1].command.at(-1),
    );
    assert.ok(f.host.created[0].command.includes("model-a"));
    assert.ok(f.host.created[1].command.includes("model-b"));
    for (const created of f.host.created) {
      await writeFile(
        resolve(created.dir, "prompt_1.html"),
        `<h1>${created.id}</h1>`,
      );
      f.host.finish(created.name);
      assert.equal((await handles[created.id]!.done).status, "complete");
      assert.equal(
        await readFile(
          resolve(f.root, "main", created.id, "prompt_1.html"),
          "utf8",
        ),
        `<h1>${created.id}</h1>`,
      );
    }
    assert.equal(f.host.children.size, 0);
    const exports = await availableSandboxResults(f.root);
    assert.equal(exports.length, 2);
    assert.ok(exports.every((result) => result.exported));
  } finally {
    await f.close();
  }
});

for (const stage of ["create", "attach"] as const)
  test(`failure of second session during ${stage} stops every prepared session`, async () => {
    const f = await fixture();
    try {
      if (stage === "create") f.host.failCreate = "session-2";
      else f.host.failAttach = "session-2";
      await assert.rejects(
        new CliRunner(f.host, options, (text) => text).launch(
          1,
          task,
          0,
          () => {},
        ),
        /fixture/,
      );
      assert.equal(f.host.children.size, 0);
      assert.ok(
        f.host.created.every((created) =>
          f.host.stopped.includes(created.name),
        ),
      );
    } finally {
      await f.close();
    }
  });

test("unavailable models and efforts fail before creating any session", async () => {
  const f = await fixture();
  try {
    for (const change of [
      { model: "not-listed" },
      { effort: "not-supported" },
    ]) {
      const runner = new CliRunner(
        f.host,
        { ...options, sessions: [{ ...sessions[0], ...change }] },
        (text) => text,
      );
      await assert.rejects(
        runner.launch(1, task, 0, () => {}),
        /no model was substituted/,
      );
    }
    assert.equal(f.host.created.length, 0);
    assert.throws(
      () =>
        validateModel(
          { id: "session-1", cli: "cursor", model: "m", effort: "high" },
          [{ id: "m", efforts: [] }],
        ),
      /unavailable/,
    );
    assert.throws(() => validateSessions([sessions[0], sessions[0]]), /unique/);
    assert.throws(
      () => validateSessions([{ ...sessions[0], id: "../other" }]),
      /Invalid/,
    );
    assert.equal(
      configuredSessions({
        codexModel: "a",
        cursorModel: "b",
        singleAgent: "cursor",
      }).length,
      1,
    );
    assert.deepEqual(
      configuredSessions({ codexModel: "a", cursorModel: "b" }).map(
        (s) => s.cli,
      ),
      ["cursor", "codex"],
    );
  } finally {
    await f.close();
  }
});

test("identical CLI item IDs stay separate through activity deltas and SQLite", () => {
  const events: Activity[] = [];
  const store = new Store(":memory:");
  try {
    for (const session of sessions) {
      const parser = cliAdapters.codex.activity(
        session,
        1,
        (text) => text,
        (event) => events.push(event),
      );
      parser.receive({
        type: "item.completed",
        item: { id: "same-id", type: "agent_message", text: session.model },
      });
    }
    assert.equal(new Set(events.map((event) => event.id)).size, 2);
    const next = events.map((event) => ({
      ...event,
      text: event.text + " finished",
    }));
    assert.deepEqual(
      mergeActivityPatches(
        events,
        activityPatches(events, next),
        next.map((e) => e.id),
      ),
      next,
    );
    for (const event of next) store.event(event);
    assert.equal(
      (
        store.db.prepare("SELECT count(*) AS n FROM events").get() as {
          n: number;
        }
      ).n,
      2,
    );
  } finally {
    store.close();
  }
});

test("fixed CLI checks are cached while account/model availability is refreshed", async () => {
  const f = await fixture();
  try {
    const runner = new CliRunner(f.host, options, (text) => text);
    await runner.preflight();
    await runner.preflight();
    assert.equal(f.host.inspections, 1);
    assert.equal(f.host.helpChecks, 1);
    assert.equal(f.host.probes, 2);
    f.host.models = ["model-a"];
    await assert.rejects(runner.preflight(), /model-b.*unavailable/);
    assert.equal(f.host.probes, 3);
  } finally { await f.close(); }
});

test("failed cleanup preserves the original startup error and cleanup errors", async () => {
  const f = await fixture();
  try {
    f.host.failCreate = "session-2";
    f.host.failStop = "session-1";
    await assert.rejects(new CliRunner(f.host, options, (text) => text).launch(1, task, 0, () => {}), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /fixture create failure.*cleanup could not be confirmed/);
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause, error.errors[0]);
      assert.match(error.errors[1].message, /fixture cleanup failure/);
      return true;
    });
  } finally { await f.close(); }
});

test("Docker creation preserves both errors when its own cleanup fails", async () => {
  const f = await fixture();
  try {
    const host = new Docker(f.store, { root: f.root, image: "unused" });
    const original = new Error("fixture docker create failed");
    const cleanup = new Error("fixture docker stop failed");
    host.command = async () => { throw original; };
    host.stop = async () => { throw cleanup; };
    await assert.rejects(host.create("codex", 1, [], f.root, "session-1"), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, original);
      assert.deepEqual(error.errors, [original, cleanup]);
      return true;
    });
  } finally { await f.close(); }
});

test("legacy saved rounds keep their original directory and model identity", () => {
  const store = new Store(":memory:");
  try {
    store.save({
      status: "paused",
      mode: "rehearsal",
      reason: "Legacy saved round fixture",
      candidates: [],
      candidateCount: 0,
      events: [],
      connections: {},
      checks: [],
      rehearsalComplete: false,
      round: {
        id: 1,
        task,
        launchedAt: 0,
        attempts: {
          codex: { model: "old-model · high", status: "complete" },
          cursor: { model: "unused", status: "idle" },
        },
      },
    });
    const saved = store.state()!;
    assert.deepEqual(saved.round!.sessions, [
      { id: "codex", cli: "codex", model: "old-model", effort: "high" },
    ]);
    assert.equal(saved.round!.attempts.codex.cli, "codex");
    assert.equal(saved.round!.attempts.codex.model, "old-model");
    assert.equal(saved.round!.attempts.codex.effort, "high");
    // Earlier versions already added sessions but left the display label in model.
    // Read a separate fixture: the assertions above narrow `saved` to require effort.
    const previouslyMigrated = store.state()!;
    previouslyMigrated.round!.sessions![0] = {
      id: "codex", cli: "codex", model: "old-model · high",
    };
    store.save(previouslyMigrated);
    assert.deepEqual(store.state()!.round!.sessions![0], {
      id: "codex", cli: "codex", model: "old-model", effort: "high",
    });
    const id = store.roundId();
    store.round({ ...previouslyMigrated.round!, id });
    assert.equal(store.history().rounds[0].sessions![0].model, "old-model");
  } finally {
    store.close();
  }
});

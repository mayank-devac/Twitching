import test from "node:test";
import assert from "node:assert/strict";
import { Controller, type ControllerOptions } from "../server/controller.js";
import { Store } from "../server/store.js";
import { Filter } from "../server/filter.js";
import type { PairRunner, RunHandle, RunOutcome } from "../server/runner.js";
import type { Activity, Agent, SessionConfig, Task } from "../shared/types.js";
import { redactor } from "../server/redact.js";
const options: ControllerOptions = {
  mode: "live",
  codexModel: "gpt-6.1-sol",
  codexEffort: "high",
  cursorModel: "grok-4.7-high",
  collectionMs: 60,
  extensionMs: 180,
  resultMs: 30,
  reconnectLimitMs: 900000,
  quotaGraceMs: 600,
  quotaPollMs: 60,
  safetyThreshold: 0.95,
  relevanceThreshold: 0.85,
  minScore: 50,
};
class FakeRunner implements PairRunner {
  onActivity?: (event: Activity) => void;
  singleAgent?: Agent;
  sessions?: SessionConfig[];
  launches: Array<{ round: number; task: Task; at: number }> = [];
  resolvers: Record<string, (outcome: RunOutcome) => void> = {};
  stopped: string[] = [];
  recovered = 0;
  quotaValue = { remainingPercent: 90, resetsAt: 900000 };
  async recover() {
    this.recovered++;
  }
  async preflight() {
    return ["models ready"];
  }
  async quota() {
    return this.quotaValue;
  }
  async launch(
    round: number,
    task: Task,
    at: number,
    emit: (event: Activity) => void,
  ): Promise<Record<string, RunHandle>> {
    this.onActivity = emit;
    this.launches.push({ round, task, at });
    const handle = (agent: string): RunHandle => ({
      done: new Promise((resolve) => {
        this.resolvers[agent] = resolve;
      }),
      stop: async (reason) => {
        this.stopped.push(agent);
        this.resolvers[agent]?.({ status: reason });
      },
    });
    if (this.sessions)
      return Object.fromEntries(
        this.sessions.map((session) => [session.id, handle(session.id)]),
      );
    if (this.singleAgent)
      return { [this.singleAgent]: handle(this.singleAgent) };
    return { codex: handle("codex"), cursor: handle("cursor") };
  }
}
async function fixture(
  mode: "live" | "rehearsal" = "live",
  singleAgent?: Agent,
  clean: (text: string, limit?: number) => string = (text) => text,
  sessions?: SessionConfig[],
) {
  let now = 1000;
  const store = new Store(":memory:");
  const runner = new FakeRunner();
  runner.singleAgent = singleAgent;
  runner.sessions = sessions;
  if (singleAgent === "cursor")
    runner.quota = async () => {
      throw new Error("Codex must not be queried");
    };
  let broadcastStops = 0;
  const controller = new Controller(
    store,
    new Filter([]),
    {
      evaluate: async () => ({
        safety: 1,
        relevance: 1,
        simplicity: 100,
        clarity: 100,
        creativity: 100,
        visual: 100,
      }),
      choose: async () => "WAIT",
      surprise: async () => "Build a tiny surprise game with colourful cards",
    },
    runner,
    { validate: async (a, r) => `http://127.0.0.1:3211/page/${a}/${r}` },
    {
      start: async () => {},
      startChats: async () => {},
      stop: () => {},
      preflight: async () => [],
      stopBroadcast: async () => {
        broadcastStops++;
      },
    },
    { ...options, mode, singleAgent, sessions },
    clean,
    () => now,
  );
  controller.state.rehearsalComplete = true;
  await controller.start();
  controller.collection.prepared = {
    text: "Build a colourful garden with flower controls",
    author: "House",
    platform: "fallback",
  };
  await controller.tick();
  return {
    controller,
    runner,
    store,
    setTime: (n: number) => {
      now = n;
    },
    broadcastStops: () => broadcastStops,
    cleanup: async () => {
      await controller.stop("test cleanup", false);
      await new Promise((r) => setImmediate(r));
      store.close();
    },
  };
}
test("launches a pair once with the same timestamp and preserves faster preview", async () => {
  const f = await fixture();
  assert.equal(f.runner.launches.length, 1);
  assert.equal(
    f.controller.state.round?.attempts.codex.startedAt,
    f.controller.state.round?.attempts.cursor.startedAt,
  );
  f.runner.resolvers.codex?.({ status: "complete" });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.controller.state.round?.attempts.codex.status, "complete");
  assert.equal(f.controller.state.round?.attempts.cursor.status, "running");
  await f.controller.tick();
  assert.equal(f.runner.launches.length, 1);
  await f.cleanup();
});
test("long-running attempts continue until completion or host cancellation", async () => {
  const f = await fixture();
  f.setTime(361001);
  await f.controller.tick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.runner.stopped, []);
  assert.equal(f.controller.state.round?.attempts.codex.status, "running");
  assert.equal(f.controller.state.round?.attempts.cursor.status, "running");
  await f.cleanup();
});
test("long activity remains complete through controller snapshots and persistence", async () => {
  const f = await fixture("live", undefined, redactor([], "/workspace"));
  try {
    const text = "x".repeat(90_000) + "TAIL!";
    for (const kind of ["message", "summary", "edit", "command"] as const) {
      f.runner.onActivity!({
        id: `long:${kind}`,
        agent: "codex",
        round: 1,
        at: 1,
        kind,
        text,
      });
      assert.equal(f.controller.snapshot().events.at(-1)?.text, text);
      assert.equal(f.store.state()?.events.at(-1)?.text, text);
    }
  } finally {
    await f.cleanup();
  }
});

test("pause lets current work finish but prevents new rounds", async () => {
  const f = await fixture();
  f.controller.pause();
  f.runner.resolvers.codex?.({ status: "complete" });
  f.runner.resolvers.cursor?.({ status: "complete" });
  await new Promise((r) => setImmediate(r));
  f.setTime(100000);
  await f.controller.tick();
  assert.equal(f.controller.state.status, "paused");
  assert.equal(f.runner.launches.length, 1);
  await f.cleanup();
});
test("result hold and prepared queue start only after both finish plus thirty seconds", async () => {
  const f = await fixture();
  f.controller.collection.prepared = {
    text: "Build a colourful garden with flower controls",
    author: "Next",
    platform: "fallback",
  };
  f.runner.resolvers.codex?.({ status: "complete" });
  f.runner.resolvers.cursor?.({ status: "complete" });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.controller.state.status, "results");
  f.setTime(1029);
  await f.controller.tick();
  assert.equal(f.runner.launches.length, 1);
  f.setTime(1030);
  await f.controller.tick();
  assert.equal(f.runner.launches.length, 2);
  assert.ok(f.runner.recovered >= 3);
  await f.cleanup();
});
test("usage failure enters music break and ends the broadcast after grace period", async () => {
  const f = await fixture();
  f.runner.quotaValue = { remainingPercent: 0, resetsAt: 900000 };
  f.runner.resolvers.codex?.({
    status: "error",
    failure: "usage",
    error: "Usage reached",
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.controller.state.status, "break");
  assert.equal(f.controller.state.breakUntil, 1600);
  assert.ok(f.runner.stopped.includes("cursor"));
  f.setTime(1600);
  await f.controller.tick();
  assert.equal(f.controller.state.status, "stopped");
  assert.equal(f.broadcastStops(), 1);
  await f.cleanup();
});
test("restart pauses interrupted jobs rather than relaunching", async () => {
  const f = await fixture();
  const restarted = new Controller(
    f.store,
    new Filter([]),
    {
      evaluate: async () => {
        throw new Error();
      },
      choose: async () => "WAIT",
      surprise: async () => {
        throw new Error();
      },
    },
    f.runner,
    { validate: async () => "" },
    {
      start: async () => {},
      startChats: async () => {},
      stop: () => {},
      preflight: async () => [],
      stopBroadcast: async () => {},
    },
    options,
    (s) => s,
    () => 1000,
  );
  assert.equal(restarted.state.status, "paused");
  assert.equal(restarted.state.round?.attempts.codex.status, "cancelled");
  await restarted.recover();
  await restarted.tick();
  assert.equal(f.runner.launches.length, 1);
  await f.cleanup();
});
test("public snapshot hides lane commands and the host snapshot keeps them", async () => {
  const f = await fixture();
  f.controller.state.events = [
    {
      id: "public",
      round: 1,
      agent: "codex",
      at: 1,
      kind: "command",
      text: "Running command: rg",
    },
    {
      id: "lane",
      round: 1,
      agent: "codex",
      at: 2,
      kind: "command",
      text: "running rg --files secret",
      lane: "terminal",
    },
  ];
  assert.deepEqual(
    f.controller.snapshot().events.map((event) => event.id),
    ["public"],
  );
  assert.deepEqual(
    f.controller.hostSnapshot().events.map((event) => event.id),
    ["public", "lane"],
  );
  await f.cleanup();
});
test("public mode is gated on private rehearsal and authentication failure pauses", async () => {
  const f = await fixture();
  f.runner.resolvers.codex?.({
    status: "error",
    failure: "auth",
    error: "Login expired",
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.controller.state.status, "paused");
  await f.cleanup();
  const g = await fixture("rehearsal");
  await g.cleanup();
});
test("prompt list sends each task to both CLIs then ends the show", async () => {
  let now = 1000;
  const store = new Store(":memory:");
  const runner = new FakeRunner();
  let broadcastStops = 0;
  const controller = new Controller(
    store,
    new Filter([]),
    {
      evaluate: async () => ({
        safety: 1,
        relevance: 1,
        simplicity: 100,
        clarity: 100,
        creativity: 100,
        visual: 100,
      }),
      choose: async () => "WAIT",
      surprise: async () => "Build a tiny surprise game with colourful cards",
    },
    runner,
    { validate: async (a, r) => `http://127.0.0.1:3211/page/${a}/${r}` },
    {
      start: async () => {},
      startChats: async () => {},
      stop: () => {},
      preflight: async () => [],
      stopBroadcast: async () => {
        broadcastStops++;
      },
    },
    {
      ...options,
      playlist: [
        "Build a colourful garden with flower controls",
        "Build a tiny neon piano with clickable keys",
      ],
    },
    (s) => s,
    () => now,
  );
  assert.equal(controller.state.rehearsalComplete, false);
  await controller.start();
  await controller.tick();
  assert.equal(runner.launches.length, 1);
  assert.equal(
    runner.launches[0].task.text,
    "Build a colourful garden with flower controls",
  );
  assert.equal(controller.state.playlistIndex, 1);
  runner.resolvers.codex?.({ status: "complete" });
  runner.resolvers.cursor?.({ status: "complete" });
  await new Promise((r) => setImmediate(r));
  now = 1030;
  await controller.tick();
  assert.equal(runner.launches.length, 2);
  assert.equal(
    runner.launches[1].task.text,
    "Build a tiny neon piano with clickable keys",
  );
  runner.resolvers.codex?.({ status: "complete" });
  runner.resolvers.cursor?.({ status: "complete" });
  await new Promise((r) => setImmediate(r));
  now = 1060;
  await controller.tick();
  assert.equal(controller.state.status, "results");
  assert.equal(controller.state.awaitingHostChoice, true);
  assert.equal(broadcastStops, 0);
  await controller.hostChoice("stream-now");
  assert.equal(controller.state.status, "stopped");
  assert.equal(broadcastStops, 1);
  await controller.stop("test cleanup", false);
  await new Promise((r) => setImmediate(r));
  store.close();
});
test("rehearsal prompt list does not pause after the first round", async () => {
  let now = 1000;
  const store = new Store(":memory:");
  const runner = new FakeRunner();
  const controller = new Controller(
    store,
    new Filter([]),
    {
      evaluate: async () => ({
        safety: 1,
        relevance: 1,
        simplicity: 100,
        clarity: 100,
        creativity: 100,
        visual: 100,
      }),
      choose: async () => "WAIT",
      surprise: async () => "Build a tiny surprise game with colourful cards",
    },
    runner,
    { validate: async (a, r) => `http://127.0.0.1:3211/page/${a}/${r}` },
    {
      start: async () => {},
      startChats: async () => {},
      stop: () => {},
      preflight: async () => [],
      stopBroadcast: async () => {},
    },
    {
      ...options,
      mode: "rehearsal",
      playlist: [
        "Build a colourful garden with flower controls",
        "Build a tiny neon piano with clickable keys",
      ],
    },
    (s) => s,
    () => now,
  );
  await controller.start();
  await controller.tick();
  runner.resolvers.codex?.({ status: "complete" });
  runner.resolvers.cursor?.({ status: "complete" });
  await new Promise((r) => setImmediate(r));
  now = 1030;
  await controller.tick();
  assert.equal(controller.state.status, "running");
  assert.equal(runner.launches.length, 2);
  await controller.stop("test cleanup", false);
  await new Promise((r) => setImmediate(r));
  store.close();
});
test("stop choices switch to chat now or end after the current round", async () => {
  let now = 1000;
  const store = new Store(":memory:");
  const runner = new FakeRunner();
  const chats: Array<Record<string, boolean | undefined>> = [];
  const controller = new Controller(
    store,
    new Filter([]),
    {
      evaluate: async () => ({
        safety: 1,
        relevance: 1,
        simplicity: 100,
        clarity: 100,
        creativity: 100,
        visual: 100,
      }),
      choose: async () => "WAIT",
      surprise: async () => "Build a tiny surprise game with colourful cards",
    },
    runner,
    { validate: async (a, r) => `http://127.0.0.1:3211/page/${a}/${r}` },
    {
      start: async () => {},
      startChats: async (platforms) => {
        chats.push(platforms);
      },
      stop: () => {},
      preflight: async () => [],
      stopBroadcast: async () => {},
    },
    {
      ...options,
      playlist: [
        "Build a colourful garden with flower controls",
        "Build a tiny neon piano with clickable keys",
      ],
    },
    (s) => s,
    () => now,
  );
  await controller.start();
  await controller.tick();
  assert.equal(runner.launches.length, 1);
  await controller.hostChoice("chat-now", { youtube: true });
  assert.equal(controller.state.status, "collecting");
  assert.equal(controller.state.playlistTotal, undefined);
  assert.deepEqual(chats, [{ youtube: true, twitch: false, kick: false }]);
  runner.resolvers.codex?.({ status: "cancelled" });
  runner.resolvers.cursor?.({ status: "cancelled" });
  await new Promise((r) => setImmediate(r));
  now = 1030;
  await controller.tick();
  assert.equal(runner.launches.length, 1);
  await controller.stop("test cleanup", false);
  await new Promise((r) => setImmediate(r));
  store.close();
});
test("end stream after this round waits for the result hold", async () => {
  let now = 1000;
  const store = new Store(":memory:");
  const runner = new FakeRunner();
  let broadcastStops = 0;
  const controller = new Controller(
    store,
    new Filter([]),
    {
      evaluate: async () => ({
        safety: 1,
        relevance: 1,
        simplicity: 100,
        clarity: 100,
        creativity: 100,
        visual: 100,
      }),
      choose: async () => "WAIT",
      surprise: async () => "Build a tiny surprise game with colourful cards",
    },
    runner,
    { validate: async (a, r) => `http://127.0.0.1:3211/page/${a}/${r}` },
    {
      start: async () => {},
      startChats: async () => {},
      stop: () => {},
      preflight: async () => [],
      stopBroadcast: async () => {
        broadcastStops++;
      },
    },
    {
      ...options,
      playlist: ["Build a colourful garden with flower controls"],
    },
    (s) => s,
    () => now,
  );
  await controller.start();
  await controller.tick();
  await controller.hostChoice("stream-after");
  assert.equal(controller.state.status, "running");
  runner.resolvers.codex?.({ status: "complete" });
  runner.resolvers.cursor?.({ status: "complete" });
  await new Promise((r) => setImmediate(r));
  assert.equal(controller.state.status, "results");
  assert.equal(broadcastStops, 0);
  now = 1030;
  await controller.tick();
  assert.equal(controller.state.status, "stopped");
  assert.equal(broadcastStops, 1);
  store.close();
});

for (const agent of ["codex", "cursor"] as const) {
  test(`${agent} single-model round finishes without waiting for the other CLI`, async () => {
    const f = await fixture("live", agent);
    try {
      assert.deepEqual(f.controller.snapshot().agents, [agent]);
      assert.deepEqual(Object.keys(f.runner.resolvers), [agent]);
      f.runner.resolvers[agent]?.({ status: "complete" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.controller.state.status, "results");
      assert.equal(
        f.controller.state.round?.attempts[agent].status,
        "complete",
      );
      assert.ok(f.controller.state.round?.attempts[agent].preview);
    } finally {
      await f.cleanup();
    }
  });
}

test("two Codex sessions keep independent results and cancellation identity", async () => {
  const sessions: SessionConfig[] = [
    { id: "session-1", cli: "codex", model: "fixture-a" },
    { id: "session-2", cli: "codex", model: "fixture-b", effort: "high" },
  ];
  const f = await fixture("live", undefined, (text) => text, sessions);
  try {
    assert.deepEqual(f.controller.snapshot().sessions, sessions);
    f.runner.resolvers["session-1"]({ status: "complete" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      f.controller.state.round!.attempts["session-1"].status,
      "complete",
    );
    assert.equal(
      f.controller.state.round!.attempts["session-2"].status,
      "running",
    );
    assert.equal(f.controller.state.status, "running");
    await f.controller.skip();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(f.runner.stopped.includes("session-2"));
    assert.equal(
      f.controller.state.round!.attempts["session-1"].model,
      "fixture-a",
    );
    assert.equal(
      f.controller.state.round!.attempts["session-2"].status,
      "cancelled",
    );
    assert.deepEqual(f.store.state()!.round!.sessions, sessions);
  } finally {
    await f.cleanup();
  }
});

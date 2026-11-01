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
  rejecters: Record<string, (error: Error) => void> = {};
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
      done: new Promise((resolve, reject) => {
        this.resolvers[agent] = resolve;
        this.rejecters[agent] = reject;
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
test("a failed result handler pauses the show instead of rejecting unhandled", async () => {
  const f = await fixture();
  f.runner.rejecters.codex?.(new Error("result bookkeeping failed"));
  await new Promise((r) => setImmediate(r));
  assert.equal(f.controller.state.status, "paused");
  assert.match(f.controller.state.reason ?? "", /codex result handling failed/);
  await f.cleanup();
});
// Switching experiences must not interrupt work without consent or stop OBS.
test("arena handover waits for the current run and blocks stale arena controls", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.controller.leaveArena(), "choice");
    assert.equal(f.controller.state.status, "running");
    assert.equal(await f.controller.leaveArena("wait"), "waiting");
    await assert.rejects(() => f.controller.resume(), /Open Prompt arena/);
    assert.deepEqual(f.runner.stopped, []);
    f.runner.resolvers.codex!({ status: "complete" });
    f.runner.resolvers.cursor!({ status: "complete" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await f.controller.leaveArena("wait"), "ready");
    assert.equal(f.controller.sessionReady, true);
    assert.equal(f.broadcastStops(), 0);
    f.controller.arenaEnabled = () => false;
    await assert.rejects(() => f.controller.start(), /Open Prompt arena/);
  } finally { await f.cleanup(); }
});

test("arena handover cancels only on request and refuses failed cleanup", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.controller.leaveArena("cancel"), "ready");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.runner.stopped.sort(), ["codex", "cursor"]);
    assert.equal(f.broadcastStops(), 0);
    f.runner.recover = async () => { throw new Error("cleanup unavailable"); };
    await assert.rejects(() => f.controller.leaveArena(), /cleanup failed/);
    assert.equal(f.controller.sessionReady, false);
  } finally { await f.cleanup(); }
});

test("two Codex usage failures share one in-flight quota request", async () => {
  const sessions: SessionConfig[] = [
    { id: "session-1", cli: "codex", model: "fixture-a" },
    { id: "session-2", cli: "codex", model: "fixture-b" },
  ];
  const f = await fixture("live", undefined, (text) => text, sessions);
  let resolveQuota!: (quota: { remainingPercent: number; resetsAt: number }) => void;
  let requests = 0;
  try {
    f.runner.quota = () => {
      requests++;
      return new Promise((resolve) => { resolveQuota = resolve; });
    };
    for (const session of sessions)
      f.runner.resolvers[session.id]!({ status: "error", failure: "usage" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 1);
    resolveQuota({ remainingPercent: 90, resetsAt: 900000 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.controller.state.quota?.remainingPercent, 90);
  } finally { await f.cleanup(); }
});

test("launches a pair once with the same timestamp and preserves faster preview", async () => {
  const f = await fixture();
  assert.equal(f.runner.launches.length, 1);
  assert.equal(
    f.controller.state.round?.attempts.codex!.startedAt,
    f.controller.state.round?.attempts.cursor!.startedAt,
  );
  f.runner.resolvers.codex?.({ status: "complete" });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.controller.state.round?.attempts.codex!.status, "complete");
  assert.equal(f.controller.state.round?.attempts.cursor!.status, "running");
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
  assert.equal(f.controller.state.round?.attempts.codex!.status, "running");
  assert.equal(f.controller.state.round?.attempts.cursor!.status, "running");
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
  assert.equal(restarted.state.round?.attempts.codex!.status, "cancelled");
  await restarted.recover();
  await restarted.tick();
  assert.equal(f.runner.launches.length, 1);
  await f.cleanup();
});
// Visible tool notices remain public; command visibility defaults off and host history stays complete.
test("public snapshot keeps tool notices and hides commands by default", async () => {
  const f = await fixture();
  f.controller.state.events = [
    {
      id: "public",
      round: 1,
      agent: "codex",
      at: 1,
      kind: "tool",
      text: "Tool running: rg",
    },
    {
      id: "command",
      round: 1,
      agent: "codex",
      at: 2,
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
    ["public", "command", "lane"],
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
test("live chat rounds refuse the native runner; rehearsal still starts", async () => {
  const store = new Store(":memory:");
  const make = (mode: "live" | "rehearsal") => {
    const controller = new Controller(
      store,
      new Filter([]),
      {
        evaluate: async () => ({ safety: 1, relevance: 1, simplicity: 100, clarity: 100, creativity: 100, visual: 100 }),
        choose: async () => "WAIT",
        surprise: async () => "Build a tiny surprise game with colourful cards",
      },
      new FakeRunner(),
      { validate: async (a, r) => `http://127.0.0.1:3211/page/${a}/${r}` },
      { start: async () => {}, startChats: async () => {}, stop: () => {}, preflight: async () => [], stopBroadcast: async () => {} },
      { ...options, mode, runnerMode: "native" },
      (text) => text,
      () => 1000,
    );
    controller.state.rehearsalComplete = true;
    controller.state.rehearsalRunnerMode = "native";
    return controller;
  };
  try {
    await assert.rejects(make("live").start(), /need the Docker runner/);
    const rehearsal = make("rehearsal");
    await rehearsal.start();
    await rehearsal.stop("test cleanup", false);
    await new Promise((r) => setImmediate(r));
  } finally { store.close(); }
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
    runner.launches[0]!.task.text,
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
    runner.launches[1]!.task.text,
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
        f.controller.state.round?.attempts[agent]!.status,
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
    f.runner.resolvers["session-1"]!({ status: "complete" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      f.controller.state.round!.attempts["session-1"]!.status,
      "complete",
    );
    assert.equal(
      f.controller.state.round!.attempts["session-2"]!.status,
      "running",
    );
    assert.equal(f.controller.state.status, "running");
    await f.controller.skip();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(f.runner.stopped.includes("session-2"));
    assert.equal(
      f.controller.state.round!.attempts["session-1"]!.model,
      "fixture-a",
    );
    assert.equal(
      f.controller.state.round!.attempts["session-2"]!.status,
      "cancelled",
    );
    assert.deepEqual(f.store.state()!.round!.sessions, sessions);
  } finally {
    await f.cleanup();
  }
});

// A scheduled manual break waits for both sessions and result display, then ends paused.
test("manual break keeps a server deadline and expiry pauses the show", async () => {
  const f = await fixture();
  try {
    await f.controller.manualBreak(10000,false);
    assert.equal(f.controller.state.status,"running");
    f.runner.resolvers.codex!({status:"complete"});
    f.runner.resolvers.cursor!({status:"complete"});
    await new Promise(resolve=>setImmediate(resolve));
    f.setTime(1031);await f.controller.tick();
    assert.equal(f.controller.state.breakKind,"manual");
    assert.equal(f.store.state()!.manualBreak!.deadline,11031);
    f.setTime(11031);await f.controller.tick();
    assert.equal(f.controller.state.status,"paused");
    assert.equal(f.store.state()!.status,"paused");
    assert.equal(f.controller.state.breakKind,undefined);
    assert.equal(f.controller.state.breakUntil,undefined);
    assert.equal(f.broadcastStops(),0);
  } finally {await f.cleanup();}
});

// An immediate break cancels both processes, while quota breaks keep their own transition.
test("immediate break stops both sessions and a quota break cannot be replaced", async()=>{
  const f=await fixture();
  try {
    await f.controller.manualBreak(10000,true);
    assert.deepEqual(new Set(f.runner.stopped),new Set(["codex","cursor"]));
    assert.equal(f.controller.state.breakKind,"manual");
    f.setTime(11000);await f.controller.tick();
    f.runner.quotaValue.remainingPercent=0;
    await f.controller.resume();
    assert.equal(f.controller.state.breakKind,"quota");
    await assert.rejects(f.controller.manualBreak(10000,true),/quota breaks cannot be replaced/);
  } finally {await f.cleanup();}
});

// Editing the queued prompt leaves the launched task untouched and invalidates old editors.
test("prepared prompt edits check the exact version and preserve the active round",async()=>{
  const f=await fixture();
  try {
    const active=f.controller.state.round!.task.text;
    f.controller.collection.prepared={text:"Draw a quiet ocean with drifting boats",author:"Viewer",platform:"youtube"};
    const version=f.controller.hostSnapshot().preparedVersion!;
    f.controller.editPrepared(version,"Draw a bright garden with moving flowers");
    assert.equal(f.controller.state.prepared!.author,"Host edited");
    assert.equal(f.controller.state.round!.task.text,active);
    assert.throws(()=>f.controller.editPrepared(version,"Draw another colourful garden"),/changed or launched/);
  } finally {await f.cleanup();}
});

// A host-ended break has no deadline and leaves through the full startup/quota path.
test("untimed manual break stays active until Resume and still enforces quota",async()=>{
  const f=await fixture();
  try {
    await f.controller.manualBreak(null,true);
    assert.equal(f.controller.state.breakKind,"manual");
    assert.equal(f.controller.state.manualBreak!.durationMs,null);
    assert.equal(f.store.state()!.manualBreak!.deadline,undefined);
    f.setTime(9_000_000);await f.controller.tick();
    assert.equal(f.controller.state.status,"break");
    f.runner.quotaValue.remainingPercent=0;
    await f.controller.resume();
    assert.equal(f.controller.state.breakKind,"quota");
    assert.equal(f.controller.state.manualBreak,undefined);
    await assert.rejects(f.controller.start(),/break transition/);
  } finally {await f.cleanup();}
});

// Start is also an explicit way to leave a manual break; a pending timer is cleared.
test("End break in session controls clears a manual arena break without restarting work", async () => {
  const f = await fixture();
  try {
    await f.controller.manualBreak(null, true);
    const launches = f.runner.launches.length;
    const recoveries = f.runner.recovered;
    f.controller.endManualBreak();
    assert.equal(f.controller.state.status, "paused");
    assert.equal(f.controller.state.manualBreak, undefined);
    assert.equal(f.store.state()!.breakKind, undefined);
    assert.equal(f.runner.launches.length, launches);
    assert.equal(f.runner.recovered, recoveries);
    assert.throws(() => f.controller.endManualBreak(), /active manual break/);
  } finally { await f.cleanup(); }
});

// Start is also an explicit way to leave a manual break; a pending timer is cleared.
test("Start ends a timed manual break early without skipping startup checks",async()=>{
  const f=await fixture();
  try {
    await f.controller.manualBreak(60000,true);
    const recoveries=f.runner.recovered;
    await f.controller.start();
    assert.ok(f.runner.recovered>recoveries);
    assert.equal(f.controller.state.manualBreak,undefined);
    assert.equal(f.controller.state.breakUntil,undefined);
    assert.notEqual(f.controller.state.status,"break");
  } finally {await f.cleanup();}
});
test("an idle tick neither rewrites state nor emits; a real change still does", async () => {
  const f = await fixture();
  try {
    f.controller.pause();
    let emits = 0;
    f.controller.on("state", () => emits++);
    let saves = 0;
    const save = f.store.save.bind(f.store);
    f.store.save = (...args) => {
      saves++;
      return save(...args);
    };
    await f.controller.tick();
    await f.controller.tick();
    assert.equal(emits, 0);
    assert.equal(saves, 0);
    f.controller.connection("youtube", "connected");
    assert.equal(emits, 1);
    assert.equal(saves, 1);
  } finally {
    await f.cleanup();
  }
});

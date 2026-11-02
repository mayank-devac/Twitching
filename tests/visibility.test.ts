// Characterization tests: they pin today's public projection of activity on
// both the arena path (controller snapshot -> publicActivity) and the managed
// session path (run ingest -> stored timeline -> view/publicView -> client
// visibleTimeline). A failure here means a privacy rule changed.
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.js";
import { Docker } from "../server/docker.js";
import { QuickSettings, defaultCriteria, preferencesSchema } from "../server/quick-settings.js";
import { publicModelLabel } from "../shared/types.js";
import { Sessions } from "../server/sessions/service.js";
import { CliRunner } from "../server/runner.js";
import { publicActivity } from "../server/settings-view.js";
import { stateView } from "../server/controller/round-state.js";
import { visibleTimeline } from "../shared/timeline.js";
import { visiblePage, withFileName } from "../shared/visibility.js";
import {
  defaultVisibility,
  type QuickPreferences,
  type SessionVisibility,
} from "../shared/settings.js";
import type { Activity, ShowState } from "../shared/types.js";
import type { TimelineItem } from "../shared/sessions.js";

const KINDS = [
  "tool",
  "command",
  "web",
  "read",
  "edit",
  "message",
  "summary",
  "output",
  "complete",
  "error",
] as const;
const allOn: SessionVisibility = {
  ...defaultVisibility,
  ...Object.fromEntries(KINDS.map((k) => [k, true])),
};
const allOff: SessionVisibility = {
  ...defaultVisibility,
  ...Object.fromEntries(KINDS.map((k) => [k, false])),
};
// Default, all on, all off, and each activity setting flipped from default.
const variants: [string, SessionVisibility][] = [
  ["default", defaultVisibility],
  ["all-on", allOn],
  ["all-off", allOff],
  ...KINDS.map(
    (k): [string, SessionVisibility] => [
      `flip-${k}`,
      { ...defaultVisibility, [k]: !defaultVisibility[k] },
    ],
  ),
];

// One event of every kind, plus every lane shape a parser can produce.
// SECRET marks text the fake redactor would rewrite if it were applied.
function events(agent: string, round = 3): Activity[] {
  const e = (id: string, kind: Activity["kind"], text: string, extra: Partial<Activity> = {}): Activity =>
    ({ id, round, agent, at: 10, kind, text, ...extra });
  return [
    e("m", "message", "msg SECRET"),
    e("s", "summary", "sum"),
    e("t", "tool", "tool"),
    e("c", "command", "cmd"),
    e("wb", "web", "web"),
    e("e", "edit", "edit"),
    e("o", "output", "out"),
    e("done", "complete", "done SECRET"),
    e("err", "error", "err"),
    e("rp", "command", "cat prompt_3.html", { lane: "read", publicFile: `prompt_${round}.html` }),
    e("rx", "command", "cat notes.txt", { lane: "read", publicFile: "notes.txt" }),
    e("rn", "command", "cat /host/secret", { lane: "read" }),
    e("term", "command", "npm test SECRET", { lane: "terminal" }),
    e("w", "edit", "write a.ts", { lane: "write" }),
    e("tl", "tool", "mcp call", { lane: "tool" }),
  ];
}
const ids = (list: { id: string }[]) =>
  list.map((x) => x.id.split(":").at(-1)).join(" ");

// Visible arena ids for agent "a" (whose entry is the variant). Agent "b" has
// no entry and always falls back to defaultVisibility.
const arenaExpected: Record<string, string> = {
  default: "m t wb o done err rp",
  "all-on": "m s t c wb e o done err rp term",
  "all-off": "",
  "flip-tool": "m wb o done err rp",
  "flip-command": "m t c wb o done err rp term",
  "flip-web": "m t o done err rp",
  "flip-read": "m t wb o done err",
  "flip-edit": "m t wb e o done err rp",
  "flip-message": "t wb o done err rp",
  "flip-summary": "m s t wb o done err rp",
  "flip-output": "m t wb done err rp",
  "flip-complete": "m t wb o err rp",
  "flip-error": "m t wb o done rp",
};

test("arena: publicActivity keeps today's rows for every visibility variant", () => {
  for (const [name, v] of variants) {
    const out = publicActivity([...events("a"), ...events("b")], { a: v });
    assert.equal(ids(out.filter((x) => x.agent === "a")), arenaExpected[name], name);
    assert.equal(ids(out.filter((x) => x.agent === "b")), arenaExpected.default, `${name} fallback`);
  }
});

test("arena: projected rows keep their shape and text unredacted", () => {
  const source = events("a");
  const out = publicActivity(source, { a: allOn });
  // Unlaned events pass through as the same object.
  assert.equal(out[0], source[0]);
  const byId = Object.fromEntries(out.map((x) => [x.id, x]));
  // Only prompt_<round>.html is named; it becomes a tool row with no lane.
  assert.deepStrictEqual(byId.rp, {
    id: "rp", round: 3, agent: "a", at: 10, kind: "tool", text: "Read prompt_3.html",
    lane: undefined, publicFile: "prompt_3.html",
  });
  // The terminal lane becomes a command row with its (already redacted) text.
  assert.deepStrictEqual(byId.term, {
    id: "term", round: 3, agent: "a", at: 10, kind: "command", text: "npm test SECRET", lane: undefined,
  });
  assert.equal(byId.done!.text, "done SECRET");
  // A prompt file of another round is never named.
  assert.deepEqual(publicActivity(events("a", 4).map((e) => ({ ...e, publicFile: e.publicFile && "prompt_3.html" })), { a: allOn }).map((x) => x.id).includes("rp"), false);
  // Input events are never mutated.
  assert.deepStrictEqual(source, events("a"));
});

test("arena: stateView publishes model labels and the visibility map regardless of model", () => {
  const doc = { revision: 7, value: { visibility: { a: { ...defaultVisibility, model: false } }, media: {}, directPreview: true } } as never;
  const state: ShowState = {
    status: "running", mode: "rehearsal", reason: "why SECRET", candidates: [], candidateCount: 0,
    events: [], connections: {}, checks: [], rehearsalComplete: false,
  };
  const view = stateView(state, doc, undefined, [{ id: "a", cli: "codex", model: "m1", effort: "high" }] as never, fakeClean, true);
  assert.deepEqual(view.models, { a: "m1 · high" });
  assert.deepEqual(view.agents, ["a"]);
  assert.deepEqual(view.quickSettings, { revision: 7, visibility: { a: { ...defaultVisibility, model: false } }, media: {}, directPreview: true, nativeRunner: true });
  assert.equal(view.reason, "why [R]");
});

const fakeClean = (text: string) => text.replaceAll("SECRET", "[R]");
function fixture(visibility: QuickPreferences["visibility"] = { "session-1": { ...defaultVisibility } }) {
  const store = new Store(":memory:");
  const preferences = new QuickSettings(store, {
    sessions: [{ id: "session-1", cli: "codex", model: "fixture-model" }],
    visibility,
    stream: { mode: "rehearsal", youtube: false, twitch: false, kick: false, collectionMs: 1000, extensionMs: 1000, resultMs: 1000 },
    jevCriteria: defaultCriteria,
    jevProbe: "Explain this function safely",
    directPreview: false,
    media: {},
  });
  const host = new Docker(store, { root: "/unused-fixture-root", image: "unused" });
  const sessions = new Sessions(store, preferences, { docker: host, native: host }, fakeClean, "welcome", async () => false, () => true);
  const setVisibility = (key: string, v: SessionVisibility | undefined) => {
    const doc = preferences.get();
    const next = { ...doc.value.visibility };
    if (v) next[key] = v; else delete next[key];
    preferences.save(doc.revision, { ...doc.value, visibility: next });
  };
  return { store, preferences, sessions, setVisibility };
}
// The runner is replaced so no CLI, Docker or model is ever started.
async function ingest(f: ReturnType<typeof fixture>, id: string) {
  const original = CliRunner.prototype.launch;
  CliRunner.prototype.launch = async function (round, _task, _at, emit) {
    for (const event of events("session-1", round)) emit(event);
    return { "session-1": { done: Promise.resolve({ status: "complete" as const }), stop: async () => {} } };
  };
  try {
    await f.sessions.run(id, "build SECRET");
    for (let i = 0; i < 200 && f.store.conversation(id)?.pendingRun; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
  } finally {
    CliRunner.prototype.launch = original;
  }
}
const row = (item: TimelineItem) => `${item.id.split(":").slice(1).join(":")}|${item.kind}|${item.text}`;

const sessionStored = [
  "prompt|prompt|build [R]",
  "m|message|msg SECRET",
  "s|summary|sum",
  "t|tool|tool",
  "c|command|cmd",
  "wb|web|web",
  "e|edit|edit",
  "o|output|out",
  "done|complete|Agent finished",
  "err|error|err",
  "rp|read|Read prompt_1.html",
  "rx|read|Read notes.txt",
  "result|complete|Prompt completed",
];
const sessionExpected: Record<string, string> = {
  default: "prompt m t wb o done err rp rx result",
  "all-on": "prompt m s t c wb e o done err rp rx result",
  "all-off": "prompt",
  "flip-tool": "prompt m wb o done err rp rx result",
  "flip-command": "prompt m t c wb o done err rp rx result",
  "flip-web": "prompt m t o done err rp rx result",
  "flip-read": "prompt m t wb o done err result",
  "flip-edit": "prompt m t wb e o done err rp rx result",
  "flip-message": "prompt t wb o done err rp rx result",
  "flip-summary": "prompt m s t wb o done err rp rx result",
  "flip-output": "prompt m t wb done err rp rx result",
  "flip-complete": "prompt m t wb o err rp rx",
  "flip-error": "prompt m t wb o done rp rx result",
};

test("session: run ingest stores only public lanes and labels", async () => {
  const f = fixture();
  try {
    const c = await f.sessions.create("codex", "docker");
    await ingest(f, c.id);
    // Activity text is stored as the runner sent it; host prompt and labels pass the redactor.
    assert.deepEqual(f.store.conversationPage(c.id).items.map(row), sessionStored);
  } finally {
    await f.sessions.close();
    f.store.close();
  }
});

test("session: view, public view and overlay keep today's rows for every visibility variant", async () => {
  const f = fixture();
  try {
    const c = await f.sessions.create("codex", "docker");
    await ingest(f, c.id);
    await f.sessions.publish(c.id);
    for (const [name, v] of variants) {
      f.setVisibility(c.id, v);
      const view = await f.sessions.view(c.id);
      assert.equal(ids(view.page.items), sessionExpected[name], name);
      assert.deepEqual(view.visibility, v);
      const pub = await f.sessions.publicHistory(c.id);
      assert.equal(ids(pub.page.items), sessionExpected[name], `${name} public`);
    }
    const base: ShowState = {
      status: "paused", mode: "rehearsal", reason: "", candidates: [], candidateCount: 0,
      events: [], connections: {}, checks: [], rehearsalComplete: false,
    };
    f.setVisibility(c.id, defaultVisibility);
    await f.sessions.publish(c.id);
    assert.equal(ids(f.sessions.snapshot(base).sharedSession!.page.items), sessionExpected.default);
  } finally {
    await f.sessions.close();
    f.store.close();
  }
});

test("session: public view strips private conversation fields and gates the model", async () => {
  const f = fixture();
  try {
    const c = await f.sessions.create("codex", "docker");
    await ingest(f, c.id);
    await f.sessions.publish(c.id);
    for (const model of [true, false])
      for (const hidePreviousRuns of [undefined, true]) {
        const v = { ...defaultVisibility, model, hidePreviousRuns };
        f.setVisibility(c.id, v);
        const host = await f.sessions.view(c.id);
        assert.equal(host.conversation.model, "fixture-model");
        assert.ok(host.conversation.config);
        const pub = await f.sessions.publicHistory(c.id);
        assert.deepEqual(Object.keys(pub.conversation).sort(), [
          "cli", "id", "model", "project", "runner", "source", "status", "title", "updatedAt",
        ].sort());
        assert.equal(pub.conversation.project, "");
        assert.equal(pub.conversation.model, model ? "fixture-model" : undefined);
        assert.equal(pub.hidePreviousRuns, !!hidePreviousRuns);
        assert.equal(pub.published, true);
        // Hiding old runs is applied by the client, not removed here.
        assert.equal(pub.page.latestRun, host.page.items.at(-1)!.run);
      }
  } finally {
    await f.sessions.close();
    f.store.close();
  }
});

test("session: visibility is looked up by conversation, then its slot, then defaults", async () => {
  const f = fixture({ "session-1": { ...allOff } });
  try {
    const c = await f.sessions.create("codex", "docker");
    await ingest(f, c.id);
    // No conversation entry: the session-1 slot applies.
    assert.equal(ids((await f.sessions.view(c.id)).page.items), "prompt");
    f.setVisibility(c.id, allOn);
    assert.equal(ids((await f.sessions.view(c.id)).page.items), sessionExpected["all-on"]);
  } finally {
    await f.sessions.close();
    f.store.close();
  }
});

test("client: visibleTimeline filters kinds and previous runs", () => {
  const item = (id: string, run: string, kind: TimelineItem["kind"]): TimelineItem => ({ id, run, kind, at: 1, text: id });
  const items = [
    item("p1", "r1", "prompt"), item("m1", "r1", "message"), item("c1", "r1", "command"), item("x1", "r1", "read"),
    item("p2", "r2", "prompt"), item("m2", "r2", "message"), item("c2", "r2", "command"), item("x2", "r2", "read"),
  ];
  const cases: [SessionVisibility, boolean, boolean, string | undefined, string][] = [
    [defaultVisibility, false, false, "r2", "p1 m1 x1 p2 m2 x2"],
    [defaultVisibility, true, false, "r2", "p2 m2 x2"],
    [defaultVisibility, true, true, "r2", "p1 m1 x1 p2 m2 x2"],
    [defaultVisibility, true, false, undefined, ""],
    [allOn, true, false, "r1", "p1 m1 c1 x1"],
    [allOff, false, false, "r2", "p1 p2"],
    [{ ...defaultVisibility, read: false }, false, false, "r2", "p1 m1 p2 m2"],
  ];
  for (const [v, hide, show, latest, expected] of cases)
    assert.equal(ids(visibleTimeline(items, v, hide, show, latest)), expected);
});

test("edit rows name their file only when read file names is on", () => {
  const item = { id: "a:0", run: "r", at: 1, kind: "edit" as const, text: "Files edited", placeholder: true as const, file: "runner.ts" };
  const off = withFileName(item, { ...defaultVisibility, read: false });
  assert.equal(off.file, undefined);
  assert.equal(off.text, "Files edited");
  assert.equal(off.placeholder, true);
  assert.ok(!JSON.stringify(off).includes("runner.ts"));
  const on = withFileName(item, { ...defaultVisibility, read: true });
  assert.equal(on.text, "Edited runner.ts");
  assert.equal(on.placeholder, undefined);
  const page = visiblePage({ items: [item] }, { ...defaultVisibility, read: false, edit: true });
  assert.ok(!JSON.stringify(page).includes("runner.ts"));
});

test("settings saved before the effort toggle keep effort hidden when the model is hidden", () => {
  const { effort: _effort, ...saved } = defaultVisibility;
  const parse = (visibility: Record<string, unknown>) => {
    const parsed = preferencesSchema.parse({
      sessions: [{ id: "session-1", cli: "codex", model: "m1", effort: "high" }],
      visibility: { "session-1": visibility },
      stream: { mode: "rehearsal", youtube: false, twitch: false, kick: false, collectionMs: 1000, extensionMs: 1000, resultMs: 1000 },
      jevCriteria: defaultCriteria,
      jevProbe: "Explain this function safely",
      media: {},
    });
    return parsed.visibility["session-1"]!;
  };
  const hidden = parse({ ...saved, model: false });
  assert.equal(hidden.effort, false);
  assert.equal(publicModelLabel({ model: "m1", effort: "high" }, hidden), "");
  assert.equal(parse({ ...saved, model: true }).effort, true);
  // An explicit choice still wins over the model toggle.
  assert.equal(parse({ ...saved, model: false, effort: true }).effort, true);
});

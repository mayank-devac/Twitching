import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.js";
import { Overlays } from "../server/sessions/overlays.js";
import { defaultVisibility } from "../shared/settings.js";
import {
  applyOverlayPatches,
  overlayPatches,
} from "../shared/overlay-stream.js";
import {
  uniqueConversations,
  type Conversation,
  type OverlayDefinition,
  type OverlayView,
  type SessionView,
} from "../shared/sessions.js";

// Model/OBS/provider operations are fixtures: these cases exercise only publication ownership and history.
function fixture() {
  const store = new Store(":memory:");
  const values = new Map<string, SessionView>();
  const held = new Map<
    string,
    { value: Promise<SessionView>; began(): void }
  >();
  for (let index = 0; index < 10; index++) {
    const conversation: Conversation = {
      id: "managed:session-" + index,
      source: "managed",
      cli: "codex",
      title: "Same title",
      project: "",
      updatedAt: index,
      status: "running",
    };
    values.set(conversation.id, {
      conversation,
      page: {
        items: [
          {
            id: "same-item",
            run: "run-" + index,
            at: index,
            kind: "message",
            text: "Private answer " + index,
          },
        ],
      },
      visibility: { ...defaultVisibility },
      hidePreviousRuns: false,
      published: false,
    });
  }
  let running = [...values.values()]
    .slice(0, 9)
    .map((view) => view.conversation);
  const overlays = new Overlays(store, {
    name: (name) => name,
    view: async (id) => {
      const delay = held.get(id);
      if (delay) {
        delay.began();
        return delay.value;
      }
      const value = values.get(id);
      if (!value) throw new Error("Missing fixture");
      return structuredClone(value);
    },
    publicView: (view) => ({ ...view, published: true }),
    running: () =>
      running.filter((conversation) => conversation.status === "running"),
    eligible: () => true,
    approve: async () => {},
  });
  const save = (overlay: OverlayDefinition) =>
    overlays.save(overlays.host().revision, overlay);
  return {
    store,
    overlays,
    values,
    save,
    setRunning: (next: Conversation[]) => {
      running = next;
    },
    hold: (id: string) => {
      let release!: (view: SessionView) => void, began!: () => void;
      const value = new Promise<SessionView>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      held.set(id, { value, began });
      return {
        started,
        release: () => {
          held.delete(id);
          release(structuredClone(values.get(id)!));
        },
      };
    },
    close: () => {
      overlays.close();
      store.close();
    },
  };
}

test("session pages deduplicate IDs and preserve two different sessions with the same title", () => {
  const f = fixture();
  try {
    const first = f.values.get("managed:session-0")!.conversation;
    const second = f.values.get("managed:session-1")!.conversation;
    const rows = uniqueConversations([
      first,
      second,
      { ...first, updatedAt: 99 },
      { ...first, updatedAt: 3 },
    ]);
    assert.deepEqual(
      rows.map((row) => row.id),
      [first.id, second.id],
    );
    assert.equal(rows[0]!.updatedAt, 99);
  } finally {
    f.close();
  }
});

test("named outputs isolate assignment/history and stop without modifying another output", async () => {
  const f = fixture();
  try {
    const created = f.overlays.create(0, "Side output").createdId;
    const side = f.overlays
      .host()
      .overlays.find((overlay) => overlay.id === created)!;
    await f.save({
      ...side,
      sessionIds: ["managed:session-0", "managed:session-1"],
      published: true,
    });
    assert.equal(f.overlays.snapshot().frames.length, 0);
    assert.deepEqual(
      f.overlays.snapshot(created).frames.map((frame) => frame.conversation.id),
      ["managed:session-0", "managed:session-1"],
    );
    await assert.rejects(
      () => f.overlays.history("default", "managed:session-0"),
      /not on this overlay/,
    );
    await assert.rejects(
      () => f.overlays.history(created, "managed:session-2"),
      /not on this overlay/,
    );
    const main = f.overlays
      .host()
      .overlays.find((overlay) => overlay.id === "default")!;
    await f.save({
      ...main,
      sessionIds: ["managed:session-2"],
      published: true,
    });
    f.overlays.stop(created);
    assert.equal(f.overlays.snapshot(created).frames.length, 0);
    assert.equal(
      f.overlays.snapshot().frames[0]!.page.items[0]!.text,
      "Private answer 2",
    );
    assert.equal(f.values.size, 10);
    assert.equal(
      f.store.overlays()!.overlays.find((overlay) => overlay.id === created)!
        .sessionIds.length,
      2,
    );
  } finally {
    f.close();
  }
});

test("the eight-session cap and revision check apply on the server", async () => {
  const f = fixture();
  try {
    const main = f.overlays.host().overlays[0]!;
    const ids = [...f.values.keys()];
    await assert.rejects(
      () => f.save({ ...main, sessionIds: ids.slice(0, 9), published: true }),
      /eight/,
    );
    await f.save({ ...main, sessionIds: ids.slice(0, 8), published: true });
    assert.equal(f.overlays.snapshot().frames.length, 8);
    await assert.rejects(
      () => f.overlays.save(0, { ...main, sessionIds: [], published: false }),
      /another tab/,
    );
    assert.equal(f.overlays.snapshot().frames.length, 8);
  } finally {
    f.close();
  }
});

test("running snapshots stay fixed and automatic outputs follow verified activity", async () => {
  const f = fixture();
  try {
    await f.save({
      ...f.overlays.host().overlays[0]!,
      selection: "running-snapshot",
      published: true,
    });
    assert.equal(f.overlays.snapshot().frames.length, 8);
    assert.equal(f.overlays.snapshot().omittedRunning, 1);
    const next = [...f.values.values()]
      .slice(1)
      .map((view) => view.conversation);
    f.setRunning(next);
    await f.overlays.refresh();
    assert.equal(
      f.overlays.snapshot().frames[0]!.conversation.id,
      "managed:session-0",
    );
    await f.save({
      ...f.overlays.host().overlays[0]!,
      name: "Renamed fixed output",
    });
    assert.equal(
      f.overlays.snapshot().frames[0]!.conversation.id,
      "managed:session-0",
    );
    await f.overlays.save(
      f.overlays.host().revision,
      f.overlays.host().overlays[0]!,
      true,
    );
    assert.equal(
      f.overlays.snapshot().frames[0]!.conversation.id,
      "managed:session-1",
    );
    await f.save({
      ...f.overlays.host().overlays[0]!,
      selection: "follow-running",
    });
    assert.equal(
      f.overlays.snapshot().frames[0]!.conversation.id,
      "managed:session-1",
    );
    f.setRunning([{ ...next[0]!, status: "unknown" }, next[1]!]);
    await f.overlays.refresh();
    assert.deepEqual(
      f.overlays.snapshot().frames.map((frame) => frame.conversation.id),
      ["managed:session-2"],
    );
  } finally {
    f.close();
  }
});

test("restart preserves output definitions and requires publication again", async () => {
  const f = fixture();
  try {
    await f.save({
      ...f.overlays.host().overlays[0]!,
      sessionIds: ["managed:session-0"],
      published: true,
    });
    const crashedDocument = f.store.overlays()!;
    f.overlays.close();
    f.store.saveOverlays(crashedDocument);
    const restored = new Overlays(f.store, {
      name: (name) => name,
      view: async (id) => f.values.get(id)!,
      publicView: (view) => view,
      running: () => [],
      eligible: () => true,
      approve: async () => {},
    });
    try {
      assert.equal(restored.snapshot().published, false);
      assert.deepEqual(restored.host().overlays[0]!.sessionIds, [
        "managed:session-0",
      ]);
    } finally {
      restored.close();
    }
  } finally {
    f.close();
  }
});

test("stopping an overlay cancels an in-flight publication instead of reviving it", async () => {
  const f = fixture();
  try {
    await f.save({
      ...f.overlays.host().overlays[0]!,
      sessionIds: ["managed:session-0"],
      published: true,
    });
    const held = f.hold("managed:session-1");
    const change = f.save({
      ...f.overlays.host().overlays[0]!,
      sessionIds: ["managed:session-1"],
      published: true,
    });
    await held.started;
    f.overlays.stop();
    held.release();
    await assert.rejects(() => change, /Publication changed/);
    assert.equal(f.overlays.snapshot().published, false);
    assert.equal(f.overlays.snapshot().frames.length, 0);
  } finally {
    f.close();
  }
});

test("two conversations with the same item IDs reconstruct patches independently", () => {
  const f = fixture();
  try {
    const frames = [
      structuredClone(f.values.get("managed:session-0")!),
      structuredClone(f.values.get("managed:session-1")!),
    ];
    const before: OverlayView = {
      id: "one",
      name: "One",
      revision: 1,
      published: true,
      omittedRunning: 0,
      frames,
    };
    const next = structuredClone(before);
    next.frames[0]!.page.items[0]!.text += " TAIL";
    const patches = overlayPatches(before, next);
    assert.equal(patches[0]!.patches[0]!.event.text, " TAIL");
    const wire = {
      ...next,
      frames: next.frames.map((frame) => ({
        ...frame,
        page: { ...frame.page, items: [] },
      })),
    };
    assert.deepEqual(applyOverlayPatches(before, wire, patches), next);
    const other = { ...next, id: "other-output" };
    assert.equal(
      overlayPatches(before, other)[0]!.patches[0]!.prefixLength,
      undefined,
    );
  } finally {
    f.close();
  }
});
test("a refresh with unchanged public views does not emit state", async () => {
  const f = fixture();
  try {
    await f.save({ ...f.overlays.host().overlays[0]!, selection: "selected", sessionIds: ["managed:session-0"], published: true });
    await f.overlays.refresh();
    let emits = 0;
    f.overlays.on("state", () => emits++);
    await f.overlays.refresh();
    assert.equal(emits, 0);
    f.values.get("managed:session-0")!.page.items[0]!.text += " more";
    await f.overlays.refresh();
    assert.equal(emits, 1);
  } finally {
    f.close();
  }
});

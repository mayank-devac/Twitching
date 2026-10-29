import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.js";
import { Docker } from "../server/docker.js";
import { QuickSettings, defaultCriteria } from "../server/quick-settings.js";
import { Sessions } from "../server/sessions/service.js";
import { defaultVisibility } from "../shared/settings.js";
import type { ShowState } from "../shared/types.js";
import type { TimelineItem } from "../shared/sessions.js";
import {
  activityPatches,
  mergeActivityPatches,
} from "../shared/activity-stream.js";

// These fixtures never invoke a CLI, Docker, OBS or a model.
test("growing conversation messages send only the new text and recover from a snapshot", () => {
  const before: TimelineItem = {
    id: "answer",
    run: "first-run",
    kind: "message",
    at: 1,
    text: "A".repeat(8000),
  };
  const after: TimelineItem = { ...before, text: before.text + "TAIL" };
  const patches = activityPatches([before], [after]);
  assert.equal(patches[0].event.text, "TAIL");
  assert.deepEqual(mergeActivityPatches([before], patches, [after.id]), [
    after,
  ]);
  assert.throws(
    () => mergeActivityPatches<TimelineItem>([], patches, [after.id]),
    /reconnect/,
  );
  assert.deepEqual(
    mergeActivityPatches<TimelineItem>(
      [],
      activityPatches<TimelineItem>([], [after]),
      [after.id],
    ),
    [after],
  );
});

test("preview is private; publication and history never mix two same-CLI sessions", async () => {
  const store = new Store(":memory:");
  const preferences = new QuickSettings(store, {
    sessions: [{ id: "session-1", cli: "codex", model: "fixture-model" }],
    visibility: { "session-1": { ...defaultVisibility } },
    stream: {
      mode: "rehearsal",
      youtube: false,
      twitch: false,
      kick: false,
      collectionMs: 1000,
      extensionMs: 1000,
      resultMs: 1000,
    },
    jevCriteria: defaultCriteria,
    jevProbe: "Explain this function safely",
    media: {},
  });
  const host = new Docker(store, {
    root: "/unused-fixture-root",
    image: "unused",
  });
  const sessions = new Sessions(
    store,
    preferences,
    { docker: host, native: host },
    (text) => text,
    "welcome",
    async () => false,
    () => true,
  );
  const base: ShowState = {
    status: "paused",
    mode: "rehearsal",
    reason: "Private arena task",
    candidates: [],
    candidateCount: 0,
    events: [],
    connections: {},
    checks: [],
    rehearsalComplete: false,
  };
  try {
    const first = await sessions.create("codex", "docker");
    const second = await sessions.create("codex", "docker");
    store.conversationItem(first.id, {
      id: "same-item",
      run: "first-run",
      kind: "message",
      at: 1,
      text: "First private answer",
    });
    store.conversationItem(second.id, {
      id: "same-item",
      run: "second-run",
      kind: "message",
      at: 2,
      text: "Second private answer",
    });
    assert.equal(
      (await sessions.view(first.id)).page.items[0].text,
      "First private answer",
    );
    assert.equal(sessions.snapshot(base).sharedSession, undefined);
    await sessions.publish(first.id);
    const published = sessions.snapshot(base).sharedSession!;
    assert.equal(published.page.items[0].text, "First private answer");
    assert.equal(published.conversation.config, undefined);
    assert.equal(sessions.snapshot(base).reason, "Selected session on stream");
    await sessions.view(second.id);
    assert.equal(
      sessions.snapshot(base).sharedSession!.conversation.id,
      first.id,
    );
    await assert.rejects(
      () => sessions.publicHistory(second.id),
      /not on this overlay/,
    );
    sessions.stopPublication();
    assert.equal(sessions.snapshot(base).sharedSession, undefined);
    assert.equal(store.conversationPage(first.id).items.length, 1);
    await assert.rejects(
      () => sessions.create("codex", "native"),
      /Type NATIVE/,
    );
    store.conversationItem(first.id, {
      id: "complete",
      run: "first-run",
      kind: "complete",
      at: 3,
      text: "Prompt completed",
    });
    await sessions.publish(first.id);
    await sessions.confirmRehearsal(first.id);
    const doc = preferences.get();
    doc.value.stream.mode = "live";
    preferences.save(doc.revision, doc.value);
    sessions.settingsChanged();
    assert.equal(sessions.snapshot(base).sharedSession, undefined);
    await assert.rejects(
      () => sessions.publish(first.id),
      /Start the OBS broadcast manually/,
    );
  } finally {
    await sessions.close();
    store.close();
  }
});

test("large managed messages preserve their tail through bounded history fragments", () => {
  const store = new Store(":memory:");
  try {
    const text = "A".repeat(40_000) + "TAIL";
    store.conversationItem("managed:one", {
      id: "answer",
      run: "one",
      kind: "message",
      at: 1,
      text,
    });
    const page = store.conversationPage("managed:one");
    assert.equal(page.items.map((item) => item.text).join(""), text);
    assert.ok(page.items.every((item) => item.text.length <= 16000));
    store.conversationItem("managed:one", {
      id: "answer",
      run: "one",
      kind: "message",
      at: 2,
      text: "Replaced",
    });
    assert.deepEqual(
      store.conversationPage("managed:one").items.map((item) => item.text),
      ["Replaced"],
    );
  } finally {
    store.close();
  }
});

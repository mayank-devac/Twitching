import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Store } from "../server/store.js";
import {
  QuickSettings,
  defaultCriteria,
  preferencesSchema,
} from "../server/quick-settings.js";
import { BreakMedia, detectMedia } from "../server/break-media.js";
import {
  defaultVisibility,
  type QuickPreferences,
} from "../shared/settings.js";
import { Collection } from "../server/collection.js";
import { Filter } from "../server/filter.js";
import { ActivityAdapter } from "../server/activity.js";
import type { Activity, ChatMessage } from "../shared/types.js";

// These fixtures use only memory SQLite and temporary files; no CLI/OBS/paid calls.
const defaults = (): QuickPreferences => ({
  sessions: [{ id: "session-1", cli: "codex", model: "fixture" }],
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
  jevProbe: "Create a colourful bouncing ball animation",
  media: {},
});
test("settings survive reload and a stale tab cannot overwrite a newer save", () => {
  const store = new Store(":memory:");
  try {
    const preferences = new QuickSettings(store, defaults());
    const tabA = preferences.get();
    const tabB = preferences.get();
    tabA.value.sessions[0].model = "new-model";
    preferences.save(tabA.revision, tabA.value);
    assert.throws(
      () => preferences.save(tabB.revision, tabB.value),
      /another tab/,
    );
    assert.equal(
      new QuickSettings(store, defaults()).get().value.sessions[0].model,
      "new-model",
    );
    const startup = new QuickSettings(store, defaults(), {
      mode: "rehearsal",
      sessions: defaults().sessions,
    });
    assert.equal(startup.get().value.sessions[0].model, "fixture");
    assert.equal(
      preferencesSchema.safeParse({ ...defaults(), runnerMode: "native" })
        .success,
      false,
    );
    assert.equal(
      preferencesSchema.safeParse({
        ...defaults(),
        sessions: [defaults().sessions[0], defaults().sessions[0]],
      }).success,
      false,
    );
  } finally {
    store.close();
  }
});

test("media rejects active documents, traversal and symlinks while round-tripping an image", async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "arena-media-")));
  const mediaStore = new Store(":memory:");
  try {
    const media = new BreakMedia(root, mediaStore);
    assert.throws(
      () =>
        detectMedia(
          Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
          ),
        ),
      /Use a valid/,
    );
    const gif = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
      "base64",
    );
    const uploaded = await media.upload(gif, "C:\\private\\evening loop.gif");
    assert.equal(uploaded.type, "image/gif");
    assert.equal(uploaded.name, "evening loop.gif");
    assert.equal(
      (await new BreakMedia(root, mediaStore).list())[0].name,
      "evening loop.gif",
    );
    assert.equal((await media.list()).length, 1);
    assert.equal((await media.path(uploaded.id)).type, "image/gif");
    await assert.rejects(media.path("../settings.json"), /Invalid media ID/);
    await assert.rejects(
      media.upload(Buffer.alloc(12 * 1024 * 1024 + 1)),
      /Maximum upload size/,
    );
    const linked = "a".repeat(32) + ".gif";
    await symlink(
      resolve(root, "settings.json"),
      resolve(root, "runtime/break-media", linked),
    );
    await assert.rejects(media.path(linked));
    const second = resolve(root, "other");
    await mkdir(second);
    await symlink(second, resolve(root, "unsafe"));
    const unsafe = new BreakMedia(resolve(root, "unsafe"));
    await assert.rejects(unsafe.list(), /Unsafe media directory/);
  } finally {
    mediaStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("criteria change waits for reset and cannot reuse an old cached evaluation", async () => {
  const store = new Store(":memory:");
  let now = 1000;
  let evaluations = 0;
  let criteria = "";
  const options = {
    collectionMs: 1000,
    extensionMs: 1000,
    safetyThreshold: 0.9,
    relevanceThreshold: 0.8,
    minScore: 50,
    jevCriteria: "Prefer bright colours",
  };
  const collection = new Collection(
    new Filter([]),
    {
      setCriteria: (value) => {
        criteria = value;
      },
      evaluate: async () => {
        evaluations++;
        return {
          safety: 1,
          relevance: 1,
          simplicity: 100,
          clarity: 100,
          creativity: 100,
          visual: 100,
        };
      },
      choose: async () => "WAIT",
      surprise: async () => "Create a colourful bouncing ball animation",
    },
    store,
    options,
    () => {},
    () => now,
  );
  const message = (id: string): ChatMessage => ({
    id,
    platform: "youtube",
    authorId: "viewer",
    author: "Viewer",
    text: "!prompt Create a colourful bouncing ball animation",
    timestamp: now,
    membership: { verified: false, member: false, gift: false },
  });
  try {
    await collection.ingest(message("one"));
    assert.equal(evaluations, 1);
    options.jevCriteria = "Prefer calm small games";
    options.extensionMs = 5000;
    assert.equal(criteria, "Prefer bright colours");
    now = 2000;
    await collection.tick();
    assert.equal(collection.deadline, 3000);
    collection.reset();
    assert.equal(criteria, "Prefer calm small games");
    await collection.ingest(message("two"));
    assert.equal(evaluations, 2);
    collection.reset();
    await collection.ingest(message("three"));
    assert.equal(evaluations, 2);
  } finally {
    store.close();
  }
});

test("read metadata cannot turn a private path or search pattern into a public filename", () => {
  const events: Activity[] = [];
  const adapter = new ActivityAdapter(
    "cursor",
    7,
    (text) => text,
    (e) => events.push(e),
  );
  const read = (id: string, path: string) =>
    adapter.receive({
      type: "tool_call",
      subtype: "completed",
      call_id: id,
      tool_call: { readToolCall: { args: { path } } },
    });
  read("safe", "/workspace/prompt_7.html");
  read("private", "/private/auth/prompt_7.html");
  read("secret", "/workspace/.env");
  const reads = events.filter((e) => e.lane === "read");
  assert.equal(reads.length, 3);
  assert.equal(reads[0].publicFile, "prompt_7.html");
  assert.equal(reads[1].publicFile, undefined);
  assert.equal(reads[2].publicFile, undefined);
});

// HTTP tests exercise the real protection/validation routes, with discovery replaced by a fixture.
test("settings routes require host protection, reject unavailable models and reject stale writes", async () => {
  const { EventEmitter } = await import("node:events");
  const { makeHttp } = await import("../server/http.js");
  const root = await realpath(
    await mkdtemp(resolve(tmpdir(), "arena-settings-http-")),
  );
  const store = new Store(":memory:");
  const preferences = new QuickSettings(store, defaults());
  const controller = Object.assign(new EventEmitter(), {
    snapshot: () => ({ events: [] }),
    assertSettingsChange: () => {},
    settingsChanged: () => {},
    safeHistory: (page: unknown) => page,
  }) as unknown as import("../server/controller.js").Controller;
  const origin = "http://127.0.0.1:39232";
  const http = makeHttp(controller, {
    host: "127.0.0.1",
    port: 39232,
    root,
    previewOrigin: "http://127.0.0.1:39233",
    musicPath: resolve(root, "missing.mp3"),
    quick: {
      store,
      preferences,
      media: new BreakMedia(root, store),
      defaults: {
        audio: resolve(root, "calm track.mp3"),
        visual: resolve(root, "break-eye.html"),
        visualUrl: "http://127.0.0.1:39233/break",
      },
      discover: async () => [{ id: "fixture", efforts: ["high"] }],
    },
  });
  await new Promise<void>((resolve) =>
    http.server.listen(39232, "127.0.0.1", resolve),
  );
  try {
    assert.equal((await fetch(origin + "/api/settings")).status, 403);
    const host = await fetch(origin + "/api/host");
    const { csrf } = (await host.json()) as { csrf: string };
    const headers = {
      Origin: origin,
      "X-Host-Token": csrf,
      Cookie: host.headers.get("set-cookie")!.split(";")[0],
      "Content-Type": "application/json",
    };
    const library = await fetch(origin + "/api/break-media", { headers });
    const assets = (await library.json()) as {
      defaults: { audio: { name: string }; visual: { name: string } };
    };
    assert.equal(assets.defaults.audio.name, "calm track.mp3");
    assert.equal(assets.defaults.visual.name, "break-eye.html");
    const save = (body: unknown) =>
      fetch(origin + "/api/settings", {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
    const unavailable = defaults();
    unavailable.sessions[0].model = "not-installed";
    assert.equal((await save({ revision: 0, value: unavailable })).status, 409);
    assert.equal(preferences.get().revision, 0);
    const valid = defaults();
    valid.sessions[0].effort = "high";
    assert.equal((await save({ revision: 0, value: valid })).status, 200);
    assert.equal((await save({ revision: 0, value: defaults() })).status, 409);
    assert.equal(preferences.get().value.sessions[0].effort, "high");
    const bad = await fetch(origin + "/api/break-media", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/octet-stream" },
      body: "<html><script>alert('no')</script></html>",
    });
    assert.equal(bad.status, 400);
    assert.equal(
      (
        await fetch(origin + "/api/settings", {
          headers: { ...headers, Origin: "https://example.com" },
        })
      ).status,
      403,
    );
  } finally {
    await http.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

import { readFile } from "node:fs/promises";
import { ActivityAdapter, JsonLines } from "../server/activity.js";
import { Filter } from "../server/filter.js";
import { Collection } from "../server/collection.js";
import { Store } from "../server/store.js";
import type { Agent, ChatMessage } from "../shared/types.js";
const store = new Store(":memory:");
const adapters = Object.fromEntries(
  (["codex", "cursor"] as Agent[]).map((agent) => [
    agent,
    new ActivityAdapter(
      agent,
      1,
      (s) => s,
      (e) => console.log(`${e.agent} ${e.kind}: ${e.text}`),
    ),
  ]),
) as Record<Agent, ActivityAdapter>;
const lines = new JsonLines((record) =>
  adapters[record.agent as Agent].receive(record.event),
);
const bytes = await readFile(
  new URL("../tests/fixtures/cli.ndjson", import.meta.url),
);
for (let i = 0; i < bytes.length; i += 13)
  lines.push(bytes.subarray(i, i + 13));
lines.end();
let now = 1000;
const collection = new Collection(
  new Filter(["fuck"]),
  {
    evaluate: async () => ({
      safety: 1,
      relevance: 1,
      simplicity: 80,
      clarity: 80,
      creativity: 80,
      visual: 80,
    }),
    choose: async (c) => c[0]?.id ?? "WAIT",
    surprise: async () => "Build a tiny surprise game with colourful cards",
  },
  store,
  {
    collectionMs: 60,
    extensionMs: 180,
    safetyThreshold: 0.95,
    relevanceThreshold: 0.85,
    minScore: 50,
  },
  () => {},
  () => now,
);
const chat = JSON.parse(
  await readFile(
    new URL("../tests/fixtures/chat.json", import.meta.url),
    "utf8",
  ),
);
for (const [i, record] of chat.entries()) {
  const message: ChatMessage = {
    id: String(i),
    platform: record.platform,
    authorId: record.platform === "youtube" ? "same-viewer" : String(i),
    author: "Replay viewer",
    text: record.text,
    timestamp: now,
    membership: {
      verified: true,
      member: record.member === true,
      gift: false,
      evidence: "fixture-only",
    },
  };
  await collection.ingest(message);
}
now += 60;
await collection.tick();
console.log(
  "Documentation-shaped fixture replay only; no live chat, Jev call or CLI job was run.",
);
console.log(
  `Eligible: ${collection.candidates.length}; selection: ${collection.prepared?.text ?? "WAIT"}`,
);
store.close();

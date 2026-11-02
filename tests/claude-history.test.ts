import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeHistory } from "../server/sessions/claude-history.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const line = (value: object) => JSON.stringify(value);
const transcript = [
  line({ type: "user", uuid: "u0", isMeta: true, timestamp: "2026-11-02T10:00:00Z", cwd: "/Users/me/Twitching", message: { content: "<command-name>/model</command-name>" } }),
  line({ type: "user", uuid: "u1", timestamp: "2026-11-02T10:00:01Z", cwd: "/Users/me/Twitching", message: { role: "user", content: "Build the Claude harness" } }),
  line({ type: "assistant", uuid: "a1", timestamp: "2026-11-02T10:00:02Z", cwd: "/Users/me/Twitching", effort: "high", message: { model: "claude-opus-5-5", content: [
    { type: "thinking", thinking: "Read the adapters first." },
    { type: "text", text: "Reading the adapters." },
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "grep -rn SECRET_ARG ." } },
    { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/Users/me/x.ts", new_string: "PRIVATE EDIT" } },
    { type: "tool_use", id: "t3", name: "Read", input: { file_path: "/Users/me/y.ts" } },
    { type: "tool_use", id: "t4", name: "WebSearch", input: { query: "claude stream-json events" } },
    { type: "tool_use", id: "t5", name: "WebFetch", input: { url: "https://code.claude.com/docs/en/hooks.md?key=PRIVATE_QS", prompt: "PRIVATE PROMPT" } },
    { type: "tool_use", id: "t6", name: "Read", input: { file_path: "/Users/me/Twitching/web/Timeline.tsx" } },
    { type: "tool_use", id: "t7", name: "Read", input: { file_path: "/Users/me/Twitching/.env.local" } },
  ] } }),
  line({ type: "user", uuid: "r1", timestamp: "2026-11-02T10:00:03Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "PRIVATE OUTPUT" }] } }),
  line({ type: "assistant", uuid: "s1", isSidechain: true, message: { content: [{ type: "text", text: "SUBAGENT TEXT" }] } }),
  "not json",
  line({ type: "summary", summary: "Claude harness plan", leafUuid: "a1" }),
].join("\n");

async function fixture() {
  const config = await mkdtemp(resolve(tmpdir(), "stram-claude-history-"));
  const project = resolve(config, "projects", "-Users-me-Twitching");
  await mkdir(project, { recursive: true });
  await writeFile(resolve(project, `${A}.jsonl`), transcript);
  await writeFile(resolve(project, `${B}.jsonl`), line({ type: "user", uuid: "x", cwd: "/Users/me/other", message: { content: "Older task" } }));
  await utimes(resolve(project, `${B}.jsonl`), new Date(1000), new Date(1000));
  await writeFile(resolve(config, ".credentials.json"), "NEVER_READ");
  await writeFile(resolve(project, "notes.jsonl"), line({ type: "user", message: { content: "not a session" } }));
  return config;
}

test("Claude history lists saved sessions newest first with title, project and model", async () => {
  const config = await fixture();
  try {
    const history = new ClaudeHistory((s) => s, config);
    const page = await history.list("");
    assert.deepEqual(page.conversations.map((c) => c.id), [`claude:${A}`, `claude:${B}`]);
    const first = page.conversations[0]!;
    assert.equal(first.title, "Claude harness plan");
    assert.equal(first.project, "Twitching");
    assert.equal(first.model, "claude-opus-5-5");
    assert.equal(first.effort, "high");
    assert.equal(page.conversations[1]!.effort, undefined);
    assert.equal(first.cli, "claude");
    assert.equal(first.source, "claude");
    assert.equal(page.conversations[1]!.title, "Older task");
    assert.deepEqual((await history.list("older")).conversations.map((c) => c.providerId), [B]);
    assert.equal((await history.read(A)).title, "Claude harness plan");
    await assert.rejects(history.read("../.credentials"), /Invalid Claude session ID/);
  } finally {
    await rm(config, { recursive: true, force: true });
  }
});

test("Claude history timeline shows prompts and replies but keeps tool details private", async () => {
  const config = await fixture();
  try {
    const page = await new ClaudeHistory((s) => s, config).page(A);
    const json = JSON.stringify(page);
    for (const hidden of ["PRIVATE OUTPUT", "PRIVATE EDIT", "SECRET_ARG", "SUBAGENT TEXT", "/model", "/Users/me", "PRIVATE_QS", "PRIVATE PROMPT"])
      assert.ok(!json.includes(hidden), hidden);
    assert.ok(!json.includes(".env"));
    // A read outside the project or of a hidden file stays a plain tool row.
    assert.deepEqual(page.items.map((i) => i.kind), ["prompt", "summary", "message", "command", "edit", "tool", "web", "web", "read", "tool"]);
    assert.equal(page.items[8]!.text, "Read Timeline.tsx");
    // /Users/me/x.ts is outside the fixture's project folder, so no file name is attached.
    assert.equal(page.items[4]!.file, undefined);
    assert.equal(page.items[0]!.text, "Build the Claude harness");
    assert.equal(page.items[3]!.text, "Command: grep (recorded)");
    assert.equal(page.items[5]!.text, "Read");
    assert.equal(page.items[5]!.placeholder, undefined);
    assert.equal(page.items[6]!.text, "Searched the web: claude stream-json events");
    assert.equal(page.items[7]!.text, "Fetched code.claude.com/docs/en/hooks.md");
    assert.equal(page.latestRun, "u1");
    const older = await new ClaudeHistory((s) => s, config).page(A, undefined, 2);
    assert.equal(older.items.length, 2);
    assert.equal(older.before, "8");
    assert.equal((await new ClaudeHistory((s) => s, config).page(A, older.before, 60)).items.length, 8);
  } finally {
    await rm(config, { recursive: true, force: true });
  }
});

test("Claude history ignores linked transcripts and a missing config", async () => {
  const config = await fixture();
  try {
    const project = resolve(config, "projects", "-Users-me-Twitching");
    const linked = "33333333-3333-4333-8333-333333333333";
    await symlink(resolve(project, `${A}.jsonl`), resolve(project, `${linked}.jsonl`));
    const ids = (await new ClaudeHistory((s) => s, config).list("")).conversations.map((c) => c.providerId);
    assert.ok(!ids.includes(linked));
    assert.deepEqual(
      (await new ClaudeHistory((s) => s, resolve(config, "missing")).list("")).conversations,
      [],
    );
  } finally {
    await rm(config, { recursive: true, force: true });
  }
});

test("Claude history skips compaction summaries and interrupt markers as prompts", async () => {
  const config = await mkdtemp(resolve(tmpdir(), "stram-claude-history-"));
  try {
    const project = resolve(config, "projects", "-Users-me-Twitching");
    await mkdir(project, { recursive: true });
    await writeFile(resolve(project, `${A}.jsonl`), [
      line({ type: "user", uuid: "c1", isCompactSummary: true, message: { content: "This session is being continued from a previous conversation" } }),
      line({ type: "user", uuid: "i1", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
      line({ type: "user", uuid: "p1", message: { content: "Real prompt" } }),
    ].join("\n"));
    const history = new ClaudeHistory((s) => s, config);
    assert.equal((await history.read(A)).title, "Real prompt");
    const prompts = (await history.page(A)).items.filter((i) => i.kind === "prompt");
    assert.deepEqual(prompts.map((p) => p.text), ["Real prompt"]);
  } finally {
    await rm(config, { recursive: true, force: true });
  }
});

test("Claude history paging never drops transcripts that share an mtime", async () => {
  const config = await mkdtemp(resolve(tmpdir(), "stram-claude-history-"));
  try {
    const project = resolve(config, "projects", "-Users-me-Twitching");
    await mkdir(project, { recursive: true });
    const ids = Array.from({ length: 31 }, (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`);
    for (const id of ids) {
      await writeFile(resolve(project, `${id}.jsonl`), line({ type: "user", uuid: "u", message: { content: id } }));
      await utimes(resolve(project, `${id}.jsonl`), new Date(5000), new Date(5000));
    }
    const history = new ClaudeHistory((s) => s, config);
    const first = await history.list("");
    assert.equal(first.conversations.length, 30);
    const second = await history.list("", first.before);
    const seen = [...first.conversations, ...second.conversations].map((c) => c.providerId);
    assert.equal(new Set(seen).size, 31);
    assert.equal(second.before, undefined);
  } finally {
    await rm(config, { recursive: true, force: true });
  }
});

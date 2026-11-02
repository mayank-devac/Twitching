import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { ActivityAdapter, commandName } from "../server/activity.js";
import { claude } from "../server/cli/claude.js";
import {
  CLAUDE_EXEC_PROFILE_ARGS,
  CLAUDE_NATIVE_PROFILE_JSON,
  CLAUDE_PROFILE_SETTINGS,
  CLAUDE_TOKEN_PATH,
  readClaudeToken,
} from "../server/claude-profile.js";
import {
  cliLoginCommand,
  cliStartupAdvice,
  failedLoginAgent,
} from "../server/cli-startup-repair.js";
import { Docker } from "../server/docker.js";
import { NativeHost } from "../server/native-host.js";
import { failureKind, redactor } from "../server/redact.js";
import { instructions } from "../server/runner.js";
import { Store } from "../server/store.js";
import type { Activity } from "../shared/types.js";

const TOKEN = "sk-ant-oat01-fixture-token-value-0000000000";
const session = { id: "session-1", cli: "claude" as const, model: "sonnet", effort: "high" };

function adapter(general = false) {
  const events: Activity[] = [];
  const activity = new ActivityAdapter(
    "claude",
    1,
    redactor([], "/private/root"),
    (e) => events.push(e),
    () => 1,
    "session-1",
    general,
  );
  return { events, activity };
}
const assistant = (block: object) => ({ type: "assistant", message: { content: [block] } });
const result = (id: string, is_error = false) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "PRIVATE OUTPUT", is_error }] },
});

test("Claude argv carries every isolation control and never the token", () => {
  const argv = claude.command(session, "Build a page");
  assert.deepEqual(argv.slice(0, 5), ["claude", "--print", "--output-format", "stream-json", "--verbose"]);
  assert.deepEqual(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 4), ["--model", "sonnet", "--effort", "high"]);
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "bypassPermissions");
  for (const arg of CLAUDE_EXEC_PROFILE_ARGS) assert.ok(argv.includes(arg), arg);
  assert.equal(argv[argv.indexOf("--setting-sources") + 1], "user");
  assert.equal(argv[argv.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  assert.deepEqual(JSON.parse(argv[argv.indexOf("--settings") + 1]!), CLAUDE_PROFILE_SETTINGS);
  assert.equal(argv.at(-1), "Build a page");
  assert.ok(!argv.some((arg) => arg.includes("sk-ant")));
  assert.ok(!claude.command({ ...session, effort: undefined }, "x").includes("--effort"));
});

test("Claude activity streams text, thinking and tool lanes but keeps tool output private", () => {
  const { events, activity } = adapter();
  activity.receive({ type: "system", subtype: "init", session_id: "PRIVATE_SESSION", mcp_servers: [], plugins: [] });
  activity.receive(assistant({ type: "thinking", thinking: "Plan the page" }));
  activity.receive(assistant({ type: "text", text: "Creating the page." }));
  activity.receive(assistant({ type: "tool_use", id: "w", name: "Write", input: { file_path: "/workspace/prompt_1.html", content: "<h1>Hi</h1>" } }));
  activity.receive(result("w"));
  activity.receive(assistant({ type: "tool_use", id: "r", name: "Read", input: { file_path: "/private/secret.txt" } }));
  activity.receive(result("r"));
  activity.receive(assistant({ type: "tool_use", id: "b", name: "Bash", input: { command: "ls -la" } }));
  activity.receive(result("b", true));
  activity.receive(assistant({ type: "tool_use", id: "t", name: "TodoWrite", input: { todos: [] } }));
  activity.receive({ type: "result", subtype: "success", is_error: false, result: "done" });

  const json = JSON.stringify(events);
  assert.ok(!json.includes("PRIVATE OUTPUT"));
  assert.ok(!json.includes("PRIVATE_SESSION"));
  assert.ok(!json.includes("/private/secret"));
  assert.equal(events[0]!.text, "Claude Code started; waiting for model output");
  assert.ok(events.some((e) => e.kind === "summary" && e.text === "Plan the page"));
  assert.ok(events.some((e) => e.kind === "message" && e.text === "Creating the page."));
  // The generated HTML page itself is shown, as with the other CLIs.
  assert.ok(events.some((e) => e.kind === "edit" && e.text === "<h1>Hi</h1>"));
  assert.ok(events.some((e) => e.lane === "write" && e.text === "prompt_1.html"));
  assert.ok(events.some((e) => e.lane === "read" && /secret\.txt/.test(e.text)));
  assert.ok(events.some((e) => e.lane === "terminal" && /failed ls -la/.test(e.text)));
  assert.ok(events.some((e) => e.lane === "tool" && e.text === "TodoWrite"));
  assert.ok(!events.some((e) => e.lane === "write" && /TodoWrite/.test(e.text)));
  assert.equal(activity.successful, true);
  assert.equal(activity.failure, undefined);
  assert.equal(events.at(-1)!.text, "Agent finished; checking HTML");
});

test("Claude web searches and fetches get their own rows, separate from tools and commands", () => {
  const { events, activity } = adapter();
  activity.receive(assistant({ type: "tool_use", id: "s", name: "WebSearch", input: { query: "squid allowlist docs" } }));
  activity.receive(result("s"));
  activity.receive(assistant({ type: "tool_use", id: "f", name: "WebFetch", input: { url: "https://code.claude.com/docs/en/hooks.md?token=PRIVATE#x", prompt: "PRIVATE PROMPT" } }));
  activity.receive(result("f", true));
  activity.receive(assistant({ type: "tool_use", id: "b", name: "Bash", input: { command: "ls" } }));

  const web = events.filter((e) => e.kind === "web").map((e) => e.text);
  assert.deepEqual(web, [
    "Searched the web: squid allowlist docs",
    "Fetched code.claude.com/docs/en/hooks.md",
    "Fetched code.claude.com/docs/en/hooks.md (failed)",
  ]);
  const json = JSON.stringify(events);
  assert.ok(!json.includes("PRIVATE"));
  assert.ok(!events.some((e) => e.kind === "tool" && !e.lane));
  assert.ok(events.some((e) => e.kind === "command" && !e.lane && e.text === "Running command: ls"));
});

test("command rows name each program in a chain, never its arguments", () => {
  const cases: [string, string][] = [
    ["grep -rn TOKEN .", "grep"],
    ["cd /private/src && npm test | tail -5", "npm test, tail"],
    ["FOO=secret python3 script.py", "python3"],
    ["sudo /usr/bin/cat /etc/hosts; git status", "cat, git status"],
    ["git --no-pager log", "git"],
    ["cat a | grep b | grep c", "cat, grep"],
    ["for f in *.ts; do wc -l $f; done", "wc"],
    ["a; b; c; d; e", "a, b, c, d, …"],
    ["./PRIVATE_value_that_is_far_too_long_for_a_program_name", "shell"],
    ["", "shell"],
  ];
  for (const [input, expected] of cases) assert.equal(commandName(input), expected, input);
});

test("Claude error results, auth retries and exposed MCP servers fail the run", () => {
  const failed = adapter();
  failed.activity.receive({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["Reached max turns"] });
  assert.equal(failed.activity.successful, false);
  assert.equal(failed.activity.failure, "Reached max turns");

  const retry = adapter();
  retry.activity.receive({ type: "system", subtype: "api_retry", error: "rate_limit", attempt: 1 });
  assert.equal(retry.activity.failure, undefined, "rate limits are retried by the CLI");
  retry.activity.receive({ type: "system", subtype: "api_retry", error: "authentication_failed", attempt: 2 });
  assert.equal(failureKind(retry.activity.failure!), "auth");
  const billing = adapter();
  billing.activity.receive({ type: "system", subtype: "api_retry", error: "billing_error" });
  assert.equal(failureKind(billing.activity.failure!), "usage");

  const exposed = adapter();
  exposed.activity.receive({ type: "system", subtype: "init", mcp_servers: [{ name: "x", status: "connected" }] });
  assert.match(exposed.activity.failure!, /MCP servers or plugins/);
});

test("Claude tokens are redacted and Claude auth errors classify as auth", () => {
  const clean = redactor([], "/private/root");
  assert.ok(!clean(`token ${TOKEN}`).includes("sk-ant"));
  assert.equal(failureKind("Not logged in · Please run /login"), "auth");
  assert.equal(failureKind("Invalid API key · Fix external API key"), "auth");
  assert.equal(failureKind("OAuth token has expired"), "auth");
  assert.equal(failureKind("Claude AI usage limit reached|1700000000"), "usage");
});

test("Claude login is read only from a regular token file", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-claude-token-"));
  try {
    assert.equal(await readClaudeToken(root), undefined);
    await mkdir(resolve(root, "runtime/auth/claude"), { recursive: true });
    await writeFile(resolve(root, CLAUDE_TOKEN_PATH), "not a token\n");
    assert.equal(await readClaudeToken(root), undefined);
    await writeFile(resolve(root, CLAUDE_TOKEN_PATH), `${TOKEN}\n`);
    assert.equal(await readClaudeToken(root), TOKEN);
    await rm(resolve(root, CLAUDE_TOKEN_PATH));
    const elsewhere = resolve(root, "elsewhere");
    await writeFile(elsewhere, TOKEN);
    await symlink(elsewhere, resolve(root, CLAUDE_TOKEN_PATH));
    await assert.rejects(readClaudeToken(root), /not a link/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Docker Claude workspace holds the managed profile and no credentials", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-claude-docker-"));
  const store = new Store(":memory:");
  try {
    await mkdir(resolve(root, "runtime/auth/claude"), { recursive: true });
    await writeFile(resolve(root, CLAUDE_TOKEN_PATH), TOKEN);
    const docker = new Docker(store, { root, image: "unused" });
    const dir = await docker.workspace({ cli: "claude", round: 1, session: "session-1" });
    const settings = await readFile(resolve(dir, ".home/.claude/settings.json"), "utf8");
    assert.deepEqual(JSON.parse(settings), CLAUDE_PROFILE_SETTINGS);
    assert.ok(!settings.includes("sk-ant"));
    // An agent edit to the profile is reset on the next launch.
    await writeFile(resolve(dir, ".home/.claude/settings.json"), '{"hooks":{}}');
    await docker.workspace({ cli: "claude", round: 1, session: "session-1" });
    assert.deepEqual(JSON.parse(await readFile(resolve(dir, ".home/.claude/settings.json"), "utf8")), CLAUDE_PROFILE_SETTINGS);
    await docker.retainAuth("claude", dir, { discardHome: true });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native Claude swaps to acceptEdits with the OS sandbox and a private config dir", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-claude-native-"));
  const store = new Store(":memory:");
  const previous = process.env.ARENA_NATIVE_APPROVED;
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ARENA_NATIVE_APPROVED = "1";
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-host-key-should-not-leak-000000";
  try {
    await mkdir(resolve(root, "runtime/auth/claude"), { recursive: true });
    await writeFile(resolve(root, CLAUDE_TOKEN_PATH), TOKEN);
    const host = new NativeHost(store, root);
    const prompt = instructions({ text: "Build a card game", author: "Host", platform: "fallback" }, 1);
    const created = await host.create("claude", 1, claude.command(session, prompt), undefined, "session-1");
    const entry = ((host as any).prepared as Map<string, { command: string[]; env: NodeJS.ProcessEnv }>).get(created.name)!;
    assert.equal(entry.command[entry.command.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.ok(!entry.command.includes("bypassPermissions"));
    assert.equal(entry.command[entry.command.indexOf("--settings") + 1], CLAUDE_NATIVE_PROFILE_JSON);
    assert.equal(JSON.parse(CLAUDE_NATIVE_PROFILE_JSON).sandbox.failIfUnavailable, true);
    assert.match(entry.command.at(-1)!, /\.\/prompt_1\.html/);
    assert.equal(entry.env.HOME, resolve(created.dir, ".cli-home"));
    assert.equal(entry.env.CLAUDE_CONFIG_DIR, resolve(created.dir, ".cli-home", ".claude"));
    assert.equal(entry.env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
    assert.equal(entry.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(entry.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.ok(!entry.command.some((arg) => arg.includes("sk-ant")));
    await host.stop(created.name);
  } finally {
    if (previous === undefined) delete process.env.ARENA_NATIVE_APPROVED;
    else process.env.ARENA_NATIVE_APPROVED = previous;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude login repair targets the saved token in both modes", () => {
  for (const mode of ["native", "docker"] as const)
    assert.deepEqual(cliLoginCommand("claude", mode), {
      program: "npm",
      args: ["run", "sandbox:login:claude"],
    });
  const advice = cliStartupAdvice(new Error("Claude Code arena login is missing; run npm run sandbox:login:claude"), "docker");
  assert.equal(advice.canRepair, true);
  assert.equal(advice.agent, "claude");
  assert.match(advice.instruction, /claude setup-token/);
  assert.doesNotMatch(advice.instruction, /Codex:/);
  assert.equal(
    failedLoginAgent(Object.assign(new Error("missing"), { code: "ENOENT", path: "/fixture/runtime/auth/claude/oauth-token" })),
    "claude",
  );
});

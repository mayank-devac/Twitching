import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Agent } from "../shared/types.js";
import { Docker } from "../server/docker.js";
import { CliRunner } from "../server/runner.js";

function fakeHost(agent: Agent, created: Agent[], output?: string) {
  return {
    executionBoundary: "docker",
    inspect: async (agents: Agent[]) => assert.deepEqual(agents, [agent]),
    capture: async (selected: Agent, args: string[]) => {
      assert.equal(selected, agent);
      if (args.includes("status")) return "Logged in";
      if (args.includes("--version")) return "2.1.302 (Claude Code)";
      if (args.includes("--list-models")) return "requested-cursor";
      return "--ignore-user-config --ignore-rules --disable --print --stream-partial-output --output-format --model --force " +
        "--verbose --effort --permission-mode --no-session-persistence --strict-mcp-config --mcp-config --setting-sources --settings --disallowedTools";
    },
    claudeToken: async () => {
      assert.equal(agent, "claude", "Other modes must not read the Claude login");
      return "sk-ant-oat01-fixture-token-value-000000";
    },
    codexInfo: async () => {
      assert.equal(agent, "codex", "Cursor mode must not query Codex");
      return {
        account: "chatgpt",
        models: [{ model: "requested-codex", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
        limits: { rateLimits: { primary: { windowDurationMins: 300, usedPercent: 10, resetsAt: 900000 } } },
      };
    },
    create: async (selected: Agent, _round: number, command: string[]) => {
      created.push(selected);
      assert.equal(selected, agent);
      assert.match(command.at(-1)!, /1920 by 1044/);
      return { name: selected, dir: "fixture" };
    },
    attach: (selected: Agent) => {
      assert.equal(selected, agent);
      // Mirror Docker.attach's piped stdio: CliRunner closes stdin so the CLI sees EOF.
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      });
      queueMicrotask(() => {
        child.stdout.write(output ?? JSON.stringify(agent === "codex"
          ? { type: "turn.completed" }
          : { type: "result", subtype: "success", is_error: false }) + "\n");
        child.emit("close", 0);
      });
      return child;
    },
    preserveOutput: async () => true,
    stop: async () => {},
    output: async () => {},
    retainAuth: async () => {},
    } as unknown as Docker;
}

for (const agent of ["codex", "cursor", "claude"] as const) {
  test(`${agent} mode checks and launches only the selected CLI`, async () => {
    const created: Agent[] = [];
    const host = fakeHost(agent, created);
    const runner = new CliRunner(host, {
      codexModel: "requested-codex", cursorModel: "requested-cursor",
      codexEffort: "high", singleAgent: agent,
    }, (text) => text);
    await runner.preflight();
    const handles = await runner.launch(1, {
      text: "Draw colourful waves", author: "Fixture", platform: "fallback",
    }, Date.now(), () => {});
    assert.deepEqual(created, [agent]);
    assert.deepEqual(Object.keys(handles), [agent]);
    const handle = handles[agent];
    assert.ok(handle);
    assert.equal((await handle.done).status, "complete");
  });
}

test("a run whose finish handler throws settles as a runner failure", async () => {
  // A trailing malformed line is parsed during finish(); a throwing activity
  // sink there must not leave `done` pending or reject unhandled.
  const runner = new CliRunner(fakeHost("codex", [], "not json"), {
    codexModel: "requested-codex", cursorModel: "requested-cursor",
    codexEffort: "high", singleAgent: "codex",
  }, (text) => text);
  const handles = await runner.launch(1, {
    text: "Draw colourful waves", author: "Fixture", platform: "fallback",
  }, Date.now(), (event) => {
    if (event.kind === "error") throw new Error("activity sink failed");
  });
  const outcome = await handles.codex!.done;
  assert.equal(outcome.status, "error");
  assert.equal(outcome.failure, "other");
});

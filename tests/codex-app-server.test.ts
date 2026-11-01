import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { CodexAppServerClient } from "../server/codex-app-server.js";

const messages = {
  rejected: "fixture rejected",
  closed: "fixture closed",
  timeout: (method: string) => `fixture ${method} timed out`,
  refused: "fixture refused",
};

// A fake app-server: `sent` collects client lines, `reply` writes server lines.
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: 0,
    kill() {
      child.killed++;
      queueMicrotask(() => child.emit("close", null));
      return true;
    },
  });
  const sent: any[] = [];
  child.stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean))
      sent.push(JSON.parse(line));
  });
  const reply = (message: unknown) => child.stdout.write(JSON.stringify(message) + "\n");
  return { child, sent, reply, process: child as unknown as ChildProcessWithoutNullStreams };
}
const tick = () => new Promise((r) => setImmediate(r));

test("app-server client handshakes, validates results and refuses server requests", async () => {
  const fake = fakeChild();
  const client = new CodexAppServerClient(fake.process, { messages });
  const ready = client.initialize({ name: "fixture", version: "1" });
  await tick();
  assert.deepEqual(fake.sent[0], {
    id: 0,
    method: "initialize",
    params: { clientInfo: { name: "fixture", version: "1" } },
  });
  fake.reply({ id: 0, result: {} });
  await ready;
  await tick();
  assert.deepEqual(fake.sent[1], { method: "initialized" });

  const call = client.call("model/list", {}, z.object({ data: z.array(z.string()) }));
  fake.reply({ id: 7, method: "item/tool/requestUserInput", params: {} });
  fake.reply({ id: 1, result: { data: ["a"], extra: true } });
  assert.deepEqual(await call, { data: ["a"] });
  await tick();
  assert.deepEqual(fake.sent[3], {
    id: 7,
    error: { code: -32601, message: "fixture refused" },
  });

  const rejected = client.call("x", {}, z.unknown());
  fake.reply({ id: 2, error: { message: "raw provider detail" } });
  await assert.rejects(rejected, { message: "fixture rejected" });

  const mismatch = client.call("thread/list", {}, z.object({ data: z.array(z.string()) }));
  fake.reply({ id: 3, result: { data: [1] } });
  await assert.rejects(mismatch, /unexpected thread\/list response/);
});

test("app-server client rejects pending calls on close and on an oversized line", async () => {
  const fake = fakeChild();
  let closed = 0;
  const client = new CodexAppServerClient(fake.process, {
    messages,
    maxLine: 64,
    onClose: () => closed++,
  });
  const pending = client.call("thread/read", {}, z.unknown());
  fake.child.stdout.write("x".repeat(65));
  await assert.rejects(pending, { message: "fixture closed" });
  assert.equal(fake.child.killed, 1);
  assert.equal(closed, 1);
  await assert.rejects(client.call("thread/read", {}, z.unknown()), {
    message: "fixture closed",
  });
});

test("app-server client times out a call and stops the process", async () => {
  const fake = fakeChild();
  const client = new CodexAppServerClient(fake.process, { messages, timeoutMs: 5 });
  await assert.rejects(client.call("account/read", {}, z.unknown()), {
    message: "fixture account/read timed out",
  });
  assert.equal(fake.child.killed, 1);
});

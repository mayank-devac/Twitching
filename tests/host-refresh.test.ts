import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { hostRefresh } from "../web/host-refresh.js";

test("bursts use one active request and one follow-up; stale sessions never apply", async () => {
  const requests: { signal: AbortSignal; resolve(value: number): void; reject(error: Error): void }[] = [];
  const applied: number[] = [];
  const refresh = hostRefresh((signal) => new Promise<number>((resolve, reject) => requests.push({ signal, resolve, reject })), (value) => applied.push(value), 0);
  try {
    for (let n = 0; n < 100; n++) refresh.request();
    assert.equal(requests.length, 1);
    requests[0].resolve(1);
    await settle();
    assert.equal(requests.length, 2);
    requests[1].resolve(2);
    await settle();
    assert.deepEqual(applied, [1, 2]);
    assert.equal(requests.length, 2);
    refresh.request();
    refresh.invalidate();
    refresh.request();
    assert.equal(requests[2].signal.aborted, true);
    requests[2].resolve(3); // Even a fetch implementation ignoring abort cannot apply old content.
    await settle();
    assert.deepEqual(applied, [1, 2]);
    requests[3].reject(new Error("Disconnected"));
    await settle();
    refresh.request();
    requests[4].resolve(4);
    await settle();
    assert.deepEqual(applied, [1, 2, 4]);
    refresh.request();
    refresh.close();
    requests[5].resolve(5);
    await settle();
    assert.deepEqual(applied, [1, 2, 4]);
  } finally { refresh.close(); }
});

test("continuous output cannot start host fetches faster than the minimum interval", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const requests: ((value: number) => void)[] = [];
  const refresh = hostRefresh(() => new Promise<number>((resolve) => requests.push(resolve)), () => {});
  try {
    refresh.request();
    refresh.request();
    requests[0](1);
    await settle();
    assert.equal(requests.length, 1);
    t.mock.timers.tick(749);
    assert.equal(requests.length, 1);
    t.mock.timers.tick(1);
    assert.equal(requests.length, 2);
    refresh.request();
    requests[1](2);
    await settle();
    t.mock.timers.tick(750);
    assert.equal(requests.length, 3);
    requests[2](3);
    await settle();
  } finally { refresh.close(); }
});

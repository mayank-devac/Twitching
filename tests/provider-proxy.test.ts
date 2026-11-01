import test from "node:test";
import assert from "node:assert/strict";
import {
  assertProviderProxy,
  providerProxyInstruction,
  providerProxyState,
} from "../server/provider-proxy.js";

test("provider proxy is ready only on an internal network with egress running", () => {
  assert.equal(providerProxyState("true", true), "ready");
  assert.equal(providerProxyState("true", false), "down");
  assert.equal(providerProxyState(undefined, false), "down");
  assert.equal(providerProxyState("false", true), "open");
  assert.equal(providerProxyInstruction("ready"), "");
  assert.match(providerProxyInstruction("down"), /sandbox\/compose\.yml up -d/);
  assert.match(providerProxyInstruction("open"), /not an internal network/);
});

test("assertProviderProxy awaits docker answers and keeps the repair messages", async () => {
  const docker = (answers: Record<string, string | Error>) => async (args: string[]) => {
    const answer = answers[args[0]!];
    if (answer instanceof Error || answer === undefined) throw answer ?? new Error("no docker");
    return answer;
  };
  await assertProviderProxy("/tmp", docker({ network: "true", compose: "abc\n", inspect: "true" }));
  await assert.rejects(
    assertProviderProxy("/tmp", docker({ network: "false" })),
    /not an internal network/,
  );
  await assert.rejects(
    assertProviderProxy("/tmp", docker({ network: new Error("missing") })),
    /sandbox\/compose\.yml up -d/,
  );
  await assert.rejects(
    assertProviderProxy("/tmp", docker({ network: "true", compose: "" })),
    /provider proxy is not running/,
  );
});

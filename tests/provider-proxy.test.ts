import test from "node:test";
import assert from "node:assert/strict";
import {
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

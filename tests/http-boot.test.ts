import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { makeHttp } from "../server/http.js";
import type { Controller } from "../server/controller.js";
import { bootIdentitySchema } from "../shared/boot.js";

async function freePort() {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

test("/api/boot returns the shared boot identity, or {} before it is known", async () => {
  const boot = { rootId: "root", configurationId: "config", startedAt: 1700000000000 };
  for (const identity of [boot, undefined]) {
    const port = await freePort();
    const http = makeHttp(new EventEmitter() as unknown as Controller, {
      host: "127.0.0.1", port, previewOrigin: "http://127.0.0.1:1", root: "/nonexistent", musicPath: "/nonexistent.mp3", boot: identity,
    });
    await new Promise<void>((r) => http.server.listen(port, "127.0.0.1", r));
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/api/boot`)).json();
      assert.deepEqual(body, identity ?? {});
      if (identity) assert.deepEqual(bootIdentitySchema.strict().parse(body), boot);
    } finally {
      await http.close();
    }
  }
});

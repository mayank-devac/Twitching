import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { makeHttp } from "../server/http.js";
import type { Controller } from "../server/controller.js";
// makeHttp fixes its allowed Origin from options.port before listening, so it
// cannot bind port 0 directly; ask the OS for a free port (port 0) and reuse it.
async function freePort() {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}
test("overlay reconnect returns current state/events without launching a job, and controls reject cross-origin requests", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-http-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let starts = 0;
  let activityText = "Existing activity";
  const controller = Object.assign(new EventEmitter(), {
    snapshot: () => ({
      status: "running",
      events: [{ id: "saved", text: activityText }],
      round: { id: 4 },
    }),
    hostSnapshot: () => ({
      status: "running",
      events: [
        { id: "saved", text: activityText },
        { id: "cmd", text: "rg --files secret", lane: "terminal" },
      ],
      round: { id: 4 },
    }),
    start: async () => {
      starts++;
    },
  }) as unknown as Controller;
  const http = makeHttp(controller, {
    host: "127.0.0.1",
    port,
    previewOrigin: "http://127.0.0.1:39211",
    root,
    musicPath: resolve(root, "missing.mp3"),
  });
  await new Promise<void>((r) => http.server.listen(port, "127.0.0.1", r));
  try {
    for (let i = 0; i < 2; i++) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/events`, {
        origin,
      });
      const [bytes] = await once(socket, "message");
      const data = JSON.parse(bytes.toString());
      assert.equal(data.state.round.id, 4);
      assert.equal(data.state.events[0].id, "saved");
      assert.equal(data.state.events[0].text, activityText);
      if (i === 0) {
        const update = once(socket, "message");
        activityText += " more text";
        controller.emit("state");
        const [updatedBytes] = await update;
        const updated = JSON.parse(updatedBytes.toString());
        assert.equal(updated.type, "update");
        assert.equal(updated.patches[0].event.text, " more text");
        assert.equal(updated.patches[0].prefixLength, "Existing activity".length);
        assert.deepEqual(updated.eventIds, ["saved"]);
      }
      socket.close();
      await once(socket, "close");
    }
    assert.equal(starts, 0);
    const cross = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: {
        Origin: "https://example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "start" }),
    });
    assert.equal(cross.status, 403);
    const host = await fetch(`${origin}/api/host`);
    const { csrf } = (await host.json()) as any;
    const cookie = host.headers.get("set-cookie")!.split(";")[0];
    const accepted = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Host-Token": csrf,
        Cookie: cookie,
      },
      body: JSON.stringify({ action: "start" }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(starts, 1);
    const lanes = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/host-state",
            method: "GET",
            headers: { "X-Host-Token": csrf, Cookie: cookie },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    assert.equal(lanes.status, 200);
    assert.match(lanes.body, /rg --files secret/);
    const crossSite = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/host-state",
          method: "GET",
          headers: {
            "X-Host-Token": csrf,
            Cookie: cookie,
            "Sec-Fetch-Site": "cross-site",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(crossSite, 403);
    const publicLanes = await fetch(`${origin}/api/host-state`);
    assert.equal(publicLanes.status, 403);
    assert.equal(
      (await fetch(`${origin}/.env.local`)).status,
      404,
    );
    assert.equal(
      (await fetch(`${origin}/runtime/show.sqlite`)).status,
      404,
    );
  } finally {
    await http.close();
    await rm(root, { recursive: true, force: true });
  }
});

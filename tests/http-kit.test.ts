import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { z } from "zod";
import { hostCheck, hostOnly, HttpError, routeAction, routeError } from "../server/http-kit.js";

async function serve(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("hostOnly rejects a missing or wrong token and accepts the matching cookie and header", async () => {
  const csrf = "a".repeat(64);
  const origin = "http://127.0.0.1:1";
  const app = express();
  const guard = hostOnly(hostCheck(csrf, origin));
  app.get("/api/x", guard("Use local host controls"), (_req, res) => res.json({ ok: true }));
  app.post("/api/x", guard("Use local host controls"), (_req, res) => res.json({ ok: true }));
  const { base, close } = await serve(app);
  const call = async (method: string, headers: Record<string, string>) => {
    const res = await fetch(`${base}/api/x`, { method, headers });
    return { status: res.status, body: await res.json() };
  };
  const cookie = `other=1; arena_host=${csrf}`;
  try {
    const denied = { status: 403, body: { error: "Use local host controls" } };
    assert.deepEqual(await call("GET", {}), denied);
    assert.deepEqual(await call("GET", { cookie }), denied, "cookie without header");
    assert.deepEqual(await call("GET", { "x-host-token": csrf }), denied, "header without cookie");
    assert.deepEqual(await call("GET", { cookie, "x-host-token": "b".repeat(64) }), denied, "wrong token");
    assert.deepEqual(await call("GET", { cookie, "x-host-token": "short" }), denied, "wrong length");
    assert.deepEqual(await call("GET", { cookie: "arena_host=x", "x-host-token": csrf }), denied, "wrong cookie");
    assert.deepEqual(await call("GET", { cookie, "x-host-token": csrf, "sec-fetch-site": "cross-site" }), denied);
    // A POST must carry the expected Origin; an absent one is not enough.
    assert.deepEqual(await call("POST", { cookie, "x-host-token": csrf }), denied);

    const ok = { status: 200, body: { ok: true } };
    assert.deepEqual(await call("GET", { cookie, "x-host-token": csrf }), ok);
    assert.deepEqual(await call("GET", { cookie, "x-host-token": csrf, "sec-fetch-site": "same-origin" }), ok);
    assert.deepEqual(await call("POST", { cookie, "x-host-token": csrf, origin }), ok);
  } finally {
    await close();
  }
  // Origin checks are exact, independent of the transport above.
  const check = hostCheck(csrf, origin);
  const req = (headers: Record<string, string>, method = "POST") =>
    ({ headers: { cookie, "x-host-token": csrf, ...headers }, method }) as unknown as express.Request;
  assert.equal(check(req({ origin: "http://evil.test" })), false);
  assert.equal(check(req({ origin })), true);
});

test("routeError maps known errors and keeps unknown failures generic", () => {
  const zod = (() => { try { z.string().parse(1); } catch (error) { return error; } })();
  const errors = { invalid: "Invalid request", failed: "Request failed" };
  assert.deepEqual(routeError(new HttpError(400, "Unsupported CLI"), { ...errors, status: 409 }), { status: 400, message: "Unsupported CLI" });
  // Schema details never reach the client.
  assert.deepEqual(routeError(zod, errors), { status: 400, message: "Invalid request" });
  assert.deepEqual(routeError(zod, { failed: "Request failed" }), { status: 400, message: "Request failed" });
  assert.deepEqual(routeError(new Error("Reload settings"), errors), { status: 409, message: "Reload settings" });
  assert.deepEqual(routeError("boom", errors), { status: 500, message: "Request failed" });
  assert.deepEqual(routeError(new Error("/secret/path EACCES"), { ...errors, expose: () => false }), { status: 500, message: "Request failed" });
  // A route that answers one status keeps it for every failure kind.
  for (const error of [zod, new Error("x"), "boom"])
    assert.equal(routeError(error, { ...errors, status: 409 }).status, 409);
});

test("routeAction sends the result or the mapped error as JSON", async () => {
  const app = express();
  app.get("/ok", routeAction(async () => ({ ok: true }), { failed: "Request failed" }));
  app.get("/http", routeAction(() => { throw new HttpError(400, "Invalid runner"); }, { status: 409, failed: "Request failed" }));
  app.get("/zod", routeAction((req) => z.object({ id: z.string() }).parse(req.query), { status: 409, invalid: "Invalid session request", failed: "Session request failed" }));
  app.get("/hidden", routeAction(async () => { throw new Error("EACCES /private"); }, { status: 400, expose: (e) => e.message.startsWith("Use "), failed: "Upload failed" }));
  app.get("/unknown", routeAction(async () => { throw 7; }, { failed: "Request failed" }));
  const { base, close } = await serve(app);
  const get = async (path: string) => { const res = await fetch(base + path); return [res.status, await res.json()]; };
  try {
    assert.deepEqual(await get("/ok"), [200, { ok: true }]);
    assert.deepEqual(await get("/http"), [400, { error: "Invalid runner" }]);
    assert.deepEqual(await get("/zod"), [409, { error: "Invalid session request" }]);
    assert.deepEqual(await get("/zod?id=a"), [200, { id: "a" }]);
    assert.deepEqual(await get("/hidden"), [400, { error: "Upload failed" }]);
    assert.deepEqual(await get("/unknown"), [500, { error: "Request failed" }]);
  } finally {
    await close();
  }
});

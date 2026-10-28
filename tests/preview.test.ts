import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { chromium, type Browser } from "playwright";
import { Previews, sanitizeHtml } from "../server/preview.js";
import { credentialGuard } from "../server/redact.js";
test("removes frames, refresh redirects, external attributes and form destinations", () => {
  const result = sanitizeHtml(
    '<meta http-equiv="refresh" content="0;url=https://example.com"><iframe src="http://localhost:3210/control"></iframe><form action="https://example.com"><img src="https://example.com/x"><a href="https://example.com">Hi</a></form>',
  );
  assert.ok(!result.includes("example.com"));
  assert.ok(!result.includes("iframe"));
  assert.ok(!result.includes("http-equiv"));
});
test("real browser validates isolated HTML, serves it live with CSP, and blocks web requests", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-preview-"));
  await mkdir(resolve(root, "main/codex"), { recursive: true });
  const html = `<!doctype html><html><body style="background:#eee"><h1>Private generated code</h1><button style="width:200px;height:80px" onclick="location.hash='clicked';this.innerText=secret">Play</button><script>const secret='blue';const password='rainbow';const authorization='demo';fetch('http://127.0.0.1:39210/control').catch(()=>{});fetch('https://example.com/steal').catch(()=>{});new Image().src='https://example.com/tracker';</script></body></html>`;
  await writeFile(resolve(root, "main/codex/prompt_1.html"), html);
  let renderingBrowser: Browser | undefined;
  let viewerBrowser: Browser | undefined;
  const previews = new Previews(
    root,
    "http://127.0.0.1:39211",
    resolve(root, "missing.html"),
    async () =>
      (renderingBrowser ??= await chromium.launch({ headless: true })),
    credentialGuard(["private-test-credential-value"]),
    "live",
  );
  const previewServer = previews.app().listen(39211, "127.0.0.1");
  let controlReads = 0;
  const server = createServer((req, res) => {
    if (req.url === "/control") {
      controlReads++;
      res.end("private");
      return;
    }
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-src http://127.0.0.1:39211",
    );
    res.end(
      '<h1 id="host">Host safe</h1><iframe sandbox="allow-scripts" src="http://127.0.0.1:39211/page/codex/1"></iframe>',
    );
  });
  await new Promise<void>((r) => server.listen(39210, "127.0.0.1", r));
  try {
    await previews.ready();
    const url = await previews.validate("codex", 1);
    const response = await fetch(url);
    const viewer = await response.text();
    assert.equal(
      await readFile(resolve(root, "main/codex/prompt_1.html"), "utf8"),
      html,
    );
    assert.equal(viewer, html);
    assert.ok(
      response.headers.get("content-security-policy")?.includes("connect-src 'none'"),
    );
    viewerBrowser = await chromium.launch({ headless: true });
    const page = await viewerBrowser.newPage();
    const outgoing: string[] = [];
    await page.route("**/*", (route) => {
      const u = route.request().url();
      if (
        !u.startsWith("http://127.0.0.1:39210/") &&
        !u.startsWith("http://127.0.0.1:39211/")
      ) {
        outgoing.push(u);
        return route.abort();
      }
      return route.continue();
    });
    await page.goto("http://127.0.0.1:39210/");
    await page.waitForTimeout(400);
    assert.equal(await page.locator("#host").innerText(), "Host safe");
    assert.equal(controlReads, 0);
    assert.deepEqual(outgoing, []);
    const frame = page.frames().find((f) => f.url().includes("/page/codex/1"));
    assert.ok(frame);
    assert.equal(await frame.locator("h1").innerText(), "Private generated code");
    await writeFile(
      resolve(root, "main/codex/prompt_2.html"),
      '<html><body><button>Broken</button><script>throw new Error("broken")</script></body></html>',
    );
    await assert.rejects(() => previews.validate("codex", 2));
    await assert.rejects(() => previews.validate("codex", 3));
    await writeFile(
      resolve(root, "main/codex/prompt_4.html"),
      '<html><body><h1>Navigate</h1><script>location.href="https://example.com"</script></body></html>',
    );
    await assert.rejects(() => previews.validate("codex", 4));
    assert.equal(controlReads, 0);
    const unsafe =
      "<html><body><p>private-test-credential-value</p></body></html>";
    await writeFile(resolve(root, "main/codex/prompt_5.html"), unsafe);
    await assert.rejects(
      () => previews.validate("codex", 5),
      /contains credentials/,
    );
    assert.equal(
      await readFile(resolve(root, "main/codex/prompt_5.html"), "utf8"),
      unsafe,
    );
    assert.equal(
      (await fetch("http://127.0.0.1:39211/page/codex/5")).status,
      404,
    );
  } finally {
    await viewerBrowser?.close();
    await previews.close();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => previewServer.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
test("jpeg preview serves only trusted pixels and accepts forwarded input", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-preview-jpeg-"));
  await mkdir(resolve(root, "main/codex"), { recursive: true });
  const html = `<!doctype html><html><body style="background:#eee"><h1>Private generated code</h1><button style="width:200px;height:80px" onclick="location.hash='clicked';this.innerText=secret">Play</button><script>const secret='blue';const password='rainbow';const authorization='demo';fetch('http://127.0.0.1:39220/control').catch(()=>{});</script></body></html>`;
  await writeFile(resolve(root, "main/codex/prompt_1.html"), html);
  let renderingBrowser: Browser | undefined;
  const previews = new Previews(
    root,
    "http://127.0.0.1:39221",
    resolve(root, "missing.html"),
    async () =>
      (renderingBrowser ??= await chromium.launch({ headless: true })),
    credentialGuard(["private-test-credential-value"]),
    "jpeg",
  );
  const previewServer = previews.app().listen(39221, "127.0.0.1");
  try {
    await previews.ready();
    const url = await previews.validate("codex", 1);
    const viewer = await (await fetch(url)).text();
    assert.ok(!viewer.includes("Private generated code"));
    const token = viewer.match(/token="([a-f0-9]+)"/)?.[1];
    assert.ok(token);
    const before = Buffer.from(
      await (await fetch(`http://127.0.0.1:39221/frame/${token}`)).arrayBuffer(),
    );
    assert.equal(before[0], 255);
    assert.equal(before[1], 216);
    const input = await fetch(`http://127.0.0.1:39221/input/${token}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ type: "click", x: 100, y: 100 }),
    });
    assert.equal(input.status, 204);
  } finally {
    await previews.close();
    await new Promise<void>((r) => previewServer.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});

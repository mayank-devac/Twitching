import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { Previews, sanitizeHtml } from "../server/preview.js";
import { credentialGuard } from "../server/redact.js";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

// Prefer an explicit executable, then Playwright's full Chrome, then an existing
// macOS Chrome for Testing installation. Browser profiles are never reused.
function testBrowserPath() {
  if (process.env.ARENA_TEST_BROWSER_PATH)
    return process.env.ARENA_TEST_BROWSER_PATH;
  let bundled = "";
  try { bundled = chromium.executablePath(); } catch { /* not installed */ }
  if (bundled && existsSync(bundled)) return bundled;
  if (process.platform !== "darwin") return undefined;
  const cache = resolve(homedir(), ".omp/puppeteer/chrome");
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache).sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }),
  );
  return builds.map((build) => resolve(
    cache, build, `chrome-mac-${process.arch === "arm64" ? "arm64" : "x64"}`,
    "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  )).find((path) => existsSync(path));
}
const browserPath = testBrowserPath();
// Machines without a browser skip the real-browser tests instead of failing.
const browserSkip = browserPath
  ? false
  : "no supported browser found; run `npx playwright install chromium` or set ARENA_TEST_BROWSER_PATH";
// Port 0 lets the OS pick a free port, so parallel runs and local services never collide.
async function listenFree(server: Server) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}
const launchBrowser = () => chromium.launch({
  headless: true,
  executablePath: browserPath,
});
test("removes frames, refresh redirects, external attributes and form destinations", () => {
  const result = sanitizeHtml(
    '<meta http-equiv="refresh" content="0;url=https://example.com"><iframe src="http://localhost:3210/control"></iframe><form action="https://example.com"><img src="https://example.com/x"><a href="https://example.com">Hi</a></form>',
  );
  assert.ok(!result.includes("example.com"));
  assert.ok(!result.includes("iframe"));
  assert.ok(!result.includes("http-equiv"));
});
test("real browser validates isolated HTML, serves it live with CSP, and blocks web requests", { skip: browserSkip }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-preview-"));
  await mkdir(resolve(root, "main/codex"), { recursive: true });
  // Previews reads its origin per request, so bind first and build it with the real port.
  const previewServer = createServer();
  const previewOrigin = `http://127.0.0.1:${await listenFree(previewServer)}`;
  let controlReads = 0;
  const server = createServer((req, res) => {
    if (req.url === "/control") {
      controlReads++;
      res.end("private");
      return;
    }
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; frame-src ${previewOrigin}`,
    );
    res.end(
      `<h1 id="host">Host safe</h1><iframe sandbox="allow-scripts" src="${previewOrigin}/page/codex/1"></iframe>`,
    );
  });
  const controlOrigin = `http://127.0.0.1:${await listenFree(server)}`;
  const html = `<!doctype html><html><body style="background:#eee"><h1>Private generated code</h1><button style="width:200px;height:80px" onclick="location.hash='clicked';this.innerText=secret">Play</button><script>const secret='blue';const password='rainbow';const authorization='demo';fetch('${controlOrigin}/control').catch(()=>{});fetch('https://example.com/steal').catch(()=>{});new Image().src='https://example.com/tracker';</script></body></html>`;
  await writeFile(resolve(root, "main/codex/prompt_1.html"), html);
  let renderingBrowser: Browser | undefined;
  let viewerBrowser: Browser | undefined;
  const renderingPages = () => {
    if (!renderingBrowser) throw new Error("Renderer was not started");
    return renderingBrowser.contexts().flatMap((context) => context.pages());
  };
  const previews = new Previews(
    root,
    previewOrigin,
    resolve(root, "missing.html"),
    async () =>
      (renderingBrowser ??= await launchBrowser()),
    credentialGuard(["private-test-credential-value"]),
    "live",
  );
  previewServer.on("request", previews.app());
  try {
    await previews.ready();
    const url = await previews.validate("codex", 1, 2);
    assert.deepEqual(renderingPages()[0]!.viewportSize(), { width: 960, height: 1044 });
    await previews.validate("codex", 1, 1);
    assert.deepEqual(renderingPages()[0]!.viewportSize(), { width: 1920, height: 1044 });
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
    viewerBrowser = await launchBrowser();
    const page = await viewerBrowser.newPage();
    const outgoing: string[] = [];
    await page.route("**/*", (route) => {
      const u = route.request().url();
      if (
        !u.startsWith(`${controlOrigin}/`) &&
        !u.startsWith(`${previewOrigin}/`)
      ) {
        outgoing.push(u);
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(`${controlOrigin}/`);
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
    await assert.rejects(() => previews.validate("codex", 2, 2));
    await assert.rejects(() => previews.validate("codex", 3, 2));
    await writeFile(
      resolve(root, "main/codex/prompt_4.html"),
      '<html><body><h1>Navigate</h1><script>location.href="https://example.com"</script></body></html>',
    );
    await assert.rejects(() => previews.validate("codex", 4, 2));
    assert.equal(controlReads, 0);
    const unsafe =
      "<html><body><p>private-test-credential-value</p></body></html>";
    await writeFile(resolve(root, "main/codex/prompt_5.html"), unsafe);
    await assert.rejects(
      () => previews.validate("codex", 5, 2),
      /contains credentials/,
    );
    assert.equal(
      await readFile(resolve(root, "main/codex/prompt_5.html"), "utf8"),
      unsafe,
    );
    assert.equal(
      (await fetch(`${previewOrigin}/page/codex/5`)).status,
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
test("jpeg preview serves only trusted pixels and accepts forwarded input", { skip: browserSkip }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-preview-jpeg-"));
  const previewServer = createServer();
  const previewOrigin = `http://127.0.0.1:${await listenFree(previewServer)}`;
  await mkdir(resolve(root, "main/codex"), { recursive: true });
  const html = `<!doctype html><html><body style="background:#eee"><h1>Private generated code</h1><button style="width:200px;height:80px" onclick="location.hash='clicked';this.innerText=secret">Play</button><script>const secret='blue';const password='rainbow';const authorization='demo';fetch('http://127.0.0.1:39220/control').catch(()=>{});</script></body></html>`;
  await writeFile(resolve(root, "main/codex/prompt_1.html"), html);
  let renderingBrowser: Browser | undefined;
  const previews = new Previews(
    root,
    previewOrigin,
    resolve(root, "missing.html"),
    async () =>
      (renderingBrowser ??= await launchBrowser()),
    credentialGuard(["private-test-credential-value"]),
    "jpeg",
  );
  previewServer.on("request", previews.app());
  try {
    await previews.ready();
    const url = await previews.validate("codex", 1, 2);
    const viewer = await (await fetch(url)).text();
    assert.ok(!viewer.includes("Private generated code"));
    const token = viewer.match(/token="([a-f0-9]+)"/)?.[1];
    assert.ok(token);
    const before = Buffer.from(
      await (await fetch(`${previewOrigin}/frame/${token}`)).arrayBuffer(),
    );
    assert.equal(before[0], 255);
    assert.equal(before[1], 216);
    const input = await fetch(`${previewOrigin}/input/${token}`, {
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

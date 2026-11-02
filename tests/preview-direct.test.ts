import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Previews } from "../server/preview.js";
import { assessPage, HeavyPageError, withWatchdog } from "../server/preview-heavy.js";

test("an endless loop with no way out is refused, a loop that can break is allowed", () => {
  assert.match(
    assessPage("<body><script>while(true){x++}</script></body>").block ?? "",
    /endless loop/,
  );
  assert.match(assessPage("<script>for(;;){draw()}</script>").block ?? "", /endless loop/);
  assert.equal(assessPage("<script>while(true){if(done)break;step()}</script>").block, undefined);
  assert.equal(
    assessPage("<script>async function run(){while(true){await frame()}}</script>").block,
    undefined,
  );
});

test("big or heavy pages warn without blocking", () => {
  const large = `<body>${"<p>x</p>".repeat(60_000)}</body>`;
  const found = assessPage(large);
  assert.equal(found.block, undefined);
  assert.match(found.warning ?? "", /large/);
  assert.match(found.warning ?? "", /thousands of elements/);
  assert.match(assessPage("<script>for(let i=0;i<1e9;i++){}</script>").warning ?? "", /very long loop/);
  assert.match(assessPage('<canvas width="20000" height="20"></canvas>').warning ?? "", /large canvas/);
  assert.deepEqual(assessPage("<body><canvas width=300></canvas></body>"), {});
});

test("the heartbeat goes in first, whatever shape the document has", () => {
  assert.match(withWatchdog("<html><head><title>t</title></head></html>"), /<head><script>[^]*<\/script><title>/);
  assert.match(withWatchdog("<html><body></body></html>"), /<html><script>/);
  assert.ok(withWatchdog("<div></div>").startsWith("<script>"));
});

test("direct preview serves a page without any browser and reports a warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "direct-preview-"));
  try {
    await mkdir(join(root, "main/codex"), { recursive: true });
    const previews = new Previews(
      root,
      "http://127.0.0.1:3299",
      join(root, "none.html"),
      async () => {
        throw new Error("direct preview must not start a browser");
      },
    );
    previews.direct = () => true;
    await previews.ready();

    await writeFile(join(root, "main/codex/prompt_1.html"), `<html><body><div>${"<p>hi</p>".repeat(6000)}</div></body></html>`);
    const url = await previews.validate("codex", 1, 1);
    assert.equal(url, "http://127.0.0.1:3299/page/codex/1");
    assert.match(previews.warning("codex") ?? "", /Heavy page/);

    await writeFile(join(root, "main/codex/prompt_2.html"), "<html><body><div>ok</div><script>while(true){}</script></body></html>");
    await assert.rejects(previews.validate("codex", 2, 1), HeavyPageError);
    await previews.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

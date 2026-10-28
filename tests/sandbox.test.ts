import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store.js";
import { Docker } from "../server/docker.js";
import { BrowserSandbox } from "../server/browser-sandbox.js";
test(
  "real Docker boundaries: only workspace writes; preview cannot reach external IP or DNS",
  { skip: process.env.STRAM_SANDBOX_TEST !== "1" },
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "stram-isolation-"));
    const store = new Store(":memory:");
    const docker = new Docker(store, {
      root,
      image: "prompt-arena-agent:local",
    });
    const browser = new BrowserSandbox(
      docker,
      root,
      "prompt-arena-preview:local",
      39213,
    );
    try {
      await docker.inspect();
      const dir = await docker.workspace({ cli: "codex", round: "isolation", auth: false });
      await mkdir(resolve(dir, ".home"), { recursive: true });
      const created = await docker.create(
        "codex",
        "isolation",
        [
          "node",
          "-e",
          "const fs=require('fs');fs.writeFileSync('/workspace/proof.txt','ok');try{fs.writeFileSync('/etc/proof.txt','bad');process.exit(5)}catch{console.log('workspace-only')}",
        ],
        dir,
      );
      const out = await docker.command(["start", "-a", created.name]);
      assert.match(out, /workspace-only/);
      await docker.stop(created.name);
      const connected = await browser.start();
      const page = await connected.newPage();
      await page.setContent("<html><body><h1>Preview connected</h1></body></html>");
      assert.equal(await page.locator("h1").textContent(), "Preview connected");
      assert.ok((await page.screenshot()).length > 0);
      await page.close();
      const name = (browser as any).name;
      const ports = await docker.command([
        "inspect", "--format", "{{json .HostConfig.PortBindings}}", name,
      ]);
      assert.ok(["null", "{}"].includes(ports.trim()));
      const network = await docker.command([
        "exec",
        name,
        "node",
        "-e",
        "Promise.all(['http://1.1.1.1','https://example.com'].map(async u=>{try{await fetch(u,{signal:AbortSignal.timeout(1500)});process.exitCode=5}catch{console.log('blocked')}}))",
      ]);
      assert.equal((network.match(/blocked/g) ?? []).length, 2);
    } finally {
      await browser.close().catch(() => {});
      await docker.recover();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

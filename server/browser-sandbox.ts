import { randomBytes, createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { chromium, type Browser } from "playwright";
import {
  PREVIEW_BROWSER_LIMITS,
  PREVIEW_CDP_PORT,
  PREVIEW_NETWORK,
} from "./constants.js";
import type { Docker } from "./docker.js";
export class BrowserSandbox {
  private name: string;
  private browser?: Browser;
  private relay?: Server;
  private sockets = new Set<Socket>();
  private connections = new Set<ChildProcessWithoutNullStreams>();
  constructor(
    private docker: Docker,
    root: string,
    private image: string,
    private port: number,
  ) {
    this.name = `stram-preview-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
  }
  async recover() {
    for (const socket of this.sockets) socket.destroy();
    for (const child of this.connections) child.kill();
    if (this.relay) {
      const relay = this.relay;
      this.relay = undefined;
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
    await this.docker.stop(this.name);
  }
  private async openRelay() {
    // Docker may not publish ports on internal networks. Forward the browser
    // protocol through exec's stdin/stdout without giving Chromium another network.
    const script = `
      const socket = require('node:net').connect(${PREVIEW_CDP_PORT}, '127.0.0.1');
      socket.on('connect', () => { process.stdin.pipe(socket); socket.pipe(process.stdout); });
      socket.on('error', () => process.exit(1));
      socket.on('close', () => process.exit(0));
      process.stdin.on('end', () => socket.end());
    `;
    const relay = createServer((socket) => {
      this.sockets.add(socket);
      const child = spawn("docker", ["exec", "-i", this.name, "node", "-e", script], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.connections.add(child);
      child.stderr.resume();
      child.stdin.on("error", () => socket.destroy());
      child.once("error", () => socket.destroy());
      child.once("close", () => {
        this.connections.delete(child);
        socket.destroy();
      });
      socket.on("error", () => child.kill());
      socket.once("close", () => {
        this.sockets.delete(socket);
        child.kill();
      });
      socket.pipe(child.stdin);
      child.stdout.pipe(socket);
    });
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(this.port, "127.0.0.1", () => {
        relay.removeListener("error", reject);
        resolve();
      });
    });
    this.relay = relay;
  }
  async start() {
    if (this.browser?.isConnected()) return this.browser;
    await this.docker.command(["image", "inspect", this.image]);
    const internal = (
      await this.docker.command([
        "network",
        "inspect",
        PREVIEW_NETWORK,
        "--format",
        "{{.Internal}}",
      ])
    ).trim();
    if (internal !== "true")
      throw new Error(
        "Preview browser requires its own internal Docker network",
      );
    await this.recover();
    const token = randomBytes(24).toString("hex");
    await this.docker.command([
      "run",
      "-d",
      "--name",
      this.name,
      "--init",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      `--pids-limit=${PREVIEW_BROWSER_LIMITS.pids}`,
      `--memory=${PREVIEW_BROWSER_LIMITS.memory}`,
      `--cpus=${PREVIEW_BROWSER_LIMITS.cpus}`,
      `--user=${PREVIEW_BROWSER_LIMITS.user}`,
      `--network=${PREVIEW_NETWORK}`,
      "--dns=127.0.0.1",
      `--shm-size=${PREVIEW_BROWSER_LIMITS.shm}`,
      "--tmpfs",
      "/tmp:uid=1000,gid=1000,mode=1777",
      "-e",
      `PREVIEW_WS_PATH=${token}`,
      this.image,
    ]);
    try {
      await this.openRelay();
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        try {
          // Do not set exposeNetwork: generated pages must never inherit host networking.
          this.browser = await chromium.connect(
            `ws://127.0.0.1:${this.port}/${token}`,
            { timeout: Math.min(3000, Math.max(1, until - Date.now())) },
          );
          return this.browser;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      throw new Error("Preview browser connection timed out");
    } catch {
      await this.recover();
      throw new Error("Isolated preview browser failed to start");
    }
  }
  async close() {
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
    await this.recover();
  }
}

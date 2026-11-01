import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, cp, lstat, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { Agent, SessionId } from "../shared/types.js";
import { writeFileAtomic } from "./atomic-file.js";
import { CodexAppServerClient } from "./codex-app-server.js";
import { enforceDiskBudget } from "./disk-budget.js";
import { removeProbeWorkspace } from "./probe-workspace-cleanup.js";
import { AGENT_NETWORK, EGRESS_PROXY, RUNNER_LIMITS } from "./constants.js";
import { missingLoginError } from "./cli-startup-repair.js";
import { copyLoginFile, fingerprintTree, loginFiles, loginGuard } from "./login-guard.js";
import { Store } from "./store.js";
import { preserveSandboxResult, sandboxPromptPath } from "./sandbox-results.js";
import {
  assertCodexProfile,
  prepareCodexHome,
  retainCodexLogin,
} from "./codex-profile.js";
const exec = promisify(execFile);
const clientVersion = (
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
  ) as {
    version: string;
  }
).version;
const CURSOR_LOGIN_ROOTS = [".config/cursor", ".cursor"] as const;
// Seeding copies the whole trusted runtime/auth/cursor folder (config.toml,
// cli-config.json included). Only auth.json flows back from the
// agent-writable home: config files there could carry agent-chosen settings
// into every later round. Baseline, candidate and saved fingerprints all use
// this one filter so the login guard compares like with like.
const cursorRetainEntry = (path: string, directory: boolean) => directory
  ? !path.split("/").some((part) => ["sessions", "logs", "projects", "skills", "plugins"].includes(part))
  : path.split("/").at(-1) === "auth.json";

// Only the app-server fields this host reads are validated and kept.
const configRead = z.object({ config: z.unknown() });
const accountRead = z.object({
  account: z.object({ type: z.string().optional() }).nullish(),
});
const modelPage = z.object({
  data: z.array(z.object({
    model: z.string(),
    supportedReasoningEfforts: z
      .array(z.object({ reasoningEffort: z.string() }))
      .nullish(),
  })),
  nextCursor: z.string().nullish(),
});
const usageWindow = z.object({
  windowDurationMins: z.number().nullish(),
  usedPercent: z.number().nullish(),
  resetsAt: z.number().nullish(),
}).nullish();
const usageBucket = z.object({ primary: usageWindow, secondary: usageWindow });
const rateLimits = z.object({
  rateLimits: usageBucket.nullish(),
  rateLimitsByLimitId: z.record(z.string(), usageBucket.nullish()).nullish(),
});
export type CodexModel = z.output<typeof modelPage>["data"][number];
export interface CodexInfo {
  account?: string;
  models: CodexModel[];
  limits: z.output<typeof rateLimits>;
}

// Session workspaces are reused and agent-writable: a planted symlink at
// .home or .tmp would redirect login seeding outside the round folder.
async function assertRealDirectory(path: string) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("Runner workspace path must be a real directory, not a link");
}

// An explicit per-run native approval (one consented session conversation).
// Without it, native coding runs need the launcher's ARENA_NATIVE_APPROVED.
export interface RunApproval {
  nativeApproved?: boolean;
}

export interface DockerOptions {
  root: string;
  image: string;
}
export interface WorkspaceRequest {
  cli: Agent;
  round: number | string;
  session?: SessionId;
  auth?: boolean;
}
export class Docker {
  readonly executionBoundary: "docker" | "native" = "docker";
  label: string;
  constructor(
    private store: Store,
    private options: DockerOptions,
  ) {
    this.label = createHash("sha256")
      .update(options.root)
      .digest("hex")
      .slice(0, 16);
  }
  async command(args: string[], timeout = 15000) {
    const result = await exec("docker", args, {
      timeout,
      maxBuffer: 2_000_000,
    });
    return result.stdout;
  }
  name(agent: SessionId, round: number | string) {
    return `stram-${this.label}-${agent}-${round}`;
  }
  async workspace({ cli: agent, round, auth = true, session = agent }: WorkspaceRequest) {
    const dir = resolve(
      this.options.root,
      "runtime/workspaces",
      session,
      String(round),
    );
    await mkdir(resolve(dir, ".tmp"), { recursive: true, mode: 0o700 });
    const home = resolve(dir, ".home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    for (const path of [dir, resolve(dir, ".tmp"), home])
      await assertRealDirectory(path);
    if (agent === "codex") {
      await prepareCodexHome(this.options.root, home, auth);
      return dir;
    }
    if (auth) {
      await loginGuard(this.options.root, agent).prepare(home, async () => {
        const source = resolve(this.options.root, "runtime/auth", agent);
        const info = await lstat(source).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!info || info.isSymbolicLink() || !info.isDirectory()) throw missingLoginError(agent, "docker");
        await cp(source, home, { recursive: true, dereference: false,
          filter: async (path) => !(await lstat(path)).isSymbolicLink() });
      }, () => fingerprintTree(home, CURSOR_LOGIN_ROOTS, cursorRetainEntry, dir));
    }
    await mkdir(resolve(home, ".codex"), { recursive: true, mode: 0o700 });
    await writeFileAtomic(
      resolve(home, ".codex/config.toml"),
      'cli_auth_credentials_store = "file"\n',
    );
    return dir;
  }
  args(name: string, dir: string) {
    return [
      "--name",
      name,
      "--label",
      `stram.owner=${this.label}`,
      "--init",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      `--pids-limit=${RUNNER_LIMITS.pids}`,
      `--memory=${RUNNER_LIMITS.memory}`,
      `--cpus=${RUNNER_LIMITS.cpus}`,
      `--user=${RUNNER_LIMITS.user}`,
      `--network=${AGENT_NETWORK}`,
      "--dns=127.0.0.1",
      "--mount",
      `type=bind,source=${dir},target=/workspace`,
      "--workdir=/workspace",
      "-e",
      `HTTPS_PROXY=${EGRESS_PROXY}`,
      "-e",
      `HTTP_PROXY=${EGRESS_PROXY}`,
      "-e",
      `ALL_PROXY=${EGRESS_PROXY}`,
      "-e",
      "NODE_USE_ENV_PROXY=1",
    ];
  }
  async create(
    agent: Agent,
    round: number | string,
    command: string[],
    dir?: string,
    session: SessionId = agent,
    // Only the native host reads this; Docker runs are always contained.
    _approval: RunApproval = {},
  ) {
    const name = this.name(session, round);
    this.store.container(name);
    let workspace: string;
    try {
      workspace = dir ?? (await this.workspace({ cli: agent, round, session }));
    } catch (error) {
      this.store.forgetContainer(name);
      throw error;
    }
    try {
      await this.command([
        "create",
        "-i",
        ...this.args(name, workspace),
        this.options.image,
        ...command,
      ]);
    } catch (error) {
      try {
        await this.stop(name);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Container creation failed and cleanup could not be confirmed",
          { cause: error },
        );
      }
      throw error;
    }
    return { name, dir: workspace };
  }
  attach(name: string) {
    return spawn("docker", ["start", "-a", "-i", name], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
  }
  async stop(name: string) {
    const present = (
      await this.command(["ps", "-aq", "--filter", `name=^/${name}$`])
    ).trim();
    if (!present) {
      this.store.forgetContainer(name);
      return;
    }
    await this.command(["stop", "--time", "2", name]).catch(async () => {
      await this.command(["kill", name]);
    });
    const running = (
      await this.command(["inspect", "--format", "{{.State.Running}}", name])
    ).trim();
    if (running !== "false")
      throw new Error("Cannot confirm runner has stopped");
    await this.command(["rm", name]);
    this.store.forgetContainer(name);
  }
  async recover() {
    const names = (
      await this.command([
        "ps",
        "-a",
        "--filter",
        `label=stram.owner=${this.label}`,
        "--format",
        "{{.Names}}",
      ])
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const name of new Set([...names, ...this.store.containers()]))
      await this.stop(name);
    await enforceDiskBudget(this.options.root).catch(() => {});
  }
  async inspect(_agents: Agent[] = ["codex", "cursor"]) {
    await this.command(["info", "--format", "{{.ServerVersion}}"]);
    await this.command(["image", "inspect", this.options.image]);
    const internal = (
      await this.command([
        "network",
        "inspect",
        AGENT_NETWORK,
        "--format",
        "{{.Internal}}",
      ])
    ).trim();
    if (internal !== "true") throw new Error("Agent network must be internal");
  }
  async capture(agent: Agent, args: string[]) {
    const container = await this.create(agent, `check-${randomUUID()}`, args);
    try {
      const result = await exec(
        "docker",
        ["start", "-a", "-i", container.name],
        { timeout: 20000, maxBuffer: 1_000_000 },
      );
      return result.stdout;
    } finally {
      await this.stop(container.name);
      await removeProbeWorkspace(container.dir).catch(() => {});
    }
  }
  async codexInfo(): Promise<CodexInfo> {
    const container = await this.create("codex", `rpc-${randomUUID()}`, [
      "codex",
      "app-server",
    ]);
    const child = this.attach(container.name);
    const rpc = new CodexAppServerClient(child, {
      messages: {
        rejected: "Codex capability request failed",
        failed: "Cannot start Codex capability check",
        closed: "Codex capability process closed",
        timeout: (method) => `Codex ${method} timed out`,
        refused: "Unsupported request",
      },
    });
    try {
      await rpc.initialize({ name: "prompt_arena", version: clientVersion });
      const profile = await rpc.call("config/read", { includeLayers: false }, configRead);
      assertCodexProfile(profile.config);
      const { account } = await rpc.call("account/read", { refreshToken: true }, accountRead);
      if (account?.type !== "chatgpt")
        return { account: account?.type, models: [], limits: {} };
      const models: CodexModel[] = [];
      let cursor: string | undefined;
      do {
        const result = await rpc.call("model/list", {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        }, modelPage);
        models.push(...result.data);
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
      const limits = await rpc.call("account/rateLimits/read", {}, rateLimits);
      return { account: account.type, models, limits };
    } finally {
      child.stdin.end();
      await this.stop(container.name);
      await this.retainAuth("codex", container.dir);
      await removeProbeWorkspace(container.dir).catch(() => {});
    }
  }
  // discardHome: a finished arena round never reuses its folder, so once the
  // login is safely back in runtime/auth the token copy in .home is deleted.
  // A failed retain throws first and keeps .home: a rotated refresh token may
  // exist only there.
  async retainAuth(agent: Agent, dir: string, options: { discardHome?: boolean } = {}) {
    const home = resolve(dir, ".home");
    if (agent === "codex") await retainCodexLogin(this.options.root, home);
    else {
      const dest = resolve(this.options.root, "runtime/auth", agent);
      await loginGuard(this.options.root, agent).retain(home,
        () => fingerprintTree(home, CURSOR_LOGIN_ROOTS, cursorRetainEntry, dir),
        () => fingerprintTree(dest, CURSOR_LOGIN_ROOTS, cursorRetainEntry, this.options.root),
        async () => {
          for (const name of await loginFiles(home, CURSOR_LOGIN_ROOTS, cursorRetainEntry, dir))
            await copyLoginFile(resolve(home, name), resolve(dest, name), dir, this.options.root);
        });
    }
    // rm removes a planted symlink itself, never its target.
    if (options.discardHome) await rm(home, { recursive: true, force: true });
  }
  async preserveOutput(agent: SessionId, round: number, dir: string) {
    return preserveSandboxResult(this.options.root, agent, round, dir);
  }
  async output(agent: SessionId, round: number, dir: string) {
    const path = await sandboxPromptPath(dir, round, true);
    if (!path) throw new Error("Output missing");
    const folder = resolve(this.options.root, "main", agent);
    await mkdir(folder, { recursive: true });
    await cp(path, resolve(folder, `prompt_${round}.html`));
  }
}

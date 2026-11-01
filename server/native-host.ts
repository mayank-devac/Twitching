import {
  spawn,
  execFile,
  execFileSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic, writeFileAtomicSync } from "./atomic-file.js";
import { assertRealDirectory, Docker, type RunApproval, type WorkspaceRequest } from "./docker.js";
import { enforceDiskBudget } from "./disk-budget.js";
import { removeProbeWorkspace } from "./probe-workspace-cleanup.js";
import { prepareCodexHome, retainCodexLogin } from "./codex-profile.js";
import type { Store } from "./store.js";
import { CLIS, SESSION_IDS, type Agent, type SessionId } from "../shared/types.js";

const exec = promisify(execFile);
// lstart+pgid identify one process group launch; a reused pid gets a new start.
const stampArgs = (pid: number) => ["-p", String(pid), "-o", "lstart=,pgid="];

interface ProcessRecord {
  pid: number;
  stamp: string;
}
interface Prepared {
  agent: Agent;
  dir: string;
  command: string[];
  env?: NodeJS.ProcessEnv;
  process?: ChildProcessWithoutNullStreams;
  record?: ProcessRecord;
}

// Uses the same CLI protocol/model checks as Docker, but has no host execution boundary.
// Codex uses the private arena login; personal config and skills are not inherited.
export class NativeHost extends Docker {
  override readonly executionBoundary = "native" as const;
  private prepared = new Map<string, Prepared>();
  constructor(
    private nativeStore: Store,
    private nativeRoot: string,
  ) {
    super(nativeStore, { root: nativeRoot, image: "" });
  }
  override name(agent: SessionId, round: number | string) {
    return `native-${super.name(agent, round)}`;
  }
  override async workspace({ cli: agent, round, session = agent }: WorkspaceRequest) {
    const dir = resolve(
      this.nativeRoot,
      "runtime/native-workspaces",
      session,
      String(round),
    );
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Same S7 guard as Docker: a reused round folder (or its .cli-home) that is
    // a planted link would redirect login seeding and git init elsewhere.
    // Check the round folder before creating anything inside it.
    await assertRealDirectory(dir);
    const home = resolve(dir, ".cli-home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await assertRealDirectory(home);
    // A git root here stops the CLI from walking up to this repo's AGENTS.md and rules.
    await access(resolve(dir, ".git")).catch(() =>
      exec("git", ["init", "-q"], { cwd: dir }),
    );
    return dir;
  }
  private recordPath(name: string) {
    const prefix = `native-stram-${this.label}-`;
    const suffix = name.startsWith(prefix) ? name.slice(prefix.length) : "";
    const id = SESSION_IDS.find((id) => suffix.startsWith(`${id}-`));
    if (!id || !/^[a-zA-Z0-9-]+$/.test(suffix.slice(id.length + 1)))
      throw new Error("Invalid native runner record");
    return resolve(this.nativeRoot, "runtime/native-processes", `${name}.json`);
  }
  private async stamp(pid: number) {
    try {
      return (await exec("ps", stampArgs(pid), { timeout: 2000 })).stdout.trim();
    } catch {
      return "";
    }
  }
  // attach() must return its child synchronously, so the launch record is
  // stamped and written before it returns; everything else polls async.
  private stampNow(pid: number) {
    try {
      return execFileSync("ps", stampArgs(pid), { encoding: "utf8", timeout: 2000 }).trim();
    } catch {
      return "";
    }
  }
  private async groupAlive(pid: number) {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        // The leader may already have exited. Check every group member before
        // treating this as a stale record; a failed/partial listing is unsafe.
        try {
          const rows = (await this.processGroups()).trim().split("\n");
          const members = rows.map((row) => row.match(/^\s*(\d+)\s+(\d+)\s*$/));
          if (
            members.length &&
            members.every(Boolean) &&
            members.some((row) => Number(row![1]) === process.pid) &&
            !members.some((row) => Number(row![2]) === pid)
          )
            return false;
        } catch {
          // Preserve the record when process visibility is unavailable.
        }
        throw this.groupPermissionError(pid);
      }
      throw error;
    }
  }
  protected async processGroups() {
    return (await exec("/bin/ps", ["-A", "-o", "pid=,pgid="], {
      timeout: 2000,
      maxBuffer: 1_000_000,
    })).stdout;
  }
  private groupPermissionError(pid: number) {
    return Object.assign(
      new Error(
        `Permission denied for native process group ${pid}. Cannot confirm safe cleanup; its record is kept and no new round can start.`,
      ),
      { code: "EPERM" },
    );
  }
  private signalGroup(pid: number, signal: "SIGTERM" | "SIGKILL") {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      if ((error as NodeJS.ErrnoException).code === "EPERM")
        throw this.groupPermissionError(pid);
      throw error;
    }
  }
  override async inspect(agents: readonly Agent[] = CLIS) {
    if (process.platform === "win32")
      throw new Error(
        "Native runners require macOS/Linux; use Docker mode on Windows",
      );
    if (agents.includes("codex"))
      await this.capture("codex", ["codex", "--version"]);
    if (agents.includes("cursor"))
      await this.capture("cursor", ["cursor-agent", "--version"]);
  }
  override async create(
    agent: Agent,
    round: number | string,
    command: string[],
    dir?: string,
    session: SessionId = agent,
    approval: RunApproval = {},
  ) {
    const codexHelp =
      agent === "codex" &&
      command[0] === "codex" &&
      command.length === 3 &&
      command[1] === "exec" &&
      command[2] === "--help";
    const coding =
      !codexHelp && (command.includes("--print") || command[1] === "exec");
    // ARENA_NATIVE_APPROVED is set only by the launcher (start_stream.sh);
    // a session's in-app consent arrives per run as approval.nativeApproved.
    if (
      coding &&
      !approval.nativeApproved &&
      process.env.ARENA_NATIVE_APPROVED !== "1"
    ) {
      throw new Error(
        "Native mode is not confirmed. Run ./start_stream.sh and type NATIVE when asked.",
      );
    }
    // Native runs have no container, so each CLI keeps its own sandbox:
    // Cursor runs with its default sandbox, and Codex swaps the Docker-only
    // bypass flag for a workspace-write sandbox rooted at the round folder.
    const args = command.map((arg) =>
      coding && agent === "codex" && arg === "--dangerously-bypass-approvals-and-sandbox"
        ? "--sandbox=workspace-write"
        : arg,
    );
    const workspace =
      dir ?? (await this.workspace({ cli: agent, round, session }));
    // Keep task instructions identical across native agents; the fixed output is relative to cwd.
    if (coding)
      args[args.length - 1] = command[command.length - 1]
        .replaceAll("/workspace/", "./")
        .replace(
          "Work only in /workspace.",
          "Work only in your current working directory.",
        );
    const name = this.name(session, round);
    await mkdir(resolve(this.nativeRoot, "runtime/native-processes"), {
      recursive: true,
      mode: 0o700,
    });
    const env = await this.sessionEnv(agent, workspace);
    this.nativeStore.container(name);
    this.prepared.set(name, {
      agent,
      dir: workspace,
      command: args,
      env,
    });
    return { name, dir: workspace };
  }
  private async sessionEnv(agent: Agent, dir: string) {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
    };
    // Docs load MCP and rules from the home directory and the project root.
    // This home has neither, so the prompt session does not start those servers or rules.
    const home = resolve(dir, ".cli-home");
    if (agent === "codex") {
      env.CODEX_HOME = await prepareCodexHome(this.nativeRoot, home);
      env.HOME = home;
      env.XDG_CONFIG_HOME = resolve(home, ".config");
      return env;
    }
    await mkdir(resolve(home, ".cursor"), { recursive: true, mode: 0o700 });
    await writeFileAtomic(resolve(home, ".cursor", "mcp.json"), '{"mcpServers":{}}\n');
    if (process.env.HOME) await this.reuseCursorLogin(process.env.HOME, home);
    env.HOME = home;
    env.XDG_CONFIG_HOME = resolve(home, ".config");
    return env;
  }
  private async reuseCursorLogin(realHome: string, cliHome: string) {
    await this.copyCursorAuthFile(realHome, cliHome);
    await this.linkCursorKeychain(realHome, cliHome);
  }
  private async copyCursorAuthFile(realHome: string, cliHome: string) {
    const source = resolve(realHome, ".cursor", "auth.json");
    const info = await lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info?.isFile() || info.isSymbolicLink()) return;
    const root = await realpath(realHome);
    if ((await realpath(source)) !== resolve(root, ".cursor", "auth.json"))
      return;
    const destination = resolve(cliHome, ".cursor", "auth.json");
    await cp(source, destination);
    await chmod(destination, 0o600);
  }
  // macOS `security` looks up the login keychain under $HOME. The CLI home is
  // empty, so link only that database. Do not copy it or read its contents.
  private async linkCursorKeychain(realHome: string, cliHome: string) {
    const source = resolve(
      realHome,
      "Library",
      "Keychains",
      "login.keychain-db",
    );
    const info = await lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info?.isFile() || info.isSymbolicLink()) return;
    const root = await realpath(realHome);
    const expected = resolve(root, "Library", "Keychains", "login.keychain-db");
    if ((await realpath(source)) !== expected) return;
    const destinationDir = resolve(cliHome, "Library", "Keychains");
    await mkdir(destinationDir, { recursive: true, mode: 0o700 });
    const destination = resolve(destinationDir, "login.keychain-db");
    const existing = await lstat(destination).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (existing) return;
    await symlink(source, destination);
  }
  override attach(name: string) {
    const item = this.prepared.get(name);
    if (!item) throw new Error("Native runner was not prepared");
    const child = spawn(item.command[0], item.command.slice(1), {
      cwd: item.dir,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: item.env ?? {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
      },
    });
    item.process = child;
    const record = () => {
      if (!child.pid) return;
      const stamp = this.stampNow(child.pid);
      // A fast CLI can exit before the spawn callback. Preserve any identity
      // already captured rather than overwriting it with an empty stamp.
      if (item.record?.stamp && !stamp) return;
      item.record = { pid: child.pid, stamp };
      // Atomic: a crash mid-write must not leave a record recovery cannot parse.
      writeFileAtomicSync(this.recordPath(name), JSON.stringify(item.record));
    };
    record();
    child.once("spawn", record);
    return child;
  }
  override async stop(name: string) {
    if (!name.startsWith("native-"))
      throw new Error(
        "Previous Docker runners need recovery in Docker mode before switching to native",
      );
    const prepared = this.prepared.get(name);
    let record = prepared?.record;
    if (!record) {
      try {
        record = JSON.parse(await readFile(this.recordPath(name), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (
      record &&
      (!Number.isSafeInteger(record.pid) ||
        record.pid < 2 ||
        typeof record.stamp !== "string")
    )
      throw new Error(
        "Invalid native process record; inspect it before restarting",
      );
    if (record && (await this.groupAlive(record.pid))) {
      // A child handle identifies the group launched in this session, even
      // after its leader exits. Recovered groups still need a matching stamp.
      const ownedChild = prepared?.process?.pid === record.pid;
      const current = ownedChild ? "" : await this.stamp(record.pid);
      if (
        !ownedChild &&
        (!record.stamp || !current || current !== record.stamp)
      ) {
        throw new Error(
          `Cannot verify ownership of native process group ${record.pid}. Inspect and stop it manually before starting another round.`,
        );
      }
      this.signalGroup(record.pid, "SIGTERM");
      const until = Date.now() + 2000;
      while ((await this.groupAlive(record.pid)) && Date.now() < until)
        await new Promise((r) => setTimeout(r, 100));
      if (await this.groupAlive(record.pid)) this.signalGroup(record.pid, "SIGKILL");
      const killedUntil = Date.now() + 2000;
      while ((await this.groupAlive(record.pid)) && Date.now() < killedUntil)
        await new Promise((r) => setTimeout(r, 100));
      if (await this.groupAlive(record.pid))
        throw new Error(
          "Native process group did not stop; no new round can start",
        );
    }
    const workspace = prepared?.dir;
    let authError: unknown;
    if (workspace && prepared?.agent === "codex") {
      try {
        await this.retainAuth("codex", workspace);
      } catch (error) {
        authError = error;
      }
    }
    await unlink(this.recordPath(name)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    this.nativeStore.forgetContainer(name);
    this.prepared.delete(name);
    if (workspace) await removeProbeWorkspace(workspace).catch(() => {});
    if (authError) throw authError;
  }
  override async recover() {
    const records = await readdir(
      resolve(this.nativeRoot, "runtime/native-processes"),
    ).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const names = new Set([
      ...this.nativeStore.containers(),
      ...records
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.slice(0, -5)),
    ]);
    for (const name of names) await this.stop(name);
    await enforceDiskBudget(this.nativeRoot).catch(() => {});
  }
  override async capture(agent: Agent, args: string[]) {
    const created = await this.create(agent, `check-${randomUUID()}`, args);
    const child = this.attach(created.name);
    try {
      const result = await new Promise<string>((resolveResult, reject) => {
        let output = "";
        const timeout = setTimeout(
          () => reject(new Error("Native CLI check timed out")),
          20000,
        );
        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
          if (output.length > 1_000_000)
            reject(new Error("Native CLI output exceeded its limit"));
        });
        child.stderr.resume();
        child.once("error", () => {
          clearTimeout(timeout);
          reject(
            new Error(
              `Cannot run ${args[0]}; install it and make it available in PATH`,
            ),
          );
        });
        child.once("close", (code) => {
          clearTimeout(timeout);
          code === 0
            ? resolveResult(output)
            : reject(
                new Error(
                  `${agent} CLI check failed; check your saved subscription login`,
                ),
              );
        });
        child.stdin.end();
      });
      return result;
    } finally {
      await this.stop(created.name);
    }
  }
  override async retainAuth(
    agent: Agent,
    dir: string,
    options: { discardHome?: boolean } = {},
  ) {
    const home = resolve(dir, ".cli-home");
    if (agent === "codex") await retainCodexLogin(this.nativeRoot, home);
    // Cursor keeps its saved native login behaviour; its .cli-home holds a copy
    // of the host auth.json, so a finished arena round discards it as well.
    if (options.discardHome) await rm(home, { recursive: true, force: true });
  }
}

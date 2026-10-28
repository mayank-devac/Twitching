import {
  spawn,
  execFileSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Docker } from "./docker.js";
import { enforceDiskBudget } from "./disk-budget.js";
import { removeProbeWorkspace } from "./probe-workspace-cleanup.js";
import { prepareCodexHome, retainCodexLogin } from "./codex-profile.js";
import type { Store } from "./store.js";
import { SESSION_IDS, type Agent, type SessionId } from "../shared/types.js";

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
  private cursorSandboxOption = false;
  constructor(
    private nativeStore: Store,
    private nativeRoot: string,
  ) {
    super(nativeStore, { root: nativeRoot, image: "" });
  }
  override name(agent: SessionId, round: number | string) {
    return `native-${super.name(agent, round)}`;
  }
  override async workspace(
    agent: Agent,
    round: number | string,
    _auth = true,
    session: SessionId = agent,
  ) {
    const dir = resolve(
      this.nativeRoot,
      "runtime/native-workspaces",
      session,
      String(round),
    );
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // A git root here stops the CLI from walking up to this repo's AGENTS.md and rules.
    await access(resolve(dir, ".git")).catch(() =>
      execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" }),
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
  private stamp(pid: number) {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "lstart=,pgid="], {
        encoding: "utf8",
        timeout: 2000,
      }).trim();
    } catch {
      return "";
    }
  }
  private groupAlive(pid: number) {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        // The leader may already have exited. Check every group member before
        // treating this as a stale record; a failed/partial listing is unsafe.
        try {
          const rows = this.processGroups().trim().split("\n");
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
  protected processGroups() {
    return execFileSync("/bin/ps", ["-A", "-o", "pid=,pgid="], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 1_000_000,
    });
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
  override async inspect(agents: Agent[] = ["codex", "cursor"]) {
    if (process.platform === "win32")
      throw new Error(
        "Native runners require macOS/Linux; use Docker mode on Windows",
      );
    if (agents.includes("codex"))
      await this.capture("codex", ["codex", "--version"]);
    if (!agents.includes("cursor")) return;
    await this.capture("cursor", ["cursor-agent", "--version"]);
    const help = await this.capture("cursor", ["cursor-agent", "--help"]);
    this.cursorSandboxOption = help.includes("--sandbox");
    if (!this.cursorSandboxOption)
      throw new Error(
        "Update Cursor CLI: native mode requires its --sandbox option",
      );
  }
  override async create(
    agent: Agent,
    round: number | string,
    command: string[],
    dir?: string,
    session: SessionId = agent,
  ) {
    const codexHelp =
      agent === "codex" &&
      command[0] === "codex" &&
      command.length === 3 &&
      command[1] === "exec" &&
      command[2] === "--help";
    const coding =
      !codexHelp && (command.includes("--print") || command[1] === "exec");
    if (coding && process.env.ARENA_NATIVE_APPROVED !== "1") {
      throw new Error(
        "Native mode is not confirmed. Run ./start_stream.sh and type NATIVE when asked.",
      );
    }
    let args = command.slice();
    if (coding && agent === "cursor") {
      if (!this.cursorSandboxOption)
        throw new Error("Native Cursor sandbox support was not checked");
      args.splice(args.length - 1, 0, "--sandbox", "disabled");
    }
    const workspace =
      dir ?? (await this.workspace(agent, round, true, session));
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
    await writeFile(
      resolve(home, ".cursor", "mcp.json"),
      '{"mcpServers":{}}\n',
      {
        mode: 0o600,
      },
    );
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
      const stamp = this.stamp(child.pid);
      // A fast CLI can exit before the spawn callback. Preserve any identity
      // already captured rather than overwriting it with an empty stamp.
      if (item.record?.stamp && !stamp) return;
      item.record = { pid: child.pid, stamp };
      writeFileSync(this.recordPath(name), JSON.stringify(item.record), {
        mode: 0o600,
      });
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
    if (record && this.groupAlive(record.pid)) {
      // A child handle identifies the group launched in this session, even
      // after its leader exits. Recovered groups still need a matching stamp.
      const ownedChild = prepared?.process?.pid === record.pid;
      const current = ownedChild ? "" : this.stamp(record.pid);
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
      while (this.groupAlive(record.pid) && Date.now() < until)
        await new Promise((r) => setTimeout(r, 100));
      if (this.groupAlive(record.pid)) this.signalGroup(record.pid, "SIGKILL");
      const killedUntil = Date.now() + 2000;
      while (this.groupAlive(record.pid) && Date.now() < killedUntil)
        await new Promise((r) => setTimeout(r, 100));
      if (this.groupAlive(record.pid))
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
  override async retainAuth(agent: Agent, dir: string) {
    if (agent === "codex")
      await retainCodexLogin(this.nativeRoot, resolve(dir, ".cli-home"));
    // Cursor keeps its saved native login behaviour.
  }
}

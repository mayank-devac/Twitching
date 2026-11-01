import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

// Narrow injectable OS operations let fixtures prove ownership checks without killing processes.
export interface RestartSystem {
  command(program: string, args: string[]): Promise<string>;
  terminate(pid: number): void;
  alive(pid: number): boolean;
  delay(): Promise<void>;
  now(): number;
}
const execute = promisify(execFile);
const system: RestartSystem = {
  command: async (program, args) => {
    const result = await execute(program, args, {
      timeout: 2500,
      maxBuffer: 16384,
      env: { PATH: process.env.PATH },
    });
    return result.stdout;
  },
  terminate: (pid) => process.kill(pid, "SIGTERM"),
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw new Error("Cannot confirm whether the previous server has stopped");
    }
  },
  delay: () => new Promise((done) => setTimeout(done, 200)),
  now: Date.now,
};

// lsof exit 1 means no matches; all other failures leave ownership unconfirmed.
async function listeners(port: number, os: RestartSystem) {
  let output: string;
  try {
    output = await os.command("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fp",
    ]);
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return [];
    throw new Error(
      "Cannot verify the listening process. Stop its terminal manually (lsof is required).",
    );
  }
  return [
    ...new Set(
      output
        .split("\n")
        .filter((line) => /^p\d+$/.test(line))
        .map((line) => Number(line.slice(1))),
    ),
  ];
}
async function lockPid(root: string) {
  const path = resolve(root, "runtime/controller.lock");
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 32 ||
    (await realpath(path)) !== path
  )
    throw new Error("Unsafe controller lock");
  const value = (await readFile(path, "utf8")).trim();
  const pid = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    pid === process.pid
  )
    throw new Error("Invalid controller PID");
  return pid;
}
async function processInfo(pid: number, os: RestartSystem) {
  const info = (
    await os.command("ps", ["-p", String(pid), "-o", "ppid=", "-o", "comm="])
  ).trim();
  const match = /^(\d+)\s+(.+)$/.exec(info);
  if (!match) throw new Error("Process identity unavailable");
  const args = (
    await os.command("ps", ["-p", String(pid), "-o", "args="])
  ).trim();
  return {
    parent: Number(match[1]),
    node: /(?:^|\/)(?:node|nodejs|tsx)$/.test(match[2]!),
    args,
  };
}
async function sameDirectory(pid: number, root: string, os: RestartSystem) {
  const output = await os.command("lsof", [
    "-a",
    "-p",
    String(pid),
    "-d",
    "cwd",
    "-Fn",
  ]);
  return output.split("\n").includes(`n${root}`);
}

// Stop the verified startup wrapper when present, so its OBS/process cleanup finishes first.
export async function stopExistingServer(
  root: string,
  port: number,
  verifyBoot: () => Promise<void>,
  cancelled: () => boolean,
  os: RestartSystem = system,
) {
  const canonical = await realpath(root);
  let pid: number;
  let wrapper: number | undefined;
  try {
    pid = await lockPid(canonical);
    const owners = await listeners(port, os);
    const server = await processInfo(pid, os);
    if (
      owners.length !== 1 ||
      owners[0] !== pid ||
      !server.node ||
      !/(?:^|\s|\/)server\/index\.(?:ts|js)(?:\s|$)/.test(server.args) ||
      !(await sameDirectory(pid, canonical, os))
    )
      throw new Error("Server ownership mismatch");
    let parent = server.parent;
    for (
      let depth = 0;
      parent > 1 && parent !== process.pid && depth < 10;
      depth++
    ) {
      const ancestor = await processInfo(parent, os);
      if (
        ancestor.node &&
        /(?:^|\s|\/)scripts\/stream\.(?:ts|js)\s+start(?:\s|$)/.test(
          ancestor.args,
        )
      ) {
        if (!(await sameDirectory(parent, canonical, os)))
          throw new Error("Startup ownership mismatch");
        wrapper = parent;
        break;
      }
      if (ancestor.parent === parent) throw new Error("Invalid parent chain");
      parent = ancestor.parent;
      if (depth === 9 && parent > 1)
        throw new Error("Startup parent chain is too deep");
    }
    // Recheck after the human prompt and immediately before sending any signal.
    await verifyBoot();
    if (
      (await lockPid(canonical)) !== pid ||
      !(await listeners(port, os)).includes(pid)
    )
      throw new Error("Server changed during confirmation");
  } catch {
    throw new Error(
      "Could not verify this server and its startup process safely. Keep it running or stop its original terminal manually.",
    );
  }
  if (cancelled()) throw new Error("Cancelled");
  os.terminate(wrapper ?? pid);
  const deadline = os.now() + 30_000;
  while (os.now() < deadline) {
    if (cancelled()) throw new Error("Cancelled");
    if (!os.alive(pid) && (!wrapper || !os.alive(wrapper))) {
      if ((await listeners(port, os)).length)
        throw new Error(
          "Another process took the control port. No new server was started.",
        );
      return;
    }
    await os.delay();
  }
  throw new Error(
    "The old server/startup did not finish shutdown within 30 seconds. No force-kill or second server was attempted; check its terminal and OBS.",
  );
}

// Empty input deliberately keeps the current app; invalid answers never imply restart.
export async function chooseExistingServer(
  question: (text: string) => Promise<string>,
) {
  const choice = (
    await question(
      "Existing Twitching server: 1 = keep running, 2 = stop and start fresh [1]: ",
    )
  )
    .trim()
    .toLowerCase();
  if (["", "1", "keep"].includes(choice)) return "keep" as const;
  if (["2", "restart"].includes(choice)) return "restart" as const;
  throw new Error("Choose 1 to keep the server or 2 to restart it");
}

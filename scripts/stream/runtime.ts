// Owns the guided launcher's shared terminal state: prompts, child tools, checklist repairs and shutdown.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline/promises";
import { redactor } from "../../server/redact.js";

type ServerConfig = typeof import("../../server/config.js");
export type Settings = ServerConfig["settings"];
export type Secrets = ServerConfig["secrets"];

export const root = process.cwd();
export const toolEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG,
  DOCKER_HOST: process.env.DOCKER_HOST,
  DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
};

// One mutable record (not exported lets) so every module sees the same live values.
export const launcher: {
  stopping: boolean;
  input?: Interface;
  safeMessage: (text: string) => string;
  app?: ChildProcess;
  appExit?: Promise<number | null>;
  closeShow?: () => Promise<void>;
  closeResources?: () => Promise<void>;
} = { stopping: false, safeMessage: redactor([], root) };

export const throwIfStopping = () => {
  if (launcher.stopping) throw new Error("Cancelled");
};

export function openPrompt(interactive: boolean) {
  launcher.input = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
}
export const question = async (text: string, fallback = "") => {
  throwIfStopping();
  return launcher.input
    ? (await launcher.input.question(text)).trim()
    : fallback;
};
export const yes = async (text: string) =>
  /^(y|yes)$/i.test(await question(`${text} [y/N]: `));
export const fix = (message: string, instruction: string): never => {
  throw new Error(`${message}\nFix: ${instruction}`);
};

export async function run(program: string, parameters: string[], env = toolEnv) {
  await new Promise<void>((done, reject) => {
    const child = spawn(program, parameters, {
      cwd: root,
      env,
      stdio: "inherit",
    });
    child.once("error", () =>
      reject(new Error(`Cannot run ${program}. Install it or add it to PATH.`)),
    );
    child.once("close", (code) =>
      launcher.stopping
        ? reject(new Error("Cancelled"))
        : code === 0
          ? done()
          : reject(
              new Error(
                `${program} failed. Fix the error shown above, then rerun this file.`,
              ),
            ),
    );
  });
}

// One checklist line: check, explain the fix, optionally run it with consent, then recheck.
export async function repair(
  label: string,
  action: () => void | Promise<void>,
  instruction:
    string | ((error: unknown) => { instruction: string; canRepair: boolean }),
  repairAction?: (error: unknown) => Promise<void>,
) {
  throwIfStopping();
  console.log(`\nChecking ${label}…`);
  try {
    await action();
  } catch (error) {
    const advice =
      typeof instruction === "function"
        ? instruction(error)
        : { instruction, canRepair: true };
    console.error(
      `FAIL: ${label}\n${launcher.safeMessage(error instanceof Error ? error.message : "Check failed")}\nFix: ${advice.instruction}`,
    );
    if (!advice.canRepair || !repairAction || !(await yes("Run this fix now?")))
      throw new Error(`${label} is not ready. ${advice.instruction}`);
    await repairAction(error);
    throwIfStopping();
    await action();
  }
  throwIfStopping();
  console.log(`OK: ${label}`);
}

let shutdownPromise: Promise<void> | undefined;
export async function shutdown() {
  launcher.stopping = true;
  if (!shutdownPromise) shutdownPromise = finishShutdown();
  await shutdownPromise;
}
async function finishShutdown() {
  await launcher.closeShow?.().catch((error) =>
    console.error(
      `ERROR: Could not confirm OBS/show shutdown: ${error.message}. Check OBS manually.`,
    ),
  );
  const app = launcher.app;
  if (app?.pid && app.exitCode === null) {
    // The app runs detached in its own process group; signal the whole group.
    process.kill(-app.pid, "SIGTERM");
    const exit = launcher.appExit!;
    const stopped = await Promise.race([
      exit.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 12000)),
    ]);
    if (!stopped)
      console.error(
        "ERROR: The app did not confirm shutdown. Stop its processes before starting another show.",
      );
  }
  await launcher.closeResources?.().catch(() => {});
  launcher.input?.close();
}

export function installSignalHandlers() {
  process.once("SIGINT", () => {
    void shutdown().finally(() => {
      process.exitCode = 130;
    });
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => {
      process.exitCode = 143;
    });
  });
}

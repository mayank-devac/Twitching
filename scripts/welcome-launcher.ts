import { spawn, execFile } from "node:child_process";
import { readFile, access, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { normalizeStartup } from "../server/startup-config.js";

// Reuse only this checkout's controller; the server's exclusive lock owns new starts.
const root = process.cwd();
const settings = normalizeStartup(
  JSON.parse(await readFile(resolve(root, "settings.json"), "utf8")),
  root,
);
const distIndex = resolve(root, "dist/index.html");
async function buildWelcomeUi() {
  console.log(
    "Welcome UI is missing or older than its source. Building it now…",
  );
  await new Promise<void>((done, reject) => {
    const build = spawn("npm", ["run", "build"], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    build.once("error", () =>
      reject(
        new Error(
          "Could not start npm run build. Check that npm is installed.",
        ),
      ),
    );
    build.once("close", (code) =>
      code === 0
        ? done()
        : reject(
            new Error(
              "The welcome UI build failed. Fix the build output, then rerun start_stream.",
            ),
          ),
    );
  });
}
async function newestSource(folder: string): Promise<number> {
  const times = await Promise.all(
    (await readdir(folder, { withFileTypes: true })).map(async (entry) => {
      const path = resolve(folder, entry.name);
      if (entry.isDirectory()) return newestSource(path);
      return /\.(ts|tsx|css|html)$/.test(entry.name)
        ? (await stat(path)).mtimeMs
        : 0;
    }),
  );
  return Math.max(0, ...times);
}
const newestUiSource = Math.max(
  await newestSource(resolve(root, "web")),
  await newestSource(resolve(root, "shared")),
);
let builtUiAt = 0;
try {
  builtUiAt = (await stat(distIndex)).mtimeMs;
} catch {
  // The first start has no bundle yet; buildWelcomeUi creates it.
}
if (newestUiSource > builtUiAt) await buildWelcomeUi();
await access(distIndex).catch(() => {
  throw new Error(
    "The welcome UI bundle is missing after the build. Fix the build output, then rerun start_stream.",
  );
});
const newestServerSource = Math.max(
  await newestSource(resolve(root, "server")),
  await newestSource(resolve(root, "scripts")),
  (await stat(resolve(root, "settings.json"))).mtimeMs,
);
const origin = `http://${settings.host}:${settings.port}`;
const rootId = createHash("sha256").update(root).digest("hex");
async function existing() {
  try {
    const response = await fetch(`${origin}/api/boot`, {
      signal: AbortSignal.timeout(1000),
    });
    const boot = (await response.json()) as {
      rootId?: string;
      startedAt?: number;
    };
    if (boot.rootId !== rootId)
      throw new Error("Another service is using the configured port");
    if (!boot.startedAt || newestServerSource > boot.startedAt)
      throw new Error(
        "The running server has older code. Stop its terminal with Ctrl+C, then reopen the launcher.",
      );
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "Another service is using the configured port" ||
        error.message.startsWith("The running server has older code"))
    )
      throw error;
    return false;
  }
}
let child: ReturnType<typeof spawn> | undefined;
if (!(await existing())) {
  child = spawn(resolve(root, "node_modules/.bin/tsx"), ["server/index.ts"], {
    stdio: "inherit",
    env: {
      ...process.env,
      ARENA_EXPERIENCE: "welcome",
      ARENA_NO_PROMPTS: "1",
      ARENA_MODE: "rehearsal",
    },
  });
  child.on("error", () => {
    console.error("Could not start the local server");
    process.exitCode = 1;
  });
  let ready = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (await existing()) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!ready) {
    child.kill("SIGINT");
    throw new Error(
      "Local server did not become ready. Check the message above.",
    );
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => child?.kill(signal));
  child.once("exit", (code) => process.exit(code ?? 1));
}
console.log(`Welcome: ${origin}/control/welcome`);
if (process.platform === "darwin")
  execFile("open", [`${origin}/control/welcome`]);
else console.log("Open the welcome link in your browser.");
// An existing service owns its lifetime; this launcher may exit without stopping it.
if (!child) process.exit(0);

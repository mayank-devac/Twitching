import {
  chmod,
  cp,
  lstat,
  mkdir,
  realpath,
  writeFile,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { LoginRefreshConflict } from "./cli/types.js";
import { createHash, randomUUID } from "node:crypto";
import { dirname, relative, resolve } from "node:path";

// One controller owns the project. Serialize its profile copies and use a
// compare-before-write snapshot so an older session cannot replace a new login.
const loginQueues = new Map<string, Promise<unknown>>();
const loginSnapshots = new Map<string, string | undefined>();
async function withLoginLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = loginQueues.get(root) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  loginQueues.set(root, next);
  try {
    return await next;
  } finally {
    if (loginQueues.get(root) === next) loginQueues.delete(root);
  }
}
async function loginFingerprint(path: string, allowedRoot: string) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !==
      resolve(await realpath(allowedRoot), relative(allowedRoot, path))
  )
    throw new Error("Unsafe Codex login file");
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

// These controls apply to arena invocations, never the user's normal CLI config.
export const CODEX_EXEC_PROFILE_ARGS = [
  "--ignore-user-config",
  "--ignore-rules",
  "-c",
  'cli_auth_credentials_store="file"',
  "-c",
  "project_doc_max_bytes=0",
  "--disable",
  "apps",
  "--disable",
  "plugins",
  "--disable",
  "hooks",
] as const;

const config = `cli_auth_credentials_store = "file"
project_doc_max_bytes = 0
project_doc_fallback_filenames = []
[features]
apps = false
plugins = false
hooks = false
`;

async function copyLogin(
  source: string,
  destination: string,
  allowedRoot: string,
  destinationRoot: string,
) {
  const info = await lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return false;
  const root = await realpath(allowedRoot);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (await realpath(source)) !== resolve(root, relative(allowedRoot, source))
  )
    throw new Error(
      "Arena Codex login path must be a regular file inside its profile",
    );
  const existing = await lstat(destination).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error("Arena Codex login destination must be a regular file");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (
    (await realpath(dirname(destination))) !==
    resolve(
      await realpath(destinationRoot),
      relative(destinationRoot, dirname(destination)),
    )
  )
    throw new Error(
      "Arena Codex login destination must stay inside its profile",
    );
  await cp(source, destination);
  await chmod(destination, 0o600);
  return true;
}

export async function seedArenaCodexLogin(
  root: string,
  realHome = process.env.HOME,
) {
  if (!realHome) return false;
  const destination = resolve(root, "runtime/auth/codex/.codex/auth.json");
  const existing = await lstat(destination).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (existing) return false;
  try {
    return await copyLogin(
      resolve(realHome, ".codex", "auth.json"),
      destination,
      realHome,
      root,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /must be a regular file inside its profile/.test(error.message)
    )
      return false;
    throw error;
  }
}

export async function prepareCodexHome(
  root: string,
  home: string,
  auth = true,
) {
  const codexHome = resolve(home, ".codex");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  if (auth) {
    await withLoginLock(root, async () => {
      await seedArenaCodexLogin(root);
      await copyLogin(
        resolve(root, "runtime/auth/codex/.codex/auth.json"),
        resolve(codexHome, "auth.json"),
        root,
        home,
      );
      loginSnapshots.set(
        home,
        await loginFingerprint(resolve(codexHome, "auth.json"), home),
      );
    });
  }
  await writeFile(resolve(codexHome, "config.toml"), config, {
    mode: 0o600,
    flag: "wx",
  });
  return codexHome;
}

export async function retainCodexLogin(root: string, home: string) {
  await withLoginLock(root, async () => {
    // Homes not prepared by this process cannot establish a safe baseline.
    if (!loginSnapshots.has(home)) return;
    const source = resolve(home, ".codex/auth.json");
    const destination = resolve(root, "runtime/auth/codex/.codex/auth.json");
    const baseline = loginSnapshots.get(home);
    const updated = await loginFingerprint(source, home);
    if (!updated || updated === baseline) return;
    const current = await loginFingerprint(destination, root);
    if (current === updated) return;
    if (current !== baseline)
      throw new LoginRefreshConflict(
        "Concurrent Codex login refresh conflicted; saved login was preserved. Check authentication before resuming.",
      );
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await copyLogin(source, temporary, home, root);
      await rename(temporary, destination);
      loginSnapshots.set(home, updated);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  });
}

export function assertCodexProfile(value: any) {
  if (
    value?.features?.apps !== false ||
    value?.features?.plugins !== false ||
    value?.features?.hooks !== false ||
    value?.project_doc_max_bytes !== 0 ||
    Object.keys(value?.mcp_servers ?? {}).length
  )
    throw new Error(
      "Codex arena profile exposes extra integrations or instructions; startup paused",
    );
}

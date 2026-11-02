import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import type { Agent } from "../shared/types.js";
export class LoginRefreshConflict extends Error {}
const guards = new Map<string, LoginGuard>();
// Every host instance for this project/account shares the same in-process guard.
export function loginGuard(root: string, cli: Agent | "codex-2") {
  const key = `${resolve(root)}:${cli}`;
  let guard = guards.get(key);
  if (!guard) {
    guard = new LoginGuard();
    guards.set(key, guard);
  }
  return guard;
}
class LoginGuard {
  private queue: Promise<unknown> = Promise.resolve();
  private baselines = new Map<string, string | undefined>();
  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(operation);
    this.queue = next;
    return next;
  }
  prepare(
    home: string,
    copy: () => Promise<unknown>,
    fingerprint: () => Promise<string | undefined>,
  ) {
    return this.withLock(async () => {
      await copy();
      this.baselines.set(home, await fingerprint());
    });
  }
  retain(
    home: string,
    candidate: () => Promise<string | undefined>,
    saved: () => Promise<string | undefined>,
    write: () => Promise<unknown>,
  ) {
    return this.withLock(async () => {
      if (!this.baselines.has(home)) return;
      const baseline = this.baselines.get(home);
      const updated = await candidate();
      if (updated === undefined || updated === baseline) return;
      const current = await saved();
      if (current === updated) {
        this.baselines.set(home, updated);
        return;
      }
      if (current !== baseline)
        throw new LoginRefreshConflict(
          "Concurrent login refresh conflicted; saved login was preserved. Check authentication before resuming.",
        );
      await write();
      this.baselines.set(home, updated);
    });
  }
}
async function stat(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}
async function assertInside(path: string, root: string) {
  const inner = relative(root, path);
  // The realpath comparison only rules out symlinks; a "../" path with no
  // links would pass it, so containment is checked lexically as well.
  if (
    inner === ".." || inner.startsWith(`..${sep}`) || isAbsolute(inner) ||
    (await realpath(path)) !== resolve(await realpath(root), inner)
  )
    throw new Error("Login path must stay inside its profile");
}
export async function fingerprintFile(path: string, root: string) {
  const info = await stat(path);
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Login path must be a regular file inside its profile");
  await assertInside(path, root);
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
type LoginEntryFilter = (path: string, directory: boolean) => boolean;
export async function loginFiles(
  home: string,
  roots: readonly string[],
  include: LoginEntryFilter,
  allowedRoot = home,
) {
  const files: string[] = [];
  const walk = async (path: string) => {
    const info = await stat(path);
    if (!info || info.isSymbolicLink()) return;
    await assertInside(path, allowedRoot);
    const name = relative(home, path);
    if (!include(name, info.isDirectory())) return;
    if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort())
        await walk(resolve(path, child));
    } else if (info.isFile()) files.push(name);
  };
  for (const name of roots) await walk(resolve(home, name));
  return files.sort();
}
export async function fingerprintTree(
  home: string,
  roots: readonly string[],
  include: LoginEntryFilter,
  allowedRoot = home,
) {
  const hash = createHash("sha256");
  for (const name of await loginFiles(home, roots, include, allowedRoot))
    hash.update(name).update("\0")
      .update((await fingerprintFile(resolve(home, name), allowedRoot)) ?? "missing")
      .update("\0");
  return hash.digest("hex");
}
// Stage next to the destination, then rename: readers never see half a file.
export async function copyLoginFile(
  source: string,
  destination: string,
  sourceRoot: string,
  destinationRoot: string,
) {
  const info = await stat(source);
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Login path must be a regular file inside its profile");
  await assertInside(source, sourceRoot);
  const existing = await stat(destination);
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error("Login destination must be a regular file");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await assertInside(dirname(destination), destinationRoot);
  await writeFileAtomic(destination, await readFile(source), 0o600);
  return true;
}

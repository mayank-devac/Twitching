import { lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

export const DISK_SOFT_BYTES = 520 * 1024 * 1024;
export const DISK_HARD_BYTES = 1024 * 1024 * 1024;

const ROOTS = ["runtime/workspaces", "runtime/native-workspaces"] as const;
const AGENTS = ["codex", "cursor"] as const;

async function entries(dir: string) {
  return readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
}

async function treeSize(dirs: string[]) {
  let total = 0;
  const walk = async (dir: string) => {
    for (const name of await entries(dir)) {
      const path = resolve(dir, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(path);
      else total += info.size;
    }
  };
  for (const dir of dirs) await walk(dir);
  return total;
}

async function removeTmp(dir: string) {
  let removed = 0;
  for (const name of await entries(dir)) {
    const path = resolve(dir, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) continue;
    if (!info.isDirectory()) continue;
    if (name === ".tmp") {
      await rm(path, { recursive: true, force: true });
      removed++;
      continue;
    }
    removed += await removeTmp(path);
  }
  return removed;
}

function archiveAgent(root: string, base: string, agent: string) {
  return resolve(root, "runtime/archive", base.slice("runtime/".length), agent);
}

async function moveOlderRounds(sourceAgent: string, archiveAgent: string) {
  const names = (await entries(sourceAgent)).filter((name) => /^\d+$/.test(name));
  if (names.length < 2) return 0;
  const newest = Math.max(...names.map(Number));
  let moved = 0;
  for (const name of names) {
    if (Number(name) === newest) continue;
    const source = resolve(sourceAgent, name);
    const dest = resolve(archiveAgent, name);
    await mkdir(archiveAgent, { recursive: true, mode: 0o700 });
    await rm(dest, { recursive: true, force: true });
    await rename(source, dest);
    moved++;
  }
  return moved;
}

async function archivedRounds(archive: string) {
  const found: { path: string; mtimeMs: number }[] = [];
  for (const base of ROOTS) {
    for (const agent of AGENTS) {
      const dir = resolve(archive, base.slice("runtime/".length), agent);
      for (const name of await entries(dir)) {
        if (!/^\d+$/.test(name)) continue;
        const path = resolve(dir, name);
        const info = await stat(path).catch(() => undefined);
        if (info?.isDirectory()) found.push({ path, mtimeMs: info.mtimeMs });
      }
    }
  }
  return found.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export async function enforceDiskBudget(
  root: string,
  limits: { soft?: number; hard?: number } = {},
) {
  const soft = limits.soft ?? DISK_SOFT_BYTES;
  const hard = limits.hard ?? DISK_HARD_BYTES;
  const live = ROOTS.map((base) => resolve(root, base));
  const archive = resolve(root, "runtime/archive");
  const sizeOf = async () =>
    (await treeSize(live)) + (await treeSize([archive]));
  let deletedTmp = 0;
  for (const dir of [...live, archive]) deletedTmp += await removeTmp(dir);
  let size = await sizeOf();
  if (size <= soft) return { size, deletedTmp, moved: 0, deletedArchive: 0 };

  let moved = 0;
  if (size > soft) {
    for (const base of ROOTS) {
      for (const agent of AGENTS)
        moved += await moveOlderRounds(
          resolve(root, base, agent),
          archiveAgent(root, base, agent),
        );
    }
    size = await sizeOf();
  }
  if (size <= hard) return { size, deletedTmp, moved, deletedArchive: 0 };

  let deletedArchive = 0;
  for (const round of await archivedRounds(archive)) {
    if ((await sizeOf()) <= hard) break;
    await rm(round.path, { recursive: true, force: true });
    deletedArchive++;
  }
  return { size: await sizeOf(), deletedTmp, moved, deletedArchive };
}

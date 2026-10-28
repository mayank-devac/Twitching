import { lstat, readdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Agent } from "../shared/types.js";

const PROBE_NAME = /^(check|rpc)-[0-9a-f-]{36}$/i;
const ROUND_NAME = /^\d+$/;
const AGENTS: Agent[] = ["codex", "cursor"];
const WORKSPACE_ROOTS = [
  "runtime/native-workspaces",
  "runtime/workspaces",
] as const;

export function isProbeWorkspaceName(name: string) {
  return PROBE_NAME.test(name);
}

/** Remove one finished probe workspace, including generated .git and .cli-home. Round dirs such as `1/` are never touched. */
export async function removeProbeWorkspace(dir: string) {
  const name = basename(dir);
  if (!isProbeWorkspaceName(name) || ROUND_NAME.test(name)) return false;
  const stat = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  await rm(dir, { recursive: true });
  return true;
}

export async function cleanupProbeWorkspaces(
  root: string,
  options: { dryRun?: boolean } = {},
) {
  const removed: string[] = [];
  const skipped: string[] = [];

  for (const base of WORKSPACE_ROOTS) {
    for (const agent of AGENTS) {
      const agentDir = resolve(root, base, agent);
      const entries = await readdir(agentDir).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [] as string[];
          throw error;
        },
      );
      for (const entry of entries) {
        if (ROUND_NAME.test(entry) || !isProbeWorkspaceName(entry)) continue;
        const path = resolve(agentDir, entry);
        if (options.dryRun) {
          const stat = await lstat(path).catch(() => undefined);
          if (stat?.isDirectory() && !stat.isSymbolicLink()) removed.push(path);
          else skipped.push(path);
          continue;
        }
        if (await removeProbeWorkspace(path)) removed.push(path);
        else skipped.push(path);
      }
    }
  }

  return { removed, skipped };
}

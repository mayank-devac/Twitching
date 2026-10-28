import { cp, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Agent } from "../shared/types.js";

const AGENTS: Agent[] = ["codex", "cursor"];
const DOCKER_WORKSPACE_ROOTS = [
  "runtime/workspaces",
  "runtime/archive/workspaces",
] as const;

export interface SandboxResult {
  agent: Agent;
  round: number;
  dir: string;
  archived: boolean;
  exported: boolean;
}

export type SandboxResultSelection = "all" | number[];

export function parseSandboxResultSelection(
  answer: string,
  resultCount: number,
): SandboxResultSelection | undefined {
  const input = answer.trim();
  if (input.toLowerCase() === "a") return "all";
  const values = input.split(",").map((value) => value.trim());
  if (!values.length || values.some((value) => !/^\d+$/.test(value)))
    return undefined;
  const selected = [...new Set(values.map(Number))];
  if (selected.some((value) => value < 1 || value > resultCount))
    return undefined;
  return selected.map((value) => value - 1);
}

async function entries(dir: string) {
  return readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
}

export async function sandboxPromptPath(
  dir: string,
  round: number,
  required: boolean,
) {
  const path = resolve(dir, `prompt_${round}.html`);
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (!required && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000)
    throw new Error("Output missing, unsafe, or larger than 2 MB");
  if (
    (await realpath(path)) !==
    resolve(await realpath(dir), `prompt_${round}.html`)
  )
    throw new Error("Output path must not be a link");
  return path;
}

export function sandboxResultPath(root: string, agent: Agent, round: number) {
  return resolve(
    root,
    "runtime/sandbox_results",
    agent,
    `prompt_${round}.html`,
  );
}

export async function preserveSandboxResult(
  root: string,
  agent: Agent,
  round: number,
  dir: string,
) {
  const path = await sandboxPromptPath(dir, round, false);
  if (!path) return false;
  const destination = sandboxResultPath(root, agent, round);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await cp(path, destination);
  return true;
}

export async function availableSandboxResults(root: string) {
  const found: SandboxResult[] = [];
  const seen = new Set<string>();
  for (const [index, base] of DOCKER_WORKSPACE_ROOTS.entries()) {
    for (const agent of AGENTS) {
      const agentDir = resolve(root, base, agent);
      for (const name of await entries(agentDir)) {
        if (!/^\d+$/.test(name)) continue;
        const dir = resolve(agentDir, name);
        const dirStat = await lstat(dir).catch(() => undefined);
        if (!dirStat?.isDirectory() || dirStat.isSymbolicLink()) continue;
        const round = Number(name);
        const key = `${agent}:${round}`;
        if (seen.has(key)) continue;
        try {
          if (!(await sandboxPromptPath(dir, round, false))) continue;
        } catch {
          continue;
        }
        const exported = await lstat(sandboxResultPath(root, agent, round))
          .then((stat) => stat.isFile() && !stat.isSymbolicLink())
          .catch(() => false);
        found.push({
          agent,
          round,
          dir,
          archived: index === 1,
          exported,
        });
        seen.add(key);
      }
    }
  }
  return found.sort(
    (a, b) => b.round - a.round || a.agent.localeCompare(b.agent),
  );
}

export async function preserveUnexportedSandboxResults(
  root: string,
  results: SandboxResult[],
) {
  return preserveSelectedSandboxResults(
    root,
    results.filter((result) => !result.exported),
  );
}

export async function preserveSelectedSandboxResults(
  root: string,
  results: SandboxResult[],
) {
  const saved: SandboxResult[] = [];
  const failed: SandboxResult[] = [];
  for (const result of results) {
    try {
      if (
        await preserveSandboxResult(
          root,
          result.agent,
          result.round,
          result.dir,
        )
      )
        saved.push(result);
      else failed.push(result);
    } catch {
      failed.push(result);
    }
  }
  return { saved, failed };
}

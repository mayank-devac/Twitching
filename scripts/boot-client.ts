// Owns the launchers' side of the /api/boot handshake and source-freshness checks.
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { bootResponseSchema, type BootResponse } from "../shared/boot.js";

// The server reports this hash so a launcher only ever attaches to its own checkout.
export const rootIdentity = (root: string) =>
  createHash("sha256").update(root).digest("hex");

// Newest mtime of any source file that would change what a build or server serves.
export async function newestSource(folder: string): Promise<number> {
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

// Network and JSON failures propagate; a foreign or malformed body reads as an
// empty identity so callers report "another app on this port" instead of crashing.
export async function fetchBoot(
  origin: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<BootResponse> {
  const response = await fetchImpl(`${origin}/api/boot`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return {};
  const parsed = bootResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : {};
}

// Same process and same startup contract: guards a restart against a server swap.
export const sameBoot = (a: BootResponse, b: BootResponse) =>
  a.rootId === b.rootId &&
  a.startedAt === b.startedAt &&
  a.configurationId === b.configurationId;

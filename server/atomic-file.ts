import { randomUUID } from "node:crypto";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

// Runtime files live in agent-writable or crash-prone folders. Stage under an
// unguessable sibling name with "wx" (never follows a planted file), fix the
// mode regardless of umask, then rename: rename replaces a link instead of
// following it, and readers never see half a file.
const staged = (path: string) =>
  resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);

export async function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o600) {
  const temporary = staged(path);
  try {
    await writeFile(temporary, data, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

// For the few writers that must finish before a synchronous call returns.
export function writeFileAtomicSync(path: string, data: string | Uint8Array, mode = 0o600) {
  const temporary = staged(path);
  try {
    writeFileSync(temporary, data, { mode, flag: "wx" });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Already renamed into place.
    }
  }
}

import { existsSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { copyLoginFile, fingerprintFile, loginGuard } from "./login-guard.js";

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

// A second Codex account lives in runtime/auth/codex-2 and is used by session-2
// only once that folder exists (npm run sandbox:login:codex -- 2). Otherwise
// every Codex session shares runtime/auth/codex, as before.
export function codexAccount(root: string, session?: string) {
  return session === "session-2" && existsSync(resolve(root, "runtime/auth/codex-2"))
    ? "codex-2"
    : "codex";
}
const codexAuthFile = (root: string, account: string) =>
  resolve(root, "runtime/auth", account, ".codex/auth.json");

// This Mac's own Codex login (`codex login`), or undefined when there is none
// or it is not a plain file. Only its presence is checked here.
export async function hostCodexLogin(realHome = process.env.HOME) {
  if (!realHome) return undefined;
  const path = resolve(realHome, ".codex", "auth.json");
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return info?.isFile() && !info.isSymbolicLink() ? path : undefined;
}

// Copies the host login into the arena profile, only when the user chose
// that in `npm run sandbox:login:codex`. Runs never copy it on their own: the
// copy shares one refresh token with the host, and Codex rotates it on
// refresh, so either side can sign the other out.
export async function copyHostCodexLogin(root: string, realHome = process.env.HOME) {
  if (!realHome || !(await hostCodexLogin(realHome))) return false;
  return copyLoginFile(
    resolve(realHome, ".codex", "auth.json"),
    codexAuthFile(root, "codex"),
    realHome,
    root,
  );
}

export async function prepareCodexHome(
  root: string,
  home: string,
  auth = true,
  session?: string,
) {
  const codexHome = resolve(home, ".codex");
  const account = codexAccount(root, session);
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  // The home is agent-writable and reused; never write through a planted link.
  if (!(await lstat(codexHome)).isDirectory())
    throw new Error("Codex profile must be a real directory");
  if (auth) {
    await loginGuard(root, account).prepare(home, async () => {
      await copyLoginFile(codexAuthFile(root, account), resolve(codexHome, "auth.json"), root, home);
    }, () => fingerprintFile(resolve(codexHome, "auth.json"), home));
  }
  // Session workspaces are reused for every prompt, so the profile is rewritten
  // on each launch (an exclusive create failed from the second prompt on); this
  // also resets anything the agent changed. The atomic write never follows a
  // planted link.
  await writeFileAtomic(resolve(codexHome, "config.toml"), config);
  return codexHome;
}

export async function retainCodexLogin(root: string, home: string, session?: string) {
  const source = resolve(home, ".codex/auth.json");
  const account = codexAccount(root, session);
  const destination = codexAuthFile(root, account);
  await loginGuard(root, account).retain(home,
    () => fingerprintFile(source, home),
    () => fingerprintFile(destination, root),
    () => copyLoginFile(source, destination, home, root));
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

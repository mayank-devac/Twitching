import { lstat, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
    return await copyLoginFile(
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
    await loginGuard(root, "codex").prepare(home, async () => {
      await seedArenaCodexLogin(root);
      await copyLoginFile(resolve(root, "runtime/auth/codex/.codex/auth.json"), resolve(codexHome, "auth.json"), root, home);
    }, () => fingerprintFile(resolve(codexHome, "auth.json"), home));
  }
  await writeFile(resolve(codexHome, "config.toml"), config, {
    mode: 0o600,
    flag: "wx",
  });
  return codexHome;
}

export async function retainCodexLogin(root: string, home: string) {
  const source = resolve(home, ".codex/auth.json");
  const destination = resolve(root, "runtime/auth/codex/.codex/auth.json");
  await loginGuard(root, "codex").retain(home,
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

# A3 — An ExecutionHost interface instead of `NativeHost extends Docker`

Status: not started. Line references are as of commit `087ec79`; re-check them before editing.

## Goal

Make "where an agent CLI runs" an explicit interface with two independent implementations (Docker container, native process group), and move per-CLI home, login and argv details into the CLI adapters. Today `NativeHost` inherits from `Docker` and overrides almost everything, so a new Docker method silently becomes available (and wrong) on the native host. No change to isolation, consent, login retention or disk budget behaviour.

## Current state

- `server/docker.ts` (365 lines), class `Docker` (line 96). Methods used as the execution host: `executionBoundary` (97), `name` (115), `workspace` (118), `args` (153, Docker-only), `create` (182), `attach` (222), `stop` (228), `recover` (247), `inspect` (265), `capture` (279), `codexInfo` (293), `retainAuth` (339), `preserveOutput` (355), `output` (358).
- `server/native-host.ts` (461 lines), `class NativeHost extends Docker` (line 50). It calls `super(store, { root, image: "" })` (line 56) and overrides `name`, `workspace`, `inspect`, `create`, `attach`, `stop`, `recover`, `capture` and `retainAuth`. It inherits `codexInfo`, `preserveOutput` and `output` unchanged, and inherits `args`/`command` that make no sense natively.
- Per-CLI branches inside the hosts instead of the adapters:
  - Docker: `workspace()` codex vs cursor login seeding (lines 130–150), `retainAuth()` (lines 341–352), `CURSOR_LOGIN_ROOTS` / `cursorRetainEntry` (lines 31–38);
  - Native: codex help/coding detection (lines 176–183), Codex sandbox flag swap (lines 198–202), prompt path rewrite (lines 205–214), `sessionEnv()` codex vs cursor homes (lines 228–250), Cursor login copy and keychain link (lines 251–297), Codex retain in `stop()` (line 378) and `retainAuth()` (lines 450–460).
- `Docker` is the parameter type for hosts in `server/runner.ts:111`, `server/sessions/service.ts:78` (`Record<RunnerMode, Docker>`), `server/cli/types.ts:25–26` (`check(host: Docker)`, `discover(host: Docker)`), plus the launcher (`scripts/stream.ts:113`, `scripts/stream/sandbox.ts`, `scripts/stream/prerequisites.ts`).
- `server/browser-sandbox.ts:18` also takes a `Docker`, but for previews. Previews always run in Docker, even in native mode; that must stay true.
- Tests: `tests/native-host.test.ts` (407 lines), `tests/login-guard.test.ts`, `tests/codex-profile.test.ts`, `tests/single-cli.test.ts` (fake hosts), `tests/sandbox.test.ts` (real Docker, opt-in).

## Target design

```ts
// server/execution-host.ts
export interface ExecutionHost {
  readonly boundary: RunnerMode;                 // "docker" | "native"
  workspace(req: WorkspaceRequest): Promise<string>;
  create(cli: Agent, round: number | string, argv: string[], opts: CreateOptions): Promise<{ name: string; dir: string }>;
  attach(name: string): ChildProcessWithoutNullStreams;
  stop(name: string): Promise<void>;
  recover(): Promise<void>;
  inspect(clis: readonly Agent[]): Promise<void>;
  capture(cli: Agent, argv: string[]): Promise<string>;
  retainAuth(cli: Agent, dir: string, opts: { discardHome?: boolean }): Promise<void>;
  preserveOutput(session: SessionId, round: number, dir: string): Promise<unknown>;
  output(session: SessionId, round: number, dir: string): Promise<void>;
}
```

- `DockerHost implements ExecutionHost` (the current `Docker` minus preview helpers) and `NativeHost implements ExecutionHost` (no inheritance). Shared pieces become plain functions: `codexInfo(host)` (built on `capture`/`attach`), `preserveSandboxResult`, `sandboxPromptPath`, `enforceDiskBudget`, `assertRealDirectory`.
- Per-CLI concerns move into the adapters (`server/cli/codex.ts`, `server/cli/cursor.ts`) behind a small `CliProfile` part of `CliAdapter`:
  - `seedHome(boundary, root, home)` and `retainLogin(boundary, root, home)`;
  - `nativeArgv(argv)` (Codex `--sandbox=workspace-write` swap; Cursor unchanged);
  - `nativeEnv(home)` (HOME, CODEX_HOME, XDG paths).
- `CliAdapter.check/discover` take `ExecutionHost`.
- `BrowserSandbox` keeps a dedicated Docker client (e.g. `DockerCli` with `command()`), not an `ExecutionHost`.
- Approval stays a per-run argument (`RunApproval`), checked only by `NativeHost`.

## Migration steps

1. **Contract tests first** (`tests/execution-host.test.ts`, new): one shared suite run against a fake Docker command runner and against `NativeHost` with a stub process spawner, covering `workspace` (real directory, refuses a planted symlink), `create` → `attach` → `stop`, `recover` (stops recorded names, calls the disk budget), `retainAuth` with and without `discardHome`, and that native coding runs without approval throw.
2. Add the `ExecutionHost` interface and make `Docker` declare `implements ExecutionHost`. Change type annotations in `server/runner.ts`, `server/sessions/service.ts` and `server/cli/types.ts` to `ExecutionHost`. No behaviour change.
3. Move `codexInfo` to a function over `ExecutionHost`; delete it from the class.
4. Move Codex/Cursor home seeding and retention into the adapters, Docker first (lines 130–150, 341–352), then native (228–297, 378, 450–460). One CLI per commit.
5. Move the native argv swap (lines 198–202) into the Codex adapter. Coordinate the prompt path rewrite (lines 205–214) with A2 step 6.
6. Remove `extends Docker` from `NativeHost`; give it its own `name()` (keep the `native-` prefix so recovery still finds old records) and its own store usage.
7. Split preview-only Docker commands used by `BrowserSandbox` and the launcher into a `DockerCli` helper; rename `Docker` to `DockerHost`.

## Risks

- Login handling is security-sensitive: symlink refusal, the login guard fingerprints, Cursor `auth.json`-only retention, and deleting login copies after arena rounds (D1/D2 fixes) must all survive the move. Keep `tests/login-guard.test.ts` green at every step.
- Container and process names are persisted (`containers` table) and used for recovery after a crash. Names must not change.
- Native consent must stay enforced in `NativeHost.create` (launcher `ARENA_NATIVE_APPROVED` or per-run approval).
- Previews must never switch to a native browser.

## How to verify

- `npm run check`, `npm test` (with permission).
- `STRAM_SANDBOX_TEST=1 npx tsx --test tests/sandbox.test.ts` with images built.
- `./check_stream_start.sh --mode rehearsal --runner docker --verify` and `--runner native --verify`, then one private round per runner. Confirm a restart recovers (stops) a leftover container/process.

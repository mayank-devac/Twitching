# D1 — Keep CLI logins out of the agent-writable workspace (steps 2–3) and rotate logins

Status: step 1 is done; steps 2–3 are not started and need a live Codex and Cursor run to prove. Line references are as of commit `087ec79`; re-check them before editing.

Agents working on this plan: never open `runtime/auth/`, any `.home/` or `.cli-home/` folder, `.env.local` or CLI credential files (see `AGENTS.md`). Use fingerprints, file modes and existence checks in tests; ask Mayank for sanitized diagnostics from live runs.

## Goal

A coding agent should not find its CLI's login token inside the folder it is told to work in, and should not be able to change the saved login. Today the token is copied into the workspace's `.home` for every run.

## What is already done (step 1)

- Commit `1a0d066`: after a finished arena round, `retainAuth(..., { discardHome: true })` deletes `<round>/.home` (Docker) or `<round>/.cli-home` (native) once the refreshed login is saved back (`server/docker.ts:335–353`, `server/native-host.ts:450–460`, `server/runner.ts:357–360`). A failed retain keeps the copy, because a rotated refresh token may exist only there.
- `server/disk-budget.ts:63–65` removes `.home`/`.cli-home` before archiving a round folder.
- Commit `49e1f4d` (D2): only Cursor's `auth.json` flows back from the agent home (`cursorRetainEntry`, `server/docker.ts:31–38`); config files are re-seeded from `runtime/auth/cursor` every run.
- Tests: `tests/login-guard.test.ts:70` (Cursor retains only `auth.json`) and `:90` (retained arena login discards `.home`; failed retain keeps it).

## Current state (what remains)

- Docker image (`sandbox/Dockerfile:23`): `HOME=/workspace/.home`, `CODEX_HOME=/workspace/.home/.codex`, `XDG_CONFIG_HOME=/workspace/.home/.config`. The workspace is one read-write bind mount at `/workspace` (`server/docker.ts:153–181`, `args()`), so the login is inside the agent's working folder for the whole run.
- Seeding: Codex via `prepareCodexHome()` (`server/codex-profile.ts:61–83`) copies `runtime/auth/codex/.codex/auth.json` into `<dir>/.home/.codex/auth.json`; Cursor via `Docker.workspace()` (`server/docker.ts:134–145`) copies the whole `runtime/auth/cursor` tree into `<dir>/.home`.
- Retention reads the refreshed token back from that same folder (`retainCodexLogin`, `server/codex-profile.ts:85–92`; Cursor branch of `Docker.retainAuth`).
- Session workspaces (`workspaceKey`, `server/runner.ts:192–193`) are reused across prompts and keep their `.home` on purpose.
- Logins are created by `scripts/login.ts`, which bind-mounts `runtime/auth/<cli>` at `/workspace/.home` inside a one-off container.
- Native mode: `.cli-home` in the native workspace (`server/native-host.ts:62–81`, `228–297`). A native agent runs as your user and can read `~/.codex` and `~/.cursor` directly, so moving the copy gains little there; this plan targets Docker mode.

## Honest limit

Inside one container the CLI and the commands it runs share a user. Anything the CLI can read, an agent's shell command can read too, wherever it is mounted. Moving the login out of `/workspace` and mounting it read-only stops: accidental exposure through workspace files, diffs, archives and exported results; agent edits to the saved login; and copies piling up. It does **not** stop a determined agent from reading the token during the run. Fully hiding the token would need a credential broker (for example, the egress proxy injecting the auth header), which is a separate design.

## Target design

- **Step 2 — login outside the workspace.** Each run gets a host folder outside the workspace, e.g. `runtime/run-auth/<container-name>/`, seeded exactly as `.home` is today. It is bind-mounted at a path outside `/workspace` (e.g. `/run/arena-home`). The image sets `CODEX_HOME=/run/arena-home/.codex` and Cursor's config root to `/run/arena-home`; `HOME` and caches stay in `/workspace/.home` but hold no login. Retention reads from the run-auth folder, then deletes it. `recover()` deletes leftover run-auth folders for names it stops.
- **Step 3 — read-only login.** If live runs prove both CLIs work for a whole round with an unwritable login file, mount the login read-only (`readonly` bind option, or a read-only file bind for `auth.json` inside a writable `CODEX_HOME`). Arena rounds then skip retention (nothing can change). Token refresh happens only in trusted host-driven containers (login and the model/quota probe) that mount the login read-write.
- If either CLI must refresh during a round, keep that CLI on step 2 (writable mount outside the workspace) and record why in this file.

## Migration steps

1. **Tests first** (no live account needed):
   - `tests/login-guard.test.ts`: the run-auth folder is created with mode `0700`, refused if it is a symlink, retained from, and deleted after a successful retain; kept after a conflicting retain.
   - `tests/docker-args.test.ts` (new): `Docker.args()` includes the extra mount, outside `/workspace`, with `readonly` when step 3 is enabled; the workspace mount is unchanged.
   - Extend the opt-in `tests/sandbox.test.ts` (`STRAM_SANDBOX_TEST=1`): inside a real container, no file named `auth.json` exists under `/workspace`, and writing to the login mount fails when read-only.
2. Add the run-auth folder and mount (Docker only), seed it instead of `.home`, and change `retainAuth` to read from it. Update `sandbox/Dockerfile` env paths. Keep session runs working: give a session one run-auth folder per conversation that is reused across prompts and deleted when the session's runner is recovered.
3. Update `scripts/login.ts` to mount `runtime/auth/<cli>` at the new path, so login and runs agree.
4. **Live proof (Mayank, private rehearsal):** one Codex round and one Cursor round on Docker. Report: round succeeded; refreshed login retained (the app reports no "Shared login changed"); `find runtime/workspaces -name auth.json` prints nothing during and after the round.
5. Read-only experiment behind a setting (default off). Mayank runs a long round (longer than the CLI's token lifetime if known) for each CLI with it on. If both pass, turn it on by default; otherwise document the failing CLI here.
6. Remove `.home` login seeding code paths that are no longer used.

## Rotating the logins

Before commit `1a0d066`, every finished arena round left a full login copy in its workspace and archives, and every round's agent could read the token. If live rounds with viewer prompts have run, rotate both logins once. Mayank runs these steps; agents must not open the files involved.

1. Stop the app (Ctrl+C in the launcher terminal) so no round is running.
2. Remove leftover copies without reading them:
   ```sh
   find runtime/workspaces runtime/native-workspaces runtime/archive -type d \( -name .home -o -name .cli-home \) -prune -exec rm -rf {} +
   ```
   Saved session workspaces simply re-seed their login on the next prompt.
3. Invalidate the old sessions at the provider: sign out of other sessions or devices from the ChatGPT/Codex and Cursor account pages, where the provider offers it.
4. Sign in again: `npm run sandbox:login:codex` and `npm run sandbox:login:cursor` (Docker). For native mode, use the CLIs' own logout/login commands (`codex login`, `cursor-agent login`).
5. Run `./check_stream_start.sh --mode rehearsal --verify` to confirm both logins and models.

Repeat the rotation whenever a run log or a viewer report suggests a token was printed or sent anywhere.

## Risks

- A failed retain must still keep the only copy of a rotated refresh token; do not delete the run-auth folder on failure.
- `LoginRefreshConflict` handling (`server/login-guard.ts:6`) must keep working when two sessions share one account.
- Changing image env paths needs `npm run sandbox:build`; old images with the old paths must fail loudly at startup (capability check), not silently write the login into `/workspace`.
- Session workspaces are long-lived; their run-auth folder lifecycle needs its own test.

## How to verify

- `npm run check`, `npm test` (with permission).
- `STRAM_SANDBOX_TEST=1 npx tsx --test tests/sandbox.test.ts` after `npm run sandbox:build`.
- The live proof in step 4, reported by Mayank with sanitized output only.

# A9 — Shared server wiring for the launcher, and typed StartupOverrides

Status: not started. Line references are as of commit `087ec79`; re-check them before editing.

## Goal

The guided launcher (`scripts/stream.ts`) and the control server (`server/index.ts`) each build their own store, hosts, runner, OBS client and redactor, and pass startup choices to each other through a dozen `ARENA_*` environment variables. Give both one wiring module, `server/compose.ts`, and one typed `StartupOverrides` object, so the two cannot drift. The redaction secret list has already drifted and is the most important part to fix.

## Current state

- `scripts/stream.ts` is now 226 lines (the checklist steps were split into `scripts/stream/`), but it still rebuilds server wiring at lines 97–125: dynamic imports of `Store`, `Docker`, `NativeHost`, `CliRunner`, `Obs`; its own `privateValues` list; `redactor(...)`; an in-memory `Store`; a runner host chosen by runner mode.
- `server/index.ts` builds the same pieces at lines 84 (`Store`), 149–174 (`privateValues`, Kick token tracking, `clean`), 182–185 (`Docker`, `NativeHost`, runner host, `CliRunner`).
- **Redaction drift** (privacy-relevant):
  - server list (`server/index.ts:149–160`): Jev key, YouTube access/refresh/secret, Twitch access/refresh/secret, Kick access/secret, OBS password; plus every Kick app token minted at runtime (lines 161–174);
  - launcher list (`scripts/stream.ts:102–109`): `Object.values(secrets.youtube)` and `Object.values(secrets.twitch)` (so it also hides client IDs, chat ID, broadcaster and bot user IDs), Kick access/secret, OBS — and no minted Kick tokens;
  - the secrets themselves are defined once in `server/config.ts:28–53`.
- Startup choices travel by environment variable:
  - set by the launcher: `scripts/stream.ts:35` (`ARENA_EXPERIENCE`), 63–64 (`ARENA_RUNNER`, `ARENA_MODE`), 82 (`ARENA_PROMPTS`), 168 (`ARENA_SESSIONS`); `scripts/stream/options.ts:131–150` (`ARENA_SESSIONS`, `ARENA_PROMPTS`, `ARENA_NO_PROMPTS`, `ARENA_SINGLE_AGENT`, `ARENA_SKIP_*`); `scripts/stream/show.ts:42–53` (child process env, including `ARENA_NATIVE_APPROVED`); `scripts/welcome-launcher.ts:90`;
  - read by the server: `server/startup-config.ts:87–110` (`resolveStartup`), `server/index.ts:115–135` (which flags were explicit), `server/native-host.ts:189` and `server/sessions/service.ts:406` (`ARENA_NATIVE_APPROVED`).
  - `server/config.ts` reads `settings.json` and `.env.local` at import time, which is why `scripts/stream.ts` must set env vars *before* importing it (comment at line 66).
- Chat skips are still three booleans (`skipYoutube/skipTwitch/skipKick`) in the launcher options and `startup-config.ts` (leftover from A11).
- The launcher and server are separate processes: `scripts/stream/show.ts` spawns `npm run dev`. Some boundary crossing is unavoidable.

## Target design

1. `server/secrets.ts`: `privateValues(secrets): string[]` and `createRedactor(secrets, root, mintedTokens?)`. Both processes use it. Decide once whether public IDs (client IDs, broadcaster IDs) are redacted; redacting more is acceptable, redacting less is not.
2. `server/compose.ts`: `composeCore({ root, settings, secrets, storePath })` returns `{ store, clean, docker, native, host, runner, obs? }`. `server/index.ts` uses it with `runtime/show.sqlite`; the launcher uses it with `:memory:`.
3. `StartupOverrides` in `server/startup-config.ts`:
   ```ts
   interface StartupOverrides {
     experience?: "welcome" | "session" | "arena";
     mode?: "live" | "rehearsal";
     runnerMode?: RunnerMode;
     sessions?: SessionConfig[];
     singleAgent?: Agent;
     prompts?: "force" | "ignore";
     chat?: Partial<Record<ChatPlatform, boolean>>;
     nativeApproved?: boolean;
   }
   ```
   with a zod schema. `resolveStartup(raw, overrides, root, playlist)` takes it instead of `process.env`. `server/config.ts` becomes a function (`loadConfig(overrides)`) instead of import-time globals.
4. Crossing the process boundary: the launcher serialises the overrides to one variable (`ARENA_STARTUP`, JSON) when spawning the server; the server parses it with the zod schema once. Keep reading the old variables for one release as a fallback so manual `ARENA_MODE=... npm run dev` still works, then remove.
5. `nativeApproved` reaches `NativeHost` and the sessions service as a constructor argument, not `process.env` (finishes S1).

## Migration steps

1. **Tests first**:
   - `tests/secrets.test.ts`: both the server and the launcher redactor hide every value in today's server list plus a minted Kick token; snapshot the list.
   - extend `tests/startup-config.test.ts`: for each current `ARENA_*` combination, `resolveStartup` gives the same settings when given the equivalent `StartupOverrides`.
   - extend `tests/http-boot.test.ts`: the boot `configurationId` is unchanged for the same choices.
2. Add `server/secrets.ts`; switch the server, then the launcher. This alone fixes the drift; ship it first.
3. Add `StartupOverrides` + schema; make `resolveStartup` accept it, with a small `overridesFromEnv(env)` adapter so callers do not change yet.
4. Turn `server/config.ts` into `loadConfig(overrides)`; keep a default export path for `server/index.ts` until step 6.
5. Launcher builds `StartupOverrides` directly from parsed options (`scripts/stream/options.ts`) instead of writing `process.env`; replace `exportChatSkips` with `chat` record.
6. Add `server/compose.ts`; move the wiring from `server/index.ts:84–185` and `scripts/stream.ts:97–125` into it.
7. Pass `ARENA_STARTUP` to the child in `scripts/stream/show.ts` and `scripts/welcome-launcher.ts`; pass `nativeApproved` explicitly to hosts and the sessions service; then remove the old variables and `overridesFromEnv`.

## Risks

- Privacy: a redactor with fewer values would leak to the stream. Step 1 tests must compare against the union of today's lists.
- `startupConfigurationId` decides whether an existing app matches the launcher's choices; any change in normalisation makes the launcher refuse a running app. Guard with tests.
- `server/config.ts` import-time side effects (chmod of `.env.local`, dotenv) move into a function; make sure they still run once before secrets are read. Never log or return the secrets object.
- `ARENA_NATIVE_APPROVED` is a consent gate. Removing the env path must not leave a route where native coding starts without consent.

## How to verify

- `npm run check`, `npm test` (with permission).
- `./check_stream_start.sh --mode rehearsal --verify` and `./start_stream.sh --mode rehearsal --runner docker --codex`; confirm `/api/boot` identity matches and the app is reused or refused as before.
- Start without flags (welcome launcher) and with `--runner native` (NATIVE prompt still required).

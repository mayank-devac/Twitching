# Twitching project rules

- Never open `.env.local`, `runtime/auth/`, workspace `.home/`, or CLI credential files. Ask Mayank for sanitized diagnostics when needed.
- Keep credentials server-only. Serve only `dist/`; never use the repository as a static root.
- Docker is the default agent boundary. Native agents require explicit opt-in through `start_stream.sh`.
- Tests/builds/type checks require permission unless explicitly included in the current request.

## Commands (only with permission, see above)

- `npm run check` — type check
- `npm test` — unit and integration tests in `tests/`
- `npm run build` — build `dist/`

## Where things live

`.agent/repo_map.md` is the detailed file map; verify it against the source. In short:

- `server/index.ts` wires the app; `server/controller.ts` runs arena rounds (options and pure round helpers in `server/controller/`).
- `server/runner.ts` drives CLI runs on `server/docker.ts` or `server/native-host.ts`; CLI adapters are in `server/cli/`.
- `server/store.ts` owns SQLite: single-row settings in the `documents` table, retention in `prune()`. Legacy one-row tables are a read-only backup; never write to them.
- `server/http.ts` plus `server/http-kit.ts` (host guard, error mapping) serve the JSON routes and the `/events` socket.
- `server/chat/` has one `ChatSource` per platform; `server/sessions/` owns coding sessions and named overlays.
- `shared/` holds types (`CLIS` in `shared/types.ts`), zod building blocks (`shared/schema.ts`) and the public visibility rules (`shared/visibility.ts`). Privacy changes go through `shared/visibility.ts` and `tests/visibility.test.ts`.
- `web/` is the React UI: `web/arena/`, `web/welcome/`, `web/settings/`, `web/overlays/`; Markdown only through `SafeMarkdown` in `web/markdown.tsx`; colours from `web/tokens.css`.
- `scripts/stream.ts` and `scripts/stream/` are the guided launcher; `scripts/boot-client.ts` is its `/api/boot` handshake.
- `plans/` holds deferred refactor plans; read the relevant one before a large change.

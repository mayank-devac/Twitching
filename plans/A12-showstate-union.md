# A12 — ShowState as a discriminated union, and a split socket payload

Status: not started. Line references are as of commit `087ec79`; re-check them before editing.

## Goal

`ShowState` is one interface with about 30 mostly optional fields that serves the arena, the coding-session overlays, the host desk and the public overlay at once. The session path has to fake an arena state to fit it. Split it into a discriminated union so each screen gets exactly the fields that exist in its mode, and split the `/events` payload into separate parts for arena, session overlay and presentation. Privacy and redaction must not get weaker.

## Current state

- `shared/types.ts:163–202` — `interface ShowState`. Required: `status`, `mode`, `reason`, `candidates`, `candidateCount`, `events`, `connections`, `checks`, `rehearsalComplete`. Everything else is optional: arena round data (`round`, `prepared`, `collectionDeadline`, `resultUntil`, `breakUntil`, `breakKind`, `manualBreak`, `quota`, `playlist*`, `awaitingHostChoice`, …), session data (`experience`, `sharedSession`, `sharedOverlay`), and host-only data (`hostContext`, `quickSettings`, `preparedVersion`).
- **Faked arena state for sessions**: `server/sessions/service.ts:330–355` (`snapshot()`) returns `status: "paused"`, empty `candidates`, `events`, `connections`, `checks` and a made-up `reason`, only so session overlays can travel as a `ShowState`.
- Server assembly of what is sent:
  - `server/controller/round-state.ts:56` `stateView()` (sanitises prompts and candidates, adds `quickSettings`, `sessions`, `agents`, `models`);
  - `server/http.ts:83–92` `publicState()` layers sessions, presentation hiding and `hostContext`;
  - `server/http.ts:114–115` `/api/host` merges `hostSnapshot()` with session data, calling `sessions.snapshot()` twice;
  - `server/http.ts:224–228` `wireState()` strips per-overlay data; `server/http.ts:259–289` `broadcast()` builds patches for arena events, the single shared session and overlay frames from one merged state.
- Wire messages: `shared/server-message.ts` (`SnapshotMessage` / `UpdateMessage` both carry `state: ShowState` plus several patch arrays; `isShowState` validates only a few fields).
- Client merges: `web/show-state.ts` (`applySnapshot`, `applyUpdate`, `hostContextKey`) and `web/use-show-state.ts`. Screens branch on `state.experience` (`web/main.tsx:72,79,95`) and on `sharedOverlay`.
- Persistence: the controller's own `ShowState` is saved as the `state` document (`server/store.ts:233–245`) and read back in the `Controller` constructor (`server/controller.ts:222`). Its stored shape must stay readable.
- Consumers: about 25 files import `ShowState` (`server/*`, `shared/*`, `web/*`, `web/arena/*`, `web/settings/*`, and tests `store`, `controller-split`, `host-refresh`, `session-publication`, `presentation`, `visibility`).

## Target design

```ts
// shared/show.ts
type ArenaPhase = "stopped" | "paused" | "collecting" | "running" | "results" | "break";
interface ArenaView {        // what the controller owns and persists (today's ShowState minus session/host extras)
  status: ArenaPhase; mode; reason; round?; prepared?; ...;
}
type BreakInfo =
  | { kind: "none" }
  | { kind: "quota"; until: number }
  | { kind: "manual"; until?: number; durationMs: number | null };
type PublicView =
  | { experience: "arena"; arena: ArenaView; presentation?: Presentation }
  | { experience: "session"; overlay: OverlayView; presentation?: Presentation }
  | { experience: "welcome"; presentation?: Presentation };
interface HostView { public: PublicView; host: { hostContext: number; quickSettings?; preparedVersion?; lanes: Activity[] } }
```

- Socket frames become `{ type: "snapshot" | "update", view: PublicView, patches: { arena?: ActivityPatch[]; overlay?: OverlayFramePatch[] } }`. The single-session special case (`sharedSession`) disappears: one overlay frame is just an overlay with one frame.
- The persisted `state` document keeps today's controller shape (`ArenaView` is a rename of the fields it already has); no data migration is needed if `ArenaView` stays field-compatible. If a field is renamed, add a read-time upgrade in `Store.state()`.
- `break`-related optional fields collapse into `BreakInfo` only in the wire/view types first; the controller can keep its fields until A1 lands.

## Migration steps

1. **Tests first**:
   - `tests/show-wire.test.ts` (new): golden JSON of snapshot and update frames for arena (running round, results, quota break, manual break, hidden), single session overlay, multi-frame overlay, and welcome. Assert the public frames never contain private lanes, unredacted prompts or other overlays' assignments.
   - Extend `tests/host-refresh.test.ts` for `applySnapshot` / `applyUpdate` with the same scenarios.
2. Add the new types next to `ShowState` plus pure converters `toPublicView(state)` and `fromPublicView(view)` (the latter only for the transition). Unit-test round trips.
3. Server: build `PublicView` in one function that replaces the `publicState` + `wireState` pair; still send the old `ShowState` frame (converted) so the client is unchanged.
4. Stop faking arena fields in `server/sessions/service.ts:330–355`: return an `OverlayView` and let the view builder wrap it.
5. Introduce the new frame format behind a version field (`v: 2`) on the socket; update `shared/server-message.ts` parsing (with zod or the existing guards) and `web/show-state.ts`. Switch the client, then the server, then remove v1.
6. Move screens to narrow on `view.experience` (`web/main.tsx`, `web/arena/*`, `web/overlays/*`). Arena components receive `ArenaView`, never the union.
7. Replace `/api/host`'s double `sessions.snapshot()` call with one `HostView` builder.
8. Delete the leftover optional fields from `ShowState` (or remove `ShowState` and keep `ArenaView` as the persisted type).

## Risks

- Privacy: hidden overlays must still get no transcript, and a privacy change must still send a full snapshot before any patch (`server/http.ts:267–268`). Golden tests in step 1 must cover this.
- OBS browser sources keep a socket open for hours. During step 5 an old page may receive a new frame; the version field must make the old client reconnect cleanly rather than render garbage.
- The `/events` socket has `maxPayload: 1024` for client messages only; server frame size is unchanged, but check the 8 MB `bufferedAmount` cut-off is not hit by duplicated payloads during the transition.
- Large surface: keep each commit to one layer (types, server builder, wire, client, screens).

## How to verify

- `npm run check`, `npm test` (with permission).
- `npm run build`, then in private rehearsal: arena round on `/overlay`, a session on `/overlay` and on a named `/overlay/<id>`, Hide/Show one and all outputs, a break screen, reload of each page and of `/control`.

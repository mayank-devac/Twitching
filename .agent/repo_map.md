# Repository Map

Purpose: Route agents to the most relevant source files quickly. Verify details against current source before making changes.

## Quick Settings

`server/sessions/overlays.ts`, `shared/overlay-stream.ts`, `web/overlays/OverlayManager.tsx`, `web/overlays/use-overlay-editor.ts`, `web/overlays/OverlayScreen.tsx`, `web/overlays/overlays.css`, `tests/overlays.test.ts`

- Work: Own durable named output assignments, private checkbox drafts, server-enforced eight-session limits, fixed or automatic running selections, per-output OBS URLs and independent grid/history transport.
- Contains: `Overlays`, revision/epoch checks, `overlayPatches`, and `applyOverlayPatches`; providers are read through `Sessions.view`, then projected through the existing public visibility/redaction policy.
- Used by: `server/sessions/service.ts`, `server/sessions/http.ts`, `server/http.ts`, `server/store.ts`, `web/main.tsx` and the welcome session browser. Default output is `default`; named outputs use UUIDs. Selection is capped at eight IDs; up to 32 output definitions persist, with publication reset on startup.
- Limits: Automatic mode includes verified app-managed running conversations only; external Codex runtime stays unknown. The legacy single-session publish action replaces Main only. Session visibility is shared across outputs; assignments are independent. Never delete sessions to deduplicate repeated page rows.

`shared/sessions.ts`, `shared/timeline.ts`, `shared/safe-file-name.ts`, `server/sessions/service.ts`, `server/sessions/codex-history.ts`, `server/sessions/http.ts`

- Work: Separate provider history identity, managed workspaces, private preview and explicit filtered publication from HTML arena rounds. Codex history uses list/read/item APIs only; arbitrary passive live attachment and external Cursor history are explicitly unavailable.
- Contains: `Sessions`, `CodexHistory`, session capability declarations, bounded timeline pages, display-only old-run filtering and safe structured read names. `Store` owns conversation metadata and stable paginated fragments; legacy arena rows remain separate.
- Limits: Managed prompts are fresh processes sharing workspace files and bounded recent context; general completion never requires HTML. Optional HTML uses the existing isolated preview only after an explicit Result request. Tests in `tests/sessions.test.ts` include no-HTML completion and session-isolated history; execution requires authorization.

`scripts/welcome-launcher.ts`, `Start Twitching.command`, `web/welcome/Welcome.tsx`, `web/welcome/LaunchChoices.tsx`, `web/welcome/SessionBrowser.tsx`, `web/welcome/Timeline.tsx`, `web/welcome/welcome.css`

- Work: No-flag idle welcome startup, host readiness, managed/external session browser, settings reuse and ordinary scrolling. Existing CLI flags retain the guided arena flow.
- Used by: `scripts/stream.ts`, `web/main.tsx`, `server/index.ts`, `server/http.ts`. Settings changes retain revision checks; publication requires explicit selection and live rehearsal/OBS gates. Never run a model merely to observe an external session.

`server/startup-config.ts`, `scripts/session-selection.ts`

- Work: Normalize startup inputs through one public schema, identify immutable boot inputs before saved web preferences, and keep session flag parsing and interactive model selection out of the main stream script.
- Contains: `resolveStartup`, `normalizeStartup`, `selectStartupSessions`, `startupConfigurationId`, `parseSessionSpec`, `chooseSessions`.
- Used by: `server/config.ts`, `server/index.ts`, `scripts/stream.ts`, `tests/startup-config.test.ts`.

`server/login-guard.ts`, `server/cli/events.ts`

- Work: Share in-process account locks, login fingerprint/baseline checks and per-file atomic replacement; validate incoming CLI events before parsers or edit detection inspect them.
- Contains: `loginGuard`, `LoginRefreshConflict`, `copyLoginFile`, `fingerprintFile`, `fingerprintTree`, `parseCliEvent`, `CliEvent`.
- Used by: Docker/native Codex profiles, `server/runner.ts`, `server/activity.ts`, and the focused login/event tests.
- Limits: Login locks coordinate one process; Cursor multi-file retention is not a crash-safe transaction.

`tests/login-guard.test.ts`, `tests/cli-events.test.ts`, `tests/preview-size.test.ts`

- Work: Cover simultaneous Codex/Cursor refresh conflicts, failed-write lock recovery, malformed event handling, session helpers and explicit one/two-session preview sizes.
- Verification: Source fixtures added; execute only with Mayank's authorization.

`shared/settings.ts`, `server/quick-settings.ts`, `server/settings-http.ts`

- Work: Define safe durable host preferences, strict validation, revision conflicts and host/CSRF-protected settings/model/history/action routes.
- Useful for: Adding an allowlisted operational field, model discovery through existing CLI adapters, and settings save timing.
- Contains: `QuickPreferences`, `SessionVisibility`, `QuickSettings`, `settingsRoutes`.
- Used by: `server/index.ts`, `server/http.ts`, `server/controller.ts`, `web/settings/` and `tests/quick-settings.test.ts`.

`server/manual-break.ts`, `server/settings-view.ts`, `server/break-media.ts`

- Work: Keep optional manual timers and host-ended breaks distinct from quota recovery, filter public activity without deleting history, redact paginated history, and store/serve bounded approved media by opaque IDs.
- Useful for: Break cancellation/deadlines, safe public read names, and media traversal/symlink/format checks.
- Contains: `ManualBreakControls`, `publicActivity`, `historyView`, `BreakMedia`, `detectMedia`.
- Used by: `server/controller.ts`, `server/settings-http.ts` and the focused settings/controller tests.

`web/settings/QuickSettings.tsx`, `web/settings/SessionCard.tsx`, `web/settings/PreparedPrompt.tsx`, `web/settings/HistoryPanel.tsx`, `web/settings/BreakMedia.tsx`, `web/settings/ActionBar.tsx`, `web/settings/api.ts`, `web/settings/use-unsaved-warning.ts`, `web/settings/StreamSettings.tsx`, `web/settings/HarnessForm.tsx`, `web/settings/settings.css`, `web/break-screen.tsx`

- Work: Render the separate `/control/settings` host page, independent session cards, prompt/history panels, media selection, and explicit stream/break/harness actions. The shared break screen owns full-frame GIF display, compact break status, overlay-only music playback and media fallbacks.
- Useful for: Settings layout, unsaved drafts, current/pending models, immediate visibility saves, stale-tab feedback, browser autoplay failures, one-file drag-and-drop uploads, unsaved-change highlights and close/navigation guards.
- Used by: `web/main.tsx`.

## `server/`

`server/cli/index.ts`, `server/cli/types.ts`, `server/cli/codex.ts`, `server/cli/cursor.ts`

- Work: Register CLI adapters for live model discovery, exact model/effort validation, commands and session-scoped activity parsers.
- Useful for: Adding a CLI protocol without duplicating the round controller; model selection during guided startup.
- Contains: `CliAdapter`, `CliCatalog`, `cliAdapters`, `validateSessions`, `validateModel`, and Cursor listing parsing.
- Used by: `server/runner.ts`, `scripts/stream.ts` (through the runner), `tests/sessions.test.ts`.


`server/index.ts`

- Work: Starts the show. Loads settings, takes the process lock, and wires the store, filter, judge, runners, previews, chat, OBS, and HTTP server.
- Useful for: Startup order, shutdown, live-mode preflight, and which object owns a dependency.
- Contains: The process entry, the integrations object, and the 250ms controller tick.
- Used by: `npm run dev` and `npm start`. No in-repository importer.

`server/config.ts`

- Work: Parses `settings.json` with zod and loads secret names from `.env.local` without exposing that file to the browser.
- Useful for: Adding a setting, port checks, or a secret name.
- Contains: `settings`, `secrets`, and `root`, including process-only `ARENA_MODE` / `ARENA_RUNNER` / `ARENA_SINGLE_AGENT` overrides.
- Used by: `server/index.ts`, `scripts/login.ts`, `scripts/stream.ts`.

`server/filter.ts`

- Work: Decides whether a `!prompt` chat line can become a task, and scores an evaluation.
- Useful for: Prompt rejection, blocked words, evasion folding, or the membership bonus.
- Contains: `Filter` and `rank`. English dictionary and common technical-term checks reject unreadable suggestions; word-frequency checks reject repetition. The optional blocklist is data in `settings.json` and starts empty in the public repository. The class folds leet digits, confusable letters, inserted symbols, contiguous split-word fragments of up to 16 characters, repeated letters, and one inflection suffix.
- Used by: `server/index.ts`, `server/collection.ts`, `scripts/replay.ts`, `tests/filter.test.ts`, `tests/core.test.ts`, `tests/controller.test.ts`.

`server/collection.ts`

- Work: Admits chat lines during a collection window, asks Jev to score and choose, and keeps the top 30.
- Useful for: Duplicate prompts, the membership score floor, WAIT, the one extension, and the Jev surprise-task fallback.
- Contains: `Collection` and `CollectionOptions`.
- Used by: `server/controller.ts`, `scripts/replay.ts`, `tests/core.test.ts`.

`server/controller.ts`

- Work: Runs the show state machine from paused, collecting, running, results, break, and stopped.
- Useful for: Round launch, quota break, pause, skip, stop, and rehearsal confirmation.
- Contains: `Controller`, `ControllerOptions`, and `Integrations`.
- Used by: `server/index.ts`, `server/http.ts`, `tests/controller.test.ts`.

`server/chat.ts`

- Work: Turns YouTube, Twitch, and Kick events into `ChatMessage` values and keeps those connections alive.
- Useful for: Chat parsing, gift evidence, Kick signature checks, or reconnect behaviour.
- Contains: `youtubeMessage`, `twitchMessage`, `kickMessage`, `validKickSignature`, `YouTubeChat`, `TwitchChat`, and `KickChat`.
- Used by: `server/index.ts`, `tests/core.test.ts`.

`server/youtube.proto`

- Work: The small YouTube Live Chat streaming subset this app actually calls.
- Useful for: YouTube field numbers or the gRPC method name.
- Contains: `V3DataLiveChatMessageService.StreamList` and the message fields `YouTubeChat` reads.
- Used by: `server/chat.ts`.

`server/jev.ts`

- Work: Calls TypeSafe Jev to score one suggestion and to choose one existing candidate or WAIT.
- Useful for: Rubrics, safety and relevance gates, or the selection schema.
- Contains: `Judge` and `Jev`.
- Used by: `server/index.ts`, `server/collection.ts`, `tests/core.test.ts`.

`server/store.ts`

- Work: Persists show state, candidates, evaluations, decisions, events, seen messages, gifts, and container names in SQLite.
- Useful for: What survives a restart, legacy codex/cursor round migration, web-preferences persistence, bounded round history and evaluation cache storage.
- Contains: `Store`.
- Used by: `server/index.ts`, `server/collection.ts`, `server/controller.ts`, `server/chat.ts`, `server/docker.ts`, `scripts/replay.ts`, and the tests that open `:memory:`.

`server/runner.ts`

- Work: Builds shared instructions and launches one or two configured sessions through CLI adapters and the selected Docker/native host.
- Useful for: The prompt both agents receive, quota parsing, or CLI failure classification.
- Contains: Paired or selected single-CLI preflight/launch, `instructions`, `parseQuota`, `CliRunner`, `PairRunner`, `RunHandle`, and `RunOutcome`.
- Used by: `server/index.ts`, `server/controller.ts`, `scripts/stream.ts`, `tests/core.test.ts`, `tests/controller.test.ts`, `tests/native-host.test.ts`.

`server/docker.ts`

- Work: Creates, attaches, stops, and recovers the per-round agent containers, and queries Codex app-server for account and quota.
- Useful for: Container flags, auth copy, workspace paths, or output HTML collection.
- Contains: `Docker` and `DockerOptions`.
- Used by: `server/index.ts`, `server/runner.ts`, `server/browser-sandbox.ts`, `server/native-host.ts`, `scripts/stream.ts`, `tests/sandbox.test.ts`.

`server/codex-profile.ts`

- Work: Creates fresh arena Codex homes, copies only the arena login, disables extra integrations/instruction loading, and validates effective startup configuration.
- Useful for: Codex session isolation, supported exec flags, or serialized compare-before-write arena login retention without copying personal config, skills, hooks or plugins.
- Contains: `CODEX_EXEC_PROFILE_ARGS`, `prepareCodexHome`, `retainCodexLogin`, and `assertCodexProfile`.
- Used by: `server/docker.ts`, `server/native-host.ts`, `server/runner.ts`, `tests/codex-profile.test.ts`.

`server/native-host.ts`

- Work: Runs the same CLI adapters directly on macOS/Linux after explicit native opt-in; Codex uses a fresh home with only the private arena login, while Cursor preserves its native login behaviour.
- Useful for: Native workspace paths, process-group cancellation, ownership records and restart recovery.
- Contains: `NativeHost`, a `Docker` protocol-compatible subclass with an explicit `native` execution label and no host isolation.
- Used by: `server/index.ts`, `scripts/stream.ts`, `tests/native-host.test.ts`.

`server/cli-startup-repair.ts`

- Work: Selects arena/native login commands and distinguishes authentication failures from permission, ownership, model and configuration failures.
- Useful for: Startup repair instructions and preventing inappropriate login prompts.
- Contains: `cliLoginCommand` and `cliStartupAdvice`.
- Used by: `scripts/stream.ts`, `tests/cli-startup-repair.test.ts`.

`server/activity.ts`

- Work: Parses CLI JSON lines and publishes redacted activity without text-length caps. Command outputs and file reads stay private; host terminal lanes show redacted commands and Cursor HTML writes are public.
- Useful for: Overlay event text, duplicate suppression, or a new CLI event type.
- Contains: `JsonLines` and `ActivityAdapter`; accumulated message and thinking text is redacted before streaming, with only possible credential fragments held back.
- Used by: `server/runner.ts`, `server/docker.ts`, `scripts/replay.ts`, `tests/core.test.ts`.

`server/file-diff.ts`

- Work: Compares redacted snapshots of the round's generated HTML and emits added/removed lines to the public activity panel and host write lane.
- Useful for: Diffs from completed edits or shell writes, without trusting CLI-reported paths.
- Contains: `fileDiff` and `HtmlDiffs`; reads only the expected round HTML through existing output checks and refuses links.
- Used by: `server/runner.ts`, `tests/activity-stream.test.ts`.

`server/redact.ts`

- Work: Removes secrets, tokens, and private paths from text that can reach the overlay or SQLite.
- Useful for: A new secret shape, or how auth and quota failures are classified.
- Contains: `redactor`, `credentialGuard`, and `failureKind`. Activity callers request unbounded text; streaming redaction holds possible secret prefixes. The credential guard refuses sensitive generated HTML without modifying its source.
- Used by: `server/index.ts`, `server/runner.ts`, `server/preview.ts`, `tests/core.test.ts`, `tests/preview-credentials.test.ts`, `tests/preview.test.ts`.

`server/preview.ts`

- Work: Serves JPEG frames of generated HTML from an isolated browser. The page itself never runs in OBS.
- Useful for: Credential checks, CSP, input forwarding, or preview restore after restart.
- Contains: `sanitizeHtml` (break visual only), `previewPolicy`, and `Previews`, with viewport and pointer coordinates sized for paired or single-model layouts. Generated HTML is checked for credentials and rendered without rewriting; same-page hash navigation remains allowed.
- Used by: `server/index.ts`, `tests/preview.test.ts`.

`server/browser-sandbox.ts`

- Work: Starts the read-only Chromium container on the internal `stram_previews` network and connects Playwright through a localhost relay using Docker exec streams.
- Useful for: Preview browser flags, localhost relay cleanup, or network isolation without publishing container ports.
- Contains: `BrowserSandbox`.
- Used by: `server/index.ts`, `tests/sandbox.test.ts`.

`server/http.ts`

- Work: Serves the control panel, overlay, break music, and the read-only event socket on localhost.
- Useful for: Host actions, CSRF, the WebSocket snapshot, or `/api/boot` ownership/configuration metadata.
- Contains: `makeHttp`; reconnects receive full snapshots and live activity updates send only new text when an item grows.
- Used by: `server/index.ts`, `tests/http.test.ts`.

`server/obs.ts`

- Work: Connects to OBS, checks its configured overlay source, and starts/stops broadcasts when explicitly requested.
- Useful for: Guided readiness, `StartStream`, or `StopStream`.
- Contains: `Obs`.
- Used by: `server/index.ts`, `scripts/stream.ts`.

## `shared/`

`shared/activity-stream.ts`

- Work: Encodes and reconstructs activity text updates without resending unchanged text.
- Useful for: Long CLI streams, replacements after redaction, and reconnect handling.
- Contains: `ActivityPatch`, `activityPatches`, and `mergeActivityPatches`.
- Used by: `server/http.ts`, `web/main.tsx`, `tests/activity-stream.test.ts`.

`shared/types.ts`

- Work: The shared shapes for chat, evaluations, candidates, tasks, activity, rounds, and show state.
- Useful for: A field that crosses the server and the overlay.
- Contains: `SessionConfig`, `configuredSessions`, `sessionLabel`, `SessionId`, `ChatMessage`, `Evaluation`, `Candidate`, `Task`, `Activity`, `Round`, and `ShowState`; CLI names select protocols while session IDs identify results.
- Used by: Server modules, `web/main.tsx`, `scripts/replay.ts`, and the tests.

## `web/`

`web/index.html`

- Work: The Vite HTML shell for both the overlay and the host desk.
- Useful for: The document title or the root element.
- Contains: The `#root` mount and the module script for `main.tsx`.
- Used by: `vite.config.ts` builds it to `dist/index.html`. `server/http.ts` serves that build.

`web/main.tsx`

- Work: Renders the OBS overlay and, on `/control`, the host desk.
- Useful for: Countdown, candidate reject, rehearsal buttons, or how agent panels show CLI activity.
- Contains: `App`, `AgentPanel`, and `CliColumn`; commands fit one line with an ellipsis, other board text wraps, and boards scroll automatically. Live text patches rebuild full messages. The snapshot agent list selects one full-width panel or both panels.
- Used by: `web/index.html`.

`web/markdown.tsx`, `web/markdown.css`, `web/welcome/Timeline.tsx`

- Work: Share safe React Markdown settings across arena and session replies. The `remark-gfm` plugin recognizes pipe tables; a focusable scroll container keeps wide tables inside the message width. Raw HTML and remote images are skipped.
- Used by: `web/main.tsx`, `web/overlays/OverlayScreen.tsx` through `Timeline`. Focused source case: `tests/markdown.test.tsx`.

`web/style.css`

- Work: Layout and colour for the overlay and host desk, including the narrow-screen rules.
- Useful for: A visual change to the show.
- Contains: The overlay, arena, break screen, and host-desk rules.
- Used by: `web/main.tsx`.

## `scripts/`

`scripts/login.ts`

- Work: Opens an interactive Docker login for Codex or Cursor and stores auth under ignored `runtime/auth/`.
- Useful for: The login command or the auth mount.
- Contains: The `docker run` login arguments.
- Used by: `npm run sandbox:login:codex` and `npm run sandbox:login:cursor`.

`scripts/replay.ts`

- Work: Replays fixture CLI output and fixture chat through `Collection` without calling Jev or Docker.
- Useful for: A dry run of admission and selection.
- Contains: The fixture replay entry.
- Used by: `npm run replay`.

`scripts/stream.ts`

- Work: Prints readiness checks and guided fixes, validates temporary isolated previews, and starts/monitors an app and optionally OBS.
- Useful for: Pre-stream setup, live/rehearsal choice, explicit native opt-in and safe shutdown.
- Contains: CLI options (including `--codex`, `--cursor`, and `--cli` single-model selection), repair prompts, stale/active-controller checks, CSRF-protected host actions and foreground lifecycle handling. Secret values are never requested or printed.
- Used by: `check_stream_start.sh`, `start_stream.sh`.

## `tests/`

`tests/cli-startup-repair.test.ts`

- Work: Checks login command routing and that non-authentication failures do not offer login repair.
- Useful for: Startup diagnostic and login repair regressions.
- Contains: Pure command/advice fixtures; no actual login or coding jobs.
- Used by: `npm test`.

`tests/codex-profile.test.ts`

- Work: Checks fresh Codex homes, auth-only copying/retention, startup rejection of unsafe profiles, and paired autonomous prompts with runtime isolation flags.
- Useful for: Codex profile isolation and avoiding changes to normal user configuration.
- Contains: Temporary profile fixtures and a fake CLI host; no account credentials or live model calls.
- Used by: `npm test`.

`tests/native-host.test.ts`

- Work: Checks explicit native consent, identical native task text, fresh Codex homes and login retention before probe cleanup without launching coding agents.
- Useful for: Native mode approval and CLI command construction.
- Contains: Native host tests with fictional metadata responses.
- Used by: `npm test`.

`tests/filter.test.ts`

- Work: Locks the blocklist contract, including evasion, innocent lookalikes, and the remaining shape checks.
- Useful for: A blocked-word or folding change.
- Contains: Cases that load `settings.json` and a one-stem `Filter`.
- Used by: `npm test`.

`tests/core.test.ts`

- Work: Covers admission, ranking, collection, Jev schema checks, CLI activity, redaction, quota, and chat metadata.
- Useful for: A regression in the round pipeline.
- Contains: The shared `message` and `good` fixtures.
- Used by: `npm test`.

`tests/activity-stream.test.ts`

- Work: Covers long messages, thinking, commands, HTML writes, split credentials, large JSON records, activity patches, and safe HTML diffs.
- Useful for: Preventing truncation and stream freezes without exposing private data.
- Contains: Focused adapter/transport cases and temporary-file diff checks.
- Used by: `npm test`.

`tests/controller.test.ts`

- Work: Drives `Controller` with a fake runner through launch, long-running work, pause, results, quota break, restart, and rehearsal gating.
- Useful for: Show-state transitions.
- Contains: `FakeRunner`.
- Used by: `npm test`.

`tests/http.test.ts`

- Work: Checks overlay reconnect and that host actions reject a cross-origin request.
- Useful for: The control API or the event socket.
- Contains: One HTTP integration test.
- Used by: `npm test`.

`tests/preview.test.ts`

- Work: Checks HTML sanitizing and that a real browser serves pixels without letting the page reach the network.
- Useful for: Preview isolation.
- Contains: The sanitize test and the Playwright preview test.
- Used by: `npm test`.

`tests/preview-credentials.test.ts`

- Work: Checks that the credential guard accepts harmless variables and refuses known values or token-shaped credentials without leaking them in errors.
- Useful for: Generated-page credential protection without source rewriting.
- Contains: Credential-guard unit cases using only fictional credentials.
- Used by: `npm test`.

`tests/sandbox.test.ts`

- Work: Checks real Docker write and network boundaries. It runs only when `STRAM_SANDBOX_TEST=1`.
- Useful for: Container isolation.
- Contains: The skipped Docker boundary test.
- Used by: `npm test`.

`tests/fixtures/chat.json`

- Work: Sample chat records for `scripts/replay.ts`.
- Useful for: Replay input.
- Contains: Fixture messages.
- Used by: `scripts/replay.ts`.

`tests/fixtures/cli.ndjson`

- Work: Sample CLI JSON for the replay script.
- Useful for: Activity parsing without a live CLI.
- Contains: Newline-delimited CLI events.
- Used by: `scripts/replay.ts`.

## `sandbox/`

`sandbox/Dockerfile`

- Work: Builds the agent image with pinned Codex and the Cursor installer.
- Useful for: The agent image or the Codex version pin.
- Contains: The `prompt-arena-agent` image definition.
- Used by: `npm run sandbox:build`.

`sandbox/preview.Dockerfile`

- Work: Builds the Playwright Chromium image used for previews.
- Useful for: The preview image version.
- Contains: The `prompt-arena-preview` image definition.
- Used by: `npm run sandbox:build:preview`.

`sandbox/preview.mjs`

- Work: Launches the in-container Chromium debug server on the path `PREVIEW_WS_PATH`.
- Useful for: Preview browser startup inside Docker.
- Contains: `chromium.launchServer`.
- Used by: `sandbox/preview.Dockerfile`.

`sandbox/compose.yml`

- Work: Runs the egress proxy and declares the internal agent and preview networks.
- Useful for: `stram_agents`, `stram_previews`, or the proxy alias.
- Contains: The `egress` service and the three networks.
- Used by: The Docker setup in `README.md`.

`sandbox/squid.conf`

- Work: Allows the agent network to reach only the provider HTTPS domains.
- Useful for: Adding a provider domain, or checking that private addresses stay denied.
- Contains: The Squid allow and deny rules.
- Used by: `sandbox/compose.yml`.

## Root

`with_colima.sh`

- Work: Starts Colima when needed, selects its Docker socket and runs commands with a separate public-image Docker profile under ignored `runtime/docker-cli/`.
- Useful for: Running without Docker Desktop or a stale Desktop credential helper; leaves personal Docker registry settings untouched.
- Contains: Colima status parsing, Compose/Buildx plugin links and a default guided Docker rehearsal command.
- Used by: The host for Colima builds, CLI login and show startup; forwards explicit native-mode arguments to the existing launcher.

`check_stream_start.sh` and `start_stream.sh`

- Work: Check Node/dependencies, enter the project directory and invoke the guided readiness/start workflow.
- Useful for: Checking before going on air, repairing setup and choosing Docker/native agents.
- Contains: Executable Bash entry points; both support `--help`.
- Used by: The host running the show.

`settings.json`

- Work: Public show configuration, including timings, model ids, `blockedWords`, the Jev readiness probe, and local media paths.
- Useful for: Adding a blocked word or changing a timer. Restart after an edit.
- Contains: The user-owned blocklist (empty by default) and the other zod-checked settings. There is no configurable allowlist; common technical words live in `server/filter.ts`.
- Used by: `server/config.ts`, `tests/filter.test.ts`.

`vite.config.ts`

- Work: Builds `web/` to `dist/`.
- Useful for: The frontend build.
- Contains: The Vite React config.
- Used by: `npm run build`.

`tsconfig.json`

- Work: Typechecks server, shared, web, tests, and scripts. It does not emit files.
- Useful for: `npm run check`.
- Contains: The TypeScript project include list.
- Used by: `npm run check`.

`AGENTS.md`

- Work: Project rules for agents, including which secret paths stay unread.
- Useful for: A constraint that should outlive one chat.
- Contains: The local safety rules.
- Used by: Agents working in this repository.

`README.md`

- Work: How to start the show, connect chat platforms, and rehearse before live mode.
- Useful for: Operator setup.
- Contains: The local runbook.
- Used by: People running the show.


## Presentation controls and reviewed setup reuse

`shared/presentation.ts`, `server/presentation-controls.ts`, `server/presentation-http.ts`, `web/presentation-controls.tsx`, `web/presentation.css`

- Work: Durable global and per-output publication hiding, independent or shared bottom-left goal/stopwatch badges and server-owned time; authenticated presentation actions; reviewed allowlisted last-setup capture/apply and host-confirmed pre-live checks.
- Used by: `server/index.ts`, `server/http.ts`, `server/preview.ts`, `server/sessions/http.ts`, `server/sessions/service.ts`, `server/store.ts`, `shared/types.ts`, `shared/settings.ts`, `web/main.tsx`.
- Limits: Hide cannot retract delivered content or reach a disconnected control page; OBS scene hotkeys and app publication privacy are independent. Stopwatch restores paused, with one-second running checkpoints. Checklist confirmation is process-local and bound to relevant public choices and output assignments.

`web/overlays/OverlayPresentation.tsx`, `web/host-refresh.ts`, `web/audio-owner.ts`, `web/welcome/LastSetup.tsx`, `web/welcome/RehearsalCheck.tsx`

- Work: Single-flight/coalesced host fetches at a 750ms minimum interval, stale-generation rejection, one same-browser audio owner, per-output own/shared goal selection via the existing overlay poll, review-before-apply setup reuse and explicit human rehearsal confirmation.
- Used by: `web/main.tsx`, `web/welcome/Welcome.tsx`, `web/break-screen.tsx`.
- Verification: Focused cases in `tests/presentation.test.ts` and `tests/host-refresh.test.ts`; no CLI/OBS invocations in their fixtures. Tests/build/type check were not run for this implementation.

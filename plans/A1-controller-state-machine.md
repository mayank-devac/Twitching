# A1 — Controller as an explicit state machine

Status: not started. Line references are as of commit `087ec79`; re-check them before editing, because other cleanups may have moved code.

## Goal

Make the arena round lifecycle readable and testable by replacing the controller's private boolean flags with one explicit phase, and by moving launching, break policy and the tick scheduler out of `server/controller.ts`. Behaviour, wire format and stored state shape stay the same.

## Current state

- `server/controller.ts` is 920 lines. `Controller` (line 35) owns scheduling, launching, result handling, quota breaks, host choices and mode switching.
- Private flags that together act as a hidden state machine (lines 39–45 and 83–87):
  `busy`, `launching`, `checkingQuota`, `ending`, `switchingToSession`, `arenaCleanupFailed`, `resumeAfterBreak`, `playlistReleased`, plus `handles` (present or not), `pendingStop`, `generation` and `launchSettled`.
- The public status is a separate union: `ShowState.status` in `shared/types.ts:170` (`stopped | paused | collecting | running | results | break`), with `breakKind` and `manualBreak` refining `break`.
- Combinations of flags are checked by hand in many places, for example:
  - `sessionReady` (lines 49–55) ANDs seven flags with the status and attempt states;
  - `leaveArena` (lines 58–81) re-derives "active" from `handles`, `launching`, `busy` and attempt states;
  - `tick()` (lines 531–646) starts with a five-flag guard, then a long if/else ladder over `status`, deadlines and `pendingStop`;
  - `start()` (lines 375–457) guards on `breaks.transitioning`, `busy`, `launching`, `handles`, mode and runner.
- Already extracted: `server/manual-break.ts` (`ManualBreakControls`, manual break timing only), `server/controller/options.ts` (types, `ControllerOptions`, `Integrations`, `StopChoice`) and `server/controller/round-state.ts` (`newRound`, `recordActivity`, `stateView`).
- Launch and result handling: `launch()` lines 647–712, `finished()` from line 713. Quota: `checkQuota()` lines 767–797, `recoveredQuota()` line 798, plus the quota break branch inside `tick()` (lines 580–598).
- Tests: `tests/controller.test.ts` (831 lines, behaviour through the public API with a `FakeRunner`), `tests/controller-split.test.ts` (pure helpers), `tests/single-cli.test.ts`, `tests/core.test.ts`.

## Target design

1. One private `phase` field inside the controller, a string union such as:
   `idle | starting | collecting | launching | running | results | quotaBreak | manualBreak | stopping | switchingToSession | cleanupFailed`.
   `ShowState.status` is derived from `phase` in one function (`publicStatus(phase)`), so the wire format does not change.
2. A transition table: `const transitions: Record<Phase, Phase[]>` and one `go(next, reason?)` method that throws on an illegal move. Every current assignment to `state.status` or a flag goes through `go`.
3. `RoundLauncher` (`server/controller/round-launcher.ts`): owns `handles`, `generation`, `launchSettled`, `launch()` and `finished()`. It reports back through callbacks (`onActivity`, `onAttemptSettled`, `onAllSettled`), never by mutating controller fields.
4. `BreakPolicy` (`server/controller/break-policy.ts`): quota polling, quota break entry, recovery and the ten-minute give-up rule. Keeps `ManualBreakControls` for manual breaks.
5. A scheduler table for `tick()`: an ordered list of `{ when(state), run() }` rules (OBS reconnect deadline, manual break expiry, scheduled break start, quota break, launch prepared task, result hold expiry). `tick()` runs the first matching rule. The single-flight `busy` guard stays.

## Migration steps (small, safe commits)

1. **Characterization tests first** (`tests/controller-phases.test.ts`, new file). Using the existing `FakeRunner` pattern from `tests/controller.test.ts` (line 24), pin for each public entry point (`start`, `pause`, `resume`, `skip`, `stop`, `hostChoice`, `leaveArena`, `manualBreak`, `endManualBreak`, `tick`) the resulting `state.status`, `reason`, `breakKind` and whether a launch happened. Include: start while launching, skip during results, quota exhausted mid-round, quota recovered during the break, pending stop "chat" and "stream", rehearsal pause after one round, prompt-list end, `leaveArena("wait")` vs `("cancel")`, and `sessionReady` in every phase.
2. Add `phase` alongside the flags, set in the same places, with an assertion helper in tests that `publicStatus(phase) === state.status`. No behaviour change.
3. Replace reads of the flags with reads of `phase`, one flag per commit (start with `ending`, then `switchingToSession`, `arenaCleanupFailed`, `launching`, `busy`). Delete each flag when it has no readers.
4. Extract `BreakPolicy`, moving `checkQuota`, `recoveredQuota`, `lastQuota`, `checkingQuota` and `resumeAfterBreak`. Controller calls into it from `tick()`.
5. Extract `RoundLauncher`, moving `launch`, `finished`, `handles`, `generation` and `launchSettled`. Keep the `.catch` that pauses on result-handling failure.
6. Turn the `tick()` if/else ladder into the rule table. One commit, guarded by the step 1 tests.
7. Add the transition table and `go()`. Illegal transitions throw in tests and pause the show (with a clear reason) in production rather than crash.

Keep `server/controller.ts` under 1000 lines throughout; it should end well below 600.

## Risks

- Hidden ordering: `pause()` deliberately keeps an active break (see the comment at line 561). The rule table must keep the same order.
- `generation` invalidation is how stale launches are cancelled. Moving it into `RoundLauncher` must keep "bump generation before cancelling" semantics.
- `ManualBreakControls` calls back into controller state; keep its callback contract unchanged while extracting.
- Restart recovery in the constructor (lines 251–258) marks running attempts cancelled. The derived phase after restart must be `paused`/`idle`, never `running`.
- Persisted `state` document (`server/store.ts`, key `state`) must keep its shape. `phase` is in-memory only.

## How to verify

- `npm run check` and `npm test` (with permission). The new phase tests and all of `tests/controller.test.ts` pass unchanged.
- `npm run replay` runs fixtures through the controller without live chat or CLIs.
- Private rehearsal: one round, Pause/Resume/Skip/Stop, a manual timed break, and Stop → Chat / End choices, as listed in `guides.md`.

# A2 — A RunProfile for CliRunner instead of option bags

Status: not started. Line references are as of commit `087ec79`; re-check them before editing.

## Goal

`CliRunner` serves two different products: arena rounds (one HTML page per agent, shown on stream) and coding sessions (general prompts, optional HTML). Today it decides between them with `experience` checks spread through the file and patches prompt text with `.replace()`. Replace that with one `RunProfile` object chosen at construction, and build prompts from structured templates. No change to prompts actually sent, outputs, redaction or stored data.

## Current state

- `server/runner.ts` (396 lines). Constructor (lines 110–122) takes `SessionOptions & { experience?: "welcome" | "session" | "arena"; workspaceKey?: string; nativeApproved?: boolean }`.
- `this.options.experience` is checked 12 times: lines 155 (skip quota parse for sessions), 175 and 177 (prompt choice and sizing), 213 (HTML diff tracking), 255 (`general` flag for activity adapters), 275 and 303 (diff capture), 337 (optional result for sessions), 350 and 355 (preserve/copy arena output), 369 and 383 (error wording).
- `workspaceKey` also changes behaviour: reused session workspace (lines 192–193) and `discardHome: !this.options.workspaceKey` (line 359).
- Prompt building:
  - `instructions(task, round)` (line 42) returns the arena prompt as one long template string, hard-coding the 960 × 1044 half-frame size;
  - `launch()` then patches it: `.replace("Do not ask questions.", ...)` (lines 170–173) and, for one session, swaps the size sentence (lines 177–181);
  - sessions replace the whole prompt with a different string (lines 175–176);
  - `server/native-host.ts` patches it again for native runs (lines 205–214: `/workspace/` → `./`, "Work only in /workspace." → "Work only in your current working directory."). A wording change in `instructions()` can silently break these replacements.
- Viewport sizes already have a source of truth: `viewportFor()` in `server/preview.ts:88`.
- Constructors: `server/index.ts:185` (arena), `server/sessions/service.ts:198` (model discovery) and `:462` (session run), `scripts/stream.ts:115` (launcher checks), and tests `tests/codex-profile.test.ts`, `tests/single-cli.test.ts`.

## Target design

```ts
// server/run-profile.ts
export interface RunProfile {
  kind: "arena" | "session";
  checksQuota: boolean;            // line 155
  tracksHtmlDiffs: boolean;        // lines 213, 275, 303
  generalActivity: boolean;        // line 255
  workspace(host, session, round): Promise<string | undefined>;  // lines 192–193
  discardHomeAfterRun: boolean;    // line 359
  prompt(task, round, ctx: { sessionCount: 1 | 2; paths: PromptPaths }): string;
  afterRun(host, agent, round, dir, outcome, emit): Promise<void>; // lines 337–356
  failureText: string;             // lines 369, 383
}
export const arenaProfile: RunProfile;
export function sessionProfile(workspaceKey: string): RunProfile;
```

- `PromptPaths` carries the working directory wording (`/workspace` in Docker, the current directory for native), so `NativeHost` stops rewriting prompts. The host exposes `promptPaths` instead.
- Prompt templates are arrays of named sentences (`noQuestions`, `outputFile`, `viewport`, `untrustedComment`, …) joined at the end, so variants swap a sentence by key, not by matching text.
- The viewport sentence is built from `viewportFor(sessionCount)`.
- `CliRunner` takes `(host, sessions: SessionOptions, profile: RunProfile, clean, capabilityChecks)`. `nativeApproved` stays a per-run approval (it is a security decision, not a profile property).

## Migration steps

1. **Golden prompt tests first** (`tests/run-prompts.test.ts`, new). Capture the exact prompt passed to `cliAdapters[cli].command()` for: arena with 2 sessions, arena with 1 session, session run, each on Docker and native (use the fake hosts in `tests/single-cli.test.ts` and `tests/native-host.test.ts`). Assert byte-for-byte equality with today's strings.
2. **Behaviour tests**: for an arena and a session run with a fake host, record which host methods are called (`preserveOutput`, `output`, `retainAuth` with `discardHome`) and the error text on cleanup failure.
3. Introduce `RunProfile` with `arenaProfile` / `sessionProfile` that simply mirror today's branches. `CliRunner` builds the profile from `experience` internally. No call-site change.
4. Replace the 12 `experience` checks with profile fields, a few per commit.
5. Move prompt building into the profile using sentence arrays; keep the golden tests green.
6. Add `promptPaths` to the hosts and delete the prompt rewriting in `server/native-host.ts:205–214`.
7. Change the constructor signature and update the five call sites; drop `experience` and `workspaceKey` from the options bag.

## Risks

- Prompt text is part of the safety design (untrusted audience comment, no auth file reads, no /tmp). Any byte change must be deliberate and reviewed; golden tests guard this.
- `discardHome` controls deletion of the login copy (see D1). Sessions must keep their home for the next prompt; arena rounds must delete it. Cover both in step 2.
- `scripts/stream.ts` builds a runner for checks only; it must get the arena profile.
- A2 touches the same native prompt rewrite as A3; do A2 step 6 before or together with A3.

## How to verify

- `npm run check`, `npm test` (with permission); golden prompt tests unchanged.
- `STRAM_SANDBOX_TEST=1 npx tsx --test tests/sandbox.test.ts` once images exist.
- One private rehearsal round and one managed session prompt (Docker and, if used, native) to confirm outputs and history look the same.

# Deferred refactor plans

Each file is a self-contained plan for one larger change that was deferred during the 2026-11 cleanup. The original findings are in `PLAN/plan.txt` (item IDs match). Line references in the plans are as of commit `087ec79`; re-check them before editing.

Every plan follows the same rules as the rest of the repository (`AGENTS.md`): tests first, small commits, no change to UI look, wire format or stored data unless the plan says so, and privacy/redaction never weaker.

| Plan | Change | Size | Depends on |
| --- | --- | --- | --- |
| [D1](D1-auth-isolation.md) | Keep CLI logins out of the agent workspace; rotate logins | Medium, needs live runs | — |
| [A9](A9-shared-server-wiring.md) | One wiring module for server and launcher; typed `StartupOverrides`; shared secret list | Medium | — |
| [A2](A2-run-profile.md) | `RunProfile` for `CliRunner`; structured prompt templates | Medium | — |
| [A3](A3-execution-host.md) | `ExecutionHost` interface; per-CLI login/argv in adapters | Large | A2 (prompt rewrite), D1 (login paths) |
| [A1](A1-controller-state-machine.md) | Controller phases, `RoundLauncher`, `BreakPolicy`, tick rule table | Large | — |
| [A12](A12-showstate-union.md) | `ShowState` as a discriminated union; split socket payload | Large | A1 (break and phase fields) |

## Suggested order

1. **D1** first: it is a security fix, and the rotation steps should happen as soon as possible if live rounds have run.
2. **A9 step 2** (shared secret list) next: small, and it closes a redaction drift. The rest of A9 can follow later.
3. **A2**, then **A3**: A2 removes the native prompt rewrite that A3 would otherwise have to carry, and A3's login moves should build on D1's new login location.
4. **A1**, then **A12**: A12's wire types are simpler once the controller has an explicit phase and break model.

A1 and A2/A3 touch different files and can run in parallel. A12 touches nearly every web screen; run it alone.

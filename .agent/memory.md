# Verified source decisions

- Startup parsing and normalization belong in `server/startup-config.ts`. The boot configuration ID represents startup inputs captured before saved web preferences are applied; do not hash the mutable effective settings later in `server/index.ts`.
- `server/login-guard.ts` owns login locks and baseline comparisons for all host instances in one process, keyed by project and CLI. File replacement uses a temporary sibling and rename; Cursor's multiple files are not a transaction across a crash.
- Result validation and restoration require an explicit one/two-session count. `viewportFor` owns the result dimensions; use the saved round's sessions when restoring old results.
- Session IDs own directories and activity; CLI names select protocols. Legacy round migration may separate a recognized reasoning suffix from a model label, but must retain the original session IDs and output paths.
- Node's typed `assert.deepEqual` can narrow a fixture to require fields in the expected value. Use a separate fixture when a later migration case intentionally omits those fields; do not bypass the check with an unsafe cast.

- Local preview tests can reuse an installed Chrome for Testing through `ARENA_TEST_BROWSER_PATH`; their macOS fallback also checks `.omp/puppeteer/chrome`. The browser executable is reused with fresh temporary profiles.

The three preview tests passed using Chrome for Testing 150.0.7871.24 on 2026-10-28. The broader tests, type check and build remain for Mayank to run.

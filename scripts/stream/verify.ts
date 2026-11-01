// Owns the opt-in automated verification step (--verify, or the check-mode prompt).
import { run, toolEnv, yes } from "./runtime.js";
import type { StreamOptions } from "./options.js";

export async function maybeVerify(
  options: StreamOptions,
  runnerMode: "docker" | "native",
) {
  if (
    options.verify ||
    (options.command === "check" &&
      options.interactive &&
      (await yes(
        "Also run type checks, tests, fixture replay and rebuild now?",
      )))
  ) {
    for (const script of ["check", "test", "replay", "build"])
      await run("npm", ["run", script]);
    if (runnerMode === "docker")
      await run("node_modules/.bin/tsx", ["--test", "tests/sandbox.test.ts"], {
        ...toolEnv,
        STRAM_SANDBOX_TEST: "1",
      } as typeof toolEnv);
    console.log("OK: requested automated verification completed");
  } else
    console.log(
      "NOTE: tests/type checks were not run. Use --verify for them; a successful rehearsal still needs host confirmation.",
    );
}

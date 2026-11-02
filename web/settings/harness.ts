import type { Agent, RunnerMode, SessionConfig } from "../../shared/types.js";

// Places a new harness in the slot the host chose, or the free one; an error string when it cannot.
export function placeHarness(
  sessions: SessionConfig[],
  cli: Agent,
  model: string,
  replacement: string,
  runner?: RunnerMode,
): SessionConfig[] | string {
  if (replacement && !sessions.some((s) => s.id === replacement))
    return "That slot changed. Reopen the harness form and choose a current slot.";
  const target =
    replacement ||
    ["session-1", "session-2"].find((id) => !sessions.some((s) => s.id === id));
  if (!target)
    return "Both slots are occupied. Choose an explicit replacement for the next round.";
  const session: SessionConfig = { id: target, cli, model, ...(runner ? { runner } : {}) };
  return replacement
    ? sessions.map((s) => (s.id === replacement ? session : s))
    : [...sessions, session];
}

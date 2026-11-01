// Pure readings of arena ShowState for the host toolbar, prompt strip and agent panels.
import type { Attempt, ShowState } from "../../shared/types.js";

export function clock(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

// The prompt strip's phase word, next to the countdown from phaseDeadline.
export function phaseLabel(state: ShowState) {
  if (state.status === "break") return "BREAK";
  if (state.status === "results") return "NEXT";
  return state.prepared ? "READY" : "COLLECT";
}

export function phaseDeadline(state: ShowState) {
  if (state.status === "break") return state.breakUntil;
  if (state.status === "results") return state.resultUntil;
  return state.collectionDeadline;
}

// Which arena actions the current show status permits, before busy/token checks.
// A manual break is host-ended, so Start and Resume both end it.
export function allowedActions(state: ShowState) {
  const manualBreak = state.status === "break" && state.breakKind === "manual";
  const attempts = Object.values(state.round?.attempts ?? {});
  return {
    start:
      manualBreak ||
      !["running", "collecting", "results", "break"].includes(state.status),
    pause: !["paused", "stopped"].includes(state.status),
    resume: state.status === "paused" || manualBreak,
    skip: attempts.some((a) => a.status === "running"),
    stop: state.status !== "stopped",
    rehearsalTask: ["paused", "collecting"].includes(state.status),
    confirmRehearsal: !!state.round && attempts.every((a) => a.status === "complete"),
  };
}

export const attemptFailed = (attempt?: Attempt) =>
  !!attempt && ["error", "timeout", "cancelled"].includes(attempt.status);

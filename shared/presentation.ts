// The server owns elapsed time; browsers only format a snapshot of that clock.
export interface Presentation {
  hidden: boolean;
  goal: string;
  showGoal: boolean;
  elapsedMs: number;
  runningSince?: number;
  serverNow: number;
  breakActive?: boolean;
  breakUntil?: number;
}
export interface OutputPresentation extends Presentation {
  source: "own" | "shared";
}
export interface SavedPresentation extends Presentation {
  revision: number;
  outputs: Record<string, OutputPresentation>;
}
// Host-only editing data must never be included in public snapshots.
export interface PresentationSelection {
  revision: number;
  source: "own" | "shared";
  globalHidden: boolean;
  globalBreakActive: boolean;
  own: Presentation;
  value: Presentation;
}
export function elapsed(p: Presentation, now = p.serverNow) {
  return p.elapsedMs + (p.runningSince === undefined ? 0 : Math.max(0, now - p.runningSince));
}
export function stopwatch(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const parts = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  return (parts[0] ? parts : parts.slice(1)).map((n) => String(n).padStart(2, "0")).join(":");
}

// Keep shortcut policy testable without a browser or synthetic DOM.
export function privacyCommand(event: Pick<KeyboardEvent, "repeat" | "isComposing" | "keyCode" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey" | "code">, editing: boolean) {
  if (editing || event.repeat || event.isComposing || event.keyCode === 229 ||
    !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return undefined;
  return event.code === "KeyH" ? "hide" : event.code === "KeyS" ? "show" : undefined;
}

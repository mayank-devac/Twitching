// The server owns elapsed time; browsers only format a snapshot of that clock.
export interface Presentation {
  hidden: boolean;
  goal: string;
  showGoal: boolean;
  elapsedMs: number;
  runningSince?: number;
  serverNow: number;
}
export function elapsed(p: Presentation, now = p.serverNow) {
  return p.elapsedMs + (p.runningSince === undefined ? 0 : Math.max(0, now - p.runningSince));
}
export function stopwatch(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const parts = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  return (parts[0] ? parts : parts.slice(1)).map((n) => String(n).padStart(2, "0")).join(":");
}

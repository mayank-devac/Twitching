export type Platform = "youtube" | "twitch" | "kick" | "fallback";
export type Agent = "codex" | "cursor";
// CLI identity selects a protocol; session identity owns files and results.
export type SessionId = string;
export interface SessionConfig {
  id: SessionId;
  cli: Agent;
  model: string;
  effort?: string;
}
export interface SessionOptions {
  sessions?: SessionConfig[];
  singleAgent?: Agent;
  codexModel: string;
  cursorModel: string;
  codexEffort?: string;
}
export function configuredSessions(options: SessionOptions): SessionConfig[] {
  if (options.sessions) return options.sessions;
  const clis: Agent[] = options.singleAgent
    ? [options.singleAgent]
    : ["cursor", "codex"];
  return clis.map((cli) => ({
    id: cli,
    cli,
    model: cli === "codex" ? options.codexModel : options.cursorModel,
    ...(cli === "codex" ? { effort: options.codexEffort ?? "high" } : {}),
  }));
}
export function sessionLabel(session: SessionConfig) {
  return session.model + (session.effort ? ` · ${session.effort}` : "");
}
export function validSessionId(id: string) {
  return /^(codex|cursor|session-[12])$/.test(id);
}
export interface ChatMessage {
  id: string;
  platform: Exclude<Platform, "fallback">;
  authorId: string;
  author: string;
  text: string;
  timestamp: number;
  membership: {
    verified: boolean;
    member: boolean;
    gift: boolean;
    evidence?: string;
  };
}
export interface Evaluation {
  safety: number;
  relevance: number;
  simplicity: number;
  clarity: number;
  creativity: number;
  visual: number;
}
export interface Candidate {
  id: string;
  window: number;
  message: ChatMessage;
  text: string;
  normalized: string;
  evaluation: Evaluation;
  score: number;
}
export interface Task {
  text: string;
  author: string;
  platform: Platform;
  candidateId?: string;
}
export type ActivityKind =
  | "message"
  | "summary"
  | "tool"
  | "command"
  | "edit"
  | "output"
  | "complete"
  | "error";
export type ActivityLane = "read" | "write" | "tool" | "terminal";
export interface Activity {
  id: string;
  round: number;
  agent: SessionId;
  at: number;
  kind: ActivityKind;
  text: string;
  append?: boolean;
  diff?: boolean;
  lane?: ActivityLane;
}
export interface Attempt {
  cli?: Agent;
  effort?: string;
  model: string;
  status:
    | "idle"
    | "running"
    | "validating"
    | "complete"
    | "error"
    | "timeout"
    | "cancelled";
  startedAt?: number;
  endedAt?: number;
  preview?: string;
  error?: string;
}
export interface Round {
  id: number;
  task: Task;
  launchedAt: number;
  sessions?: SessionConfig[];
  attempts: Record<SessionId, Attempt>;
}
export interface ShowState {
  status: "stopped" | "paused" | "collecting" | "running" | "results" | "break";
  mode: "live" | "rehearsal";
  sessions?: SessionConfig[];
  models?: Record<SessionId, string>;
  agents?: SessionId[];
  reason: string;
  round?: Round;
  prepared?: Task;
  candidates: Candidate[];
  candidateCount: number;
  collectionDeadline?: number;
  resultUntil?: number;
  breakUntil?: number;
  obsReconnectDeadline?: number;
  quota?: { remainingPercent: number; resetsAt: number };
  events: Activity[];
  connections: Record<string, string>;
  checks: string[];
  rehearsalComplete: boolean;
  rehearsalRunnerMode?: "docker" | "native";
  playlistIndex?: number;
  playlistTotal?: number;
  awaitingHostChoice?: boolean;
}

export type Platform = "youtube" | "twitch" | "kick" | "fallback";
export type Agent = "codex" | "cursor";
// CLI identity selects a protocol; session identity owns files and results.
export const SESSION_IDS = ["codex", "cursor", "session-1", "session-2"] as const;
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
export function sessionLabel(session: Pick<SessionConfig, "model" | "effort">) {
  return session.model + (session.effort ? ` · ${session.effort}` : "");
}
export function validSessionId(id: string) {
  return SESSION_IDS.some((value) => value === id);
}
export function legacyCli(id: string): Agent | undefined {
  return id === "codex" || id === "cursor" ? id : undefined;
}
export function sessionCli(state: Pick<ShowState, "round" | "sessions">, id: SessionId): Agent | undefined {
  return state.round?.attempts[id]?.cli
    ?? state.round?.sessions?.find((s) => s.id === id)?.cli
    ?? state.sessions?.find((s) => s.id === id)?.cli
    ?? legacyCli(id);
}
// Old rounds stored the model and reasoning effort as one display label.
export function legacyModel(label: string): Pick<SessionConfig, "model" | "effort"> {
  const match = label.match(/^(.*?) · (minimal|low|medium|high|xhigh|max|ultra)$/);
  return match ? { model: match[1], effort: match[2] } : { model: label };
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
  // Set only by a parser that validated an exact arena workspace filename.
  publicFile?: string;
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
  preparedVersion?: string;
  candidates: Candidate[];
  candidateCount: number;
  collectionDeadline?: number;
  resultUntil?: number;
  // Manual breaks never use the quota recovery transition.
  breakUntil?: number;
  breakKind?: "manual" | "quota";
  manualBreak?: { durationMs: number; deadline?: number };
  quickSettings?: {
    revision: number;
    visibility: import("./settings.js").QuickPreferences["visibility"];
    media: import("./settings.js").QuickPreferences["media"];
  };
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

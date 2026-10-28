export type Platform = "youtube" | "twitch" | "kick" | "fallback";
export type Agent = "codex" | "cursor";
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
  agent: Agent;
  at: number;
  kind: ActivityKind;
  text: string;
  append?: boolean;
  diff?: boolean;
  lane?: ActivityLane;
}
export interface Attempt {
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
  attempts: Record<Agent, Attempt>;
}
export interface ShowState {
  status: "stopped" | "paused" | "collecting" | "running" | "results" | "break";
  mode: "live" | "rehearsal";
  models?: Record<Agent, string>;
  agents?: Agent[];
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

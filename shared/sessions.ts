import type { ActivityKind, Agent, SessionConfig } from "./types.js";
import type { SessionVisibility } from "./settings.js";

export type Experience = "welcome" | "session" | "arena";
export interface ConnectorCapabilities {
  listing: boolean;
  history: boolean;
  liveEvents: boolean;
  runtimeStatus: boolean;
  note: string;
}
// Provider IDs never double as managed process/workspace IDs.
export interface Conversation {
  id: string;
  source: "managed" | "codex";
  providerId?: string;
  cli: Agent;
  title: string;
  project: string;
  updatedAt: number;
  model?: string;
  status: "running" | "idle" | "disconnected" | "unknown";
  config?: SessionConfig;
  runner?: "docker" | "native";
  result?: { round: number; agent: string };
  pendingRun?: boolean;
}
export interface TimelineItem {
  id: string;
  run: string;
  at: number;
  kind: ActivityKind | "prompt" | "read";
  text: string;
}
export interface TimelinePage {
  latestRun?: string;
  items: TimelineItem[];
  before?: string;
}
export interface SessionView {
  conversation: Conversation;
  page: TimelinePage;
  visibility: SessionVisibility;
  hidePreviousRuns: boolean;
  published: boolean;
}

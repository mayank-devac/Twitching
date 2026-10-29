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

export const MAX_OVERLAY_SESSIONS = 8;
export const MAX_OVERLAYS = 32;
export type OverlaySelection =
  "selected" | "running-snapshot" | "follow-running";
export interface OverlayDefinition {
  id: string;
  name: string;
  selection: OverlaySelection;
  sessionIds: string[];
  published: boolean;
  capturedAt?: number;
  capturedTotal?: number;
}
export interface OverlayDocument {
  revision: number;
  overlays: OverlayDefinition[];
}
export interface OverlayView {
  id: string;
  name: string;
  revision: number;
  published: boolean;
  frames: SessionView[];
  omittedRunning: number;
  error?: string;
}
export interface OverlayHostDocument extends OverlayDocument {
  presentation?: Record<string, import("./presentation.js").PresentationSelection>;
  running: Conversation[];
  publishedSessionIds: string[];
}

// Provider pages can overlap when activity changes their order; identity, never title, deduplicates rows.
export function uniqueConversations(rows: Conversation[]): Conversation[] {
  const unique = new Map<string, Conversation>();
  for (const row of rows) {
    if (!row.id || row.id === "codex:") continue;
    const previous = unique.get(row.id);
    if (!previous || row.updatedAt >= previous.updatedAt)
      unique.set(row.id, row);
  }
  return [...unique.values()];
}

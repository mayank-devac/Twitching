import type { ActivityKind, RunnerMode, SessionConfig } from "./types.js";

// Every chat source the show can read; loops over this replace per-platform copies.
export const CHAT_PLATFORMS = ["youtube", "twitch", "kick"] as const;
export type ChatPlatform = (typeof CHAT_PLATFORMS)[number];
export const chatPlatformLabels: Record<ChatPlatform, string> = {
  youtube: "YouTube",
  twitch: "Twitch",
  kick: "Kick",
};

// Public display choices hide presentation only; stored activity is retained.
export interface SessionVisibility {
  hidePreviousRuns?: boolean;
  tool: boolean;
  command: boolean;
  read: boolean;
  edit: boolean;
  message: boolean;
  summary: boolean;
  output: boolean;
  complete: boolean;
  error: boolean;
  model: boolean;
  cliIcon: boolean;
  cliName: boolean;
}

// Saved visual modes map to predictable browser image fitting behavior.
export type BreakVisualMode = "fit" | "center" | "fill";
export const breakVisualObjectFit: Record<BreakVisualMode, "contain" | "none" | "cover"> = {
  fit: "contain",
  center: "none",
  fill: "cover",
};
export const defaultVisibility: SessionVisibility = {
  tool: true,
  command: false,
  read: true,
  edit: false,
  message: true,
  summary: false,
  output: true,
  complete: true,
  error: true,
  model: true,
  cliIcon: true,
  cliName: true,
};
// The allowlist deliberately excludes credentials, host paths and native execution.
export interface QuickPreferences {
  managedModels?: Record<string, { model: string; effort?: string }>;
  sessions: SessionConfig[];
  visibility: Record<string, SessionVisibility>;
  // One enable flag per chat platform, stored as plain youtube/twitch/kick keys.
  stream: Record<ChatPlatform, boolean> & {
    mode: "live" | "rehearsal";
    collectionMs: number;
    extensionMs: number;
    resultMs: number;
  };
  jevCriteria: string;
  jevProbe: string;
  media: { audio?: string; visual?: string; visualFit?: BreakVisualMode };
}
export interface SettingsDocument {
  revision: number;
  value: QuickPreferences;
}
// Only public choices are copied; credentials, prompts and native consent are excluded.
export interface LastSetup {
  savedAt: number;
  path: "existing" | "new" | "arena";
  sessionId?: string;
  session?: { cli: string; model?: string; effort?: string; title: string };
  runner: RunnerMode;
  sessions: SessionConfig[];
  visibility: QuickPreferences["visibility"];
  stream: QuickPreferences["stream"];
  managedModels?: QuickPreferences["managedModels"];
}
export interface ModelChoice {
  id: string;
  efforts: string[];
}
export interface HistoryPage {
  rounds: import("./types.js").Round[];
  before?: number;
}
export type VisibilityActivity = ActivityKind | "read";

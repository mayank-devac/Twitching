import type { ActivityKind, SessionConfig } from "./types.js";

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
export const defaultVisibility: SessionVisibility = {
  tool: true,
  command: false,
  read: false,
  edit: true,
  message: true,
  summary: true,
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
  stream: {
    mode: "live" | "rehearsal";
    youtube: boolean;
    twitch: boolean;
    kick: boolean;
    collectionMs: number;
    extensionMs: number;
    resultMs: number;
  };
  jevCriteria: string;
  jevProbe: string;
  media: { audio?: string; visual?: string };
}
export interface SettingsDocument {
  revision: number;
  value: QuickPreferences;
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

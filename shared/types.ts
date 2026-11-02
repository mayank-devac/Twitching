export type Platform = "youtube" | "twitch" | "kick" | "fallback";
// The one list of supported coding-agent CLIs; every CLI union and loop derives from it.
export const CLIS = ["codex", "cursor", "claude"] as const;
// Display names for every CLI; the UI, launcher and messages read these instead of ternaries.
export const CLI_LABELS: Record<(typeof CLIS)[number], string> = {
  codex: "Codex",
  cursor: "Cursor",
  claude: "Claude Code",
};
// Claude Code has no list-models command; settings fall back to this alias.
export const DEFAULT_CLAUDE_MODEL = "sonnet";
export type Agent = (typeof CLIS)[number];
export function isCli(value: unknown): value is Agent {
  return CLIS.some((cli) => cli === value);
}
// CLI identity selects a protocol; session identity owns files and results.
// Legacy CLI-named ids are used by single-agent runs (--codex/--cursor/--claude).
export const SESSION_IDS = [
  "codex",
  "cursor",
  "claude",
  "session-1",
  "session-2",
] as const;
export type SessionId = string;
export type SessionCount = 1 | 2;
export function sessionCount(sessions: readonly unknown[]): SessionCount {
  if (sessions.length !== 1 && sessions.length !== 2)
    throw new Error("Choose one or two sessions");
  return sessions.length;
}
// Validated shapes live in schema.ts; their types are re-exported here for existing importers.
export type { RunnerMode, SessionConfig } from "./schema.js";
import type { RunnerMode, SessionConfig } from "./schema.js";
export interface SessionOptions {
  sessions?: SessionConfig[];
  singleAgent?: Agent;
  codexModel: string;
  cursorModel: string;
  codexEffort?: string;
  claudeModel?: string;
  claudeEffort?: string;
}
// settings.json keeps flat per-CLI model keys; this reads them as one per-CLI map.
export function startupModels(
  options: Pick<
    SessionOptions,
    "codexModel" | "cursorModel" | "codexEffort" | "claudeModel" | "claudeEffort"
  >,
): Record<Agent, Pick<SessionConfig, "model" | "effort">> {
  return {
    codex: { model: options.codexModel, effort: options.codexEffort ?? "high" },
    // Cursor sessions carry no effort key at all.
    cursor: { model: options.cursorModel },
    claude: {
      model: options.claudeModel ?? DEFAULT_CLAUDE_MODEL,
      effort: options.claudeEffort ?? "high",
    },
  };
}
export function configuredSessions(options: SessionOptions): SessionConfig[] {
  if (options.sessions) return options.sessions;
  const clis: Agent[] = options.singleAgent
    ? [options.singleAgent]
    : ["cursor", "codex"];
  const models = startupModels(options);
  return clis.map((cli) => ({ id: cli, cli, ...models[cli] }));
}
export function sessionLabel(session: Pick<SessionConfig, "model" | "effort">) {
  return session.model + (session.effort ? ` · ${session.effort}` : "");
}
// Public "model · effort" text; each part follows its own visibility flag.
export function publicModelLabel(
  session: Partial<Pick<SessionConfig, "model" | "effort">> | undefined,
  show: { model: boolean; effort?: boolean },
) {
  if (!session) return "";
  return [
    show.model ? session.model : undefined,
    show.effort !== false ? session.effort : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}
export function validSessionId(id: string) {
  return SESSION_IDS.some((value) => value === id);
}
export function legacyCli(id: string): Agent | undefined {
  return isCli(id) ? id : undefined;
}
export function sessionCli(
  state: Pick<ShowState, "round" | "sessions">,
  id: SessionId,
): Agent | undefined {
  return (
    state.round?.attempts[id]?.cli ??
    state.round?.sessions?.find((s) => s.id === id)?.cli ??
    state.sessions?.find((s) => s.id === id)?.cli ??
    legacyCli(id)
  );
}
// Old rounds stored the model and reasoning effort as one display label.
export function legacyModel(
  label: string,
): Pick<SessionConfig, "model" | "effort"> {
  const match = label.match(
    /^(.*?) · (minimal|low|medium|high|xhigh|max|ultra)$/,
  );
  return match ? { model: match[1]!, effort: match[2] } : { model: label };
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
  // Web searches and page fetches: the query, or the fetched host and path.
  | "web"
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
  // Opaque selection generation lets host fetches expire even while public content is hidden.
  hostContext?: number;
  presentation?: import("./presentation.js").Presentation;
  experience?: import("./sessions.js").Experience;
  sharedSession?: import("./sessions.js").SessionView;
  sharedOverlay?: import("./sessions.js").OverlayView;
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
  manualBreak?: { durationMs: number | null; deadline?: number };
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
  rehearsalRunnerMode?: RunnerMode;
  playlistIndex?: number;
  playlistTotal?: number;
  awaitingHostChoice?: boolean;
}

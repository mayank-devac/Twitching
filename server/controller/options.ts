// Controller configuration and integration contracts, kept apart from the
// round state machine so callers can import them without the controller.
import type { Agent, Round, SessionConfig } from "../../shared/types.js";
import type { RunnerMode } from "../../shared/schema.js";
import { sessionCount, type SessionCount } from "../../shared/types.js";
// Saved rounds keep their own session list; older ones fall back to the attempts that ran.
export const roundSessionCount = (round: Round): SessionCount =>
  sessionCount(round.sessions ?? Object.values(round.attempts).filter((a) => a.status !== "idle"));
export interface ControllerOptions {
  jevCriteria?: string;
  mode: "live" | "rehearsal";
  runnerMode?: RunnerMode;
  sessions?: SessionConfig[];
  singleAgent?: Agent;
  codexModel: string;
  codexEffort?: string;
  cursorModel: string;
  collectionMs: number;
  extensionMs: number;
  resultMs: number;
  reconnectLimitMs: number;
  quotaGraceMs: number;
  quotaPollMs: number;
  safetyThreshold: number;
  relevanceThreshold: number;
  minScore: number;
  playlist?: string[];
}
export type StopChoice =
  "chat-now" | "chat-after" | "stream-now" | "stream-after";
export type ChatPlatforms = {
  youtube?: boolean;
  twitch?: boolean;
  kick?: boolean;
};
export interface Integrations {
  start(): Promise<void>;
  startChats(platforms: ChatPlatforms): Promise<void>;
  stop(): void;
  preflight(): Promise<string[]>;
  stopBroadcast(): Promise<void>;
}
export function selectedPlatforms(platforms: ChatPlatforms) {
  const selected = {
    youtube: !!platforms.youtube,
    twitch: !!platforms.twitch,
    kick: !!platforms.kick,
  };
  if (!selected.youtube && !selected.twitch && !selected.kick)
    throw new Error("Pick YouTube, Twitch, or Kick before switching to chat");
  return selected;
}

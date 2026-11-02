import type { Agent, SessionConfig } from "../../shared/types.js";
import { validSessionId } from "../../shared/types.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { cursor } from "./cursor.js";
import type { CliAdapter, CliModel } from "./types.js";
export const cliAdapters: Record<Agent, CliAdapter> = { codex, cursor, claude };
export function validateSessions(sessions: SessionConfig[]) {
  if (
    sessions.length < 1 ||
    sessions.length > 2 ||
    new Set(sessions.map((s) => s.id)).size !== sessions.length
  )
    throw new Error("Choose one or two sessions with unique IDs");
  for (const session of sessions)
    if (
      !validSessionId(session.id) ||
      !cliAdapters[session.cli] ||
      !session.model.trim()
    )
      throw new Error("Invalid session ID, CLI or model");
}
export function validateModel(session: SessionConfig, models: CliModel[]) {
  const model = models.find((m) => m.id === session.model);
  if (
    !model ||
    (session.effort !== undefined && !model.efforts.includes(session.effort))
  )
    throw new Error(
      `${session.id}: ${session.cli} model ${session.model}${session.effort ? ` with ${session.effort} reasoning` : ""} is unavailable to the installed CLI/account; no model was substituted`,
    );
}

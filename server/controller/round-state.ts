// Pure helpers for the controller's round bookkeeping and host/public views.
import type {
  Activity,
  Round,
  SessionConfig,
  ShowState,
  Task,
} from "../../shared/types.js";
import { sessionLabel } from "../../shared/types.js";
import type { SettingsDocument } from "../../shared/settings.js";
import { MAX_PROMPT_CHARS } from "../filter.js";
import type { Store } from "../store.js";

// A freshly launched round: every configured session starts running at once.
export function newRound(id: number, task: Task, sessions: SessionConfig[], at: number): Round {
  return {
    id,
    task,
    launchedAt: at,
    sessions: structuredClone(sessions),
    attempts: Object.fromEntries(
      sessions.map((session) => [
        session.id,
        {
          cli: session.cli,
          model: session.model,
          effort: session.effort,
          status: "running",
          startedAt: at,
        },
      ]),
    ),
  };
}

// Records one activity event in state and SQLite. Returns true when the
// caller must broadcast it and persist: a changed known event, or a new one.
// Runner activity is already redacted at its source (accumulated text, never
// a fragment; see PairRunner.launch), and the redactor is idempotent, so a
// second full pass here would only repeat work on every streamed delta.
export function recordActivity(state: ShowState, store: Store, event: Activity) {
  const index = state.events.findIndex((e) => e.id === event.id);
  if (index >= 0) {
    if (state.events[index]!.text === event.text) return false;
    state.events[index] = event;
    store.replaceEvent(event);
    return true;
  }
  if (!store.event(event)) return false;
  state.events.push(event);
  state.events = state.events.slice(-160);
  return true;
}

// A redacted copy of the state with display-only fields filled in.
export function stateView(
  state: ShowState,
  doc: SettingsDocument | undefined,
  preparedVersion: string | undefined,
  configured: SessionConfig[],
  clean: (s: string, limit?: number) => string,
) {
  const value = structuredClone(state);
  if (doc)
    value.quickSettings = {
      revision: doc.revision,
      visibility: doc.value.visibility,
      media: doc.value.media,
    };
  if (preparedVersion) value.preparedVersion = preparedVersion;
  // A saved result keeps its own configuration, even after startup choices change.
  const sessions = value.round?.sessions ?? configured;
  value.sessions = sessions;
  value.agents = sessions.map((s) => s.id);
  value.models = Object.fromEntries(
    sessions.map((s) => [s.id, sessionLabel(s)]),
  );
  if (value.round) {
    value.round.task.text = clean(value.round.task.text, MAX_PROMPT_CHARS);
    value.round.task.author = clean(value.round.task.author, 80);
  }
  if (value.prepared) {
    value.prepared.text = clean(value.prepared.text, MAX_PROMPT_CHARS);
    value.prepared.author = clean(value.prepared.author, 80);
  }
  value.candidates = value.candidates.map((c) => ({
    ...c,
    text: clean(c.text, MAX_PROMPT_CHARS),
    message: {
      ...c.message,
      text: clean(c.message.text, MAX_PROMPT_CHARS),
      author: clean(c.message.author, 80),
    },
  }));
  value.reason = clean(value.reason);
  return value;
}

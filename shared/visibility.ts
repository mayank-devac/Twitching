// Public visibility of agent activity, shared by the arena and session paths.
//
// RULES AS THEY STOOD BEFORE THIS MODULE (pinned by tests/visibility.test.ts)
//
// Arena path (controller.snapshot -> publicActivity; host view is unfiltered):
//   A1 Choices: visibility[event.agent] ?? defaultVisibility.
//   A2 Filtering happens at view time; state and SQLite keep every event.
//   A3 lane "read": public only when choices.read and publicFile is exactly
//      `prompt_<event.round>.html`; becomes kind "tool", lane removed, text
//      "Read <publicFile>". choices.tool does not apply to it.
//   A4 lane "terminal": public only when choices.command; becomes kind
//      "command", lane removed, text kept.
//   A5 Any other lane ("write", "tool"): never public.
//   A6 No lane: public when choices[kind]; the event object passes unchanged.
//   A7 Text is not redacted here (runner text arrives redacted). stateView
//      redacts task/candidate/reason text and publishes `models` labels and
//      the whole quickSettings.visibility map; the client hides model, CLI
//      icon and CLI name from those flags.
//
// Session path (run ingest -> stored timeline -> view/publicView -> client):
//   S1 Choices: visibility[conversation.id] ?? visibility[slot] ??
//      defaultVisibility, slot = config.id, else the first configured session
//      with the same CLI, else the first configured session.
//   S2 Lanes are filtered at ingest: dropped events are never stored.
//   S3 lane "read": stored when publicFile is set at all (any filename the
//      parser validated, not only prompt_<round>.html); kind "read", text
//      "Read <publicFile>". Shown when choices.read.
//   S4 lane "terminal" and every other lane: never stored, whatever
//      choices.command says.
//   S5 No lane: stored for every kind; a "complete" event is stored with the
//      text "Agent finished". Shown when choices[kind].
//   S6 "prompt" items are always shown.
//   S7 Labels ("Read x", "Agent finished") and host text pass the redactor at
//      ingest; activity text is stored as the runner sent it (redacted).
//   S8 publicView drops config, providerId and pendingRun, blanks project,
//      sets model to undefined unless choices.model, marks published, and
//      re-filters kinds with the current choices. latestRun falls back to the
//      last item's run. hidePreviousRuns is passed through; the client
//      (visibleTimeline) applies it together with the same kind rule.
//
// DIFFERENCES (kept as they are; each path passes its own policy below)
//   - Choice lookup key: agent slot only (A1) vs conversation, then slot (S1).
//   - Read files: exact prompt_<round>.html (A3) vs any validated file (S3).
//   - Read row kind: "tool" (A3) vs "read" (S3).
//   - Terminal lane: shown as "command" when allowed (A4) vs never (S4).
//   - When lanes are filtered: view time (A2) vs ingest time (S2).
//   - "complete" text: kept (A6) vs "Agent finished" (S5).
//   - "prompt" rows exist only in sessions (S6).
//   - Model: arena publishes labels and leaves hiding to the client (A7);
//     sessions remove the model server-side (S8).
//   - hidePreviousRuns exists only for sessions (S8).

import type { Activity, ActivityKind } from "./types.js";
import type { Conversation, SessionView, TimelineItem, TimelinePage } from "./sessions.js";
import { defaultVisibility, type SessionVisibility } from "./settings.js";

// The first entry found under the given keys, else defaults (A1, S1). A key
// may be a function so it is only computed when the earlier keys miss.
export function visibilityFor(
  map: Record<string, SessionVisibility>,
  ...keys: (string | (() => string))[]
): SessionVisibility {
  for (const key of keys) {
    const choices = map[typeof key === "string" ? key : key()];
    if (choices != null) return choices;
  }
  return defaultVisibility;
}

// Prompts are always shown; every other kind follows its own setting (A6, S5, S6).
export function kindVisible(visibility: SessionVisibility, kind: TimelineItem["kind"]) {
  return kind === "prompt" || visibility[kind];
}

// How one path turns lanes into public rows. Each path keeps its own rules.
export interface LanePolicy<ReadKind extends string> {
  // Called only when publicFile is set; true lets the row name that file.
  readFile(event: Activity): boolean;
  readKind: ReadKind;
  terminalAsCommand: boolean;
  // Unlaned kinds filtered during projection; omitted means keep every kind.
  showKind?(kind: ActivityKind): boolean;
  // Replaces the text of an unlaned "complete" event.
  completeLabel?: string;
}
export interface ProjectedActivity<ReadKind extends string> {
  kind: ActivityKind | ReadKind;
  text: string;
  // The text is composed here, not runner text, so callers that store it redact it.
  labelled: boolean;
}

// The public row for one event, or undefined when it must stay private.
export function projectActivity<ReadKind extends string>(
  event: Activity,
  policy: LanePolicy<ReadKind>,
): ProjectedActivity<ReadKind> | undefined {
  if (event.lane === "read") {
    // Read contents are never published; only a validated file name may be.
    if (!event.publicFile || !policy.readFile(event)) return undefined;
    return { kind: policy.readKind, text: `Read ${event.publicFile}`, labelled: true };
  }
  if (event.lane === "terminal" && policy.terminalAsCommand)
    return { kind: "command", text: event.text, labelled: false };
  // Host-only command lanes remain private.
  if (event.lane) return undefined;
  if (policy.showKind && !policy.showKind(event.kind)) return undefined;
  if (policy.completeLabel !== undefined && event.kind === "complete")
    return { kind: "complete", text: policy.completeLabel, labelled: true };
  return { kind: event.kind, text: event.text, labelled: false };
}

// Arena rules A3-A6 for one session slot's choices.
export function arenaLanePolicy(choices: SessionVisibility): LanePolicy<"tool"> {
  return {
    // Parsers attach publicFile only after checking the exact arena-relative filename.
    readFile: (event) => choices.read && event.publicFile === `prompt_${event.round}.html`,
    readKind: "tool",
    terminalAsCommand: choices.command,
    showKind: (kind) => kindVisible(choices, kind),
  };
}

// Session ingest rules S3-S5; kinds are filtered later, at view time.
export const sessionLanePolicy: LanePolicy<"read"> = {
  readFile: () => true,
  readKind: "read",
  terminalAsCommand: false,
  completeLabel: "Agent finished",
};

// Presentation filtering never deletes events or sends host search strings/file contents.
export function publicActivity(
  events: Activity[],
  visibility: Record<string, SessionVisibility>,
) {
  return events.flatMap<Activity>((event) => {
    const row = projectActivity(event, arenaLanePolicy(visibilityFor(visibility, event.agent)));
    if (!row) return [];
    return event.lane ? [{ ...event, lane: undefined, kind: row.kind, text: row.text }] : [event];
  });
}

// A page holding only the kinds these choices show (S6, S8).
export function visiblePage(page: TimelinePage, visibility: SessionVisibility): TimelinePage {
  return {
    ...page,
    latestRun: page.latestRun ?? page.items.at(-1)?.run,
    items: page.items.filter((item) => kindVisible(visibility, item.kind)),
  };
}

// The audience copy of a session view (S8).
export function publicSessionView(view: SessionView, visibility: SessionVisibility): SessionView {
  const {
    config: _config,
    providerId: _provider,
    pendingRun: _pending,
    ...c
  } = view.conversation;
  const conversation: Conversation = {
    ...c,
    project: "",
    model: visibility.model ? c.model : undefined,
    // Sessions saved before effort was stored fall back to their saved config.
    effort: visibility.effort !== false ? (c.effort ?? _config?.effort) : undefined,
  };
  return {
    ...view,
    visibility,
    page: visiblePage(view.page, visibility),
    hidePreviousRuns: !!visibility.hidePreviousRuns,
    conversation,
    published: true,
  };
}

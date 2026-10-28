import type { Activity } from "../shared/types.js";
import type { HistoryPage, QuickPreferences } from "../shared/settings.js";
import { defaultVisibility } from "../shared/settings.js";

// Presentation filtering never deletes events or sends host search strings/file contents.
export function publicActivity(
  events: Activity[],
  visibility: QuickPreferences["visibility"],
) {
  return events.flatMap<Activity>((event) => {
    const choices = visibility[event.agent] ?? defaultVisibility;
    if (event.lane === "read") {
      // Parsers attach publicFile only after checking the exact arena-relative filename.
      return choices.read && event.publicFile === `prompt_${event.round}.html`
        ? [
            {
              ...event,
              lane: undefined,
              kind: "tool",
              text: `Read ${event.publicFile}`,
            },
          ]
        : [];
    }
    if (event.lane === "terminal" && choices.command)
      return [{ ...event, lane: undefined, kind: "command" }];
    if (event.lane || !choices[event.kind]) return [];
    return [event];
  });
}
// Stored history uses the same redactor as live text; preview locations remain private.
export function historyView(
  page: HistoryPage,
  clean: (text: string, limit?: number) => string,
): HistoryPage {
  return {
    ...page,
    rounds: page.rounds.map((round) => ({
      ...round,
      task: {
        ...round.task,
        text: clean(round.task.text, 600),
        author: clean(round.task.author, 80),
      },
      attempts: Object.fromEntries(
        Object.entries(round.attempts).map(([id, attempt]) => [
          id,
          {
            ...attempt,
            preview: undefined,
            error: attempt.error ? clean(attempt.error) : undefined,
          },
        ]),
      ),
    })),
  };
}

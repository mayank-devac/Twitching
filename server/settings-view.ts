import type { HistoryPage } from "../shared/settings.js";

// The arena projection lives with the session rules in shared/visibility.ts.
export { publicActivity } from "../shared/visibility.js";
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

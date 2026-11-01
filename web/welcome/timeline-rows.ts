import type { TimelineItem } from "../../shared/sessions.js";

// Row labels and grouping rules for the session timeline.

type Kind = TimelineItem["kind"];

const kindLabel = {
  prompt: "You",
  message: "Message",
  summary: "Summary",
  edit: "File edited",
  tool: "Tool used",
  command: "Command",
  error: "Error",
  complete: "Completed",
  output: "Output",
  read: "File read",
} satisfies Record<Kind, string>;

// Label shown when several label-only rows are merged into one.
const pluralLabel: Partial<Record<Kind, (count: number) => string>> = {
  edit: (n) => `${n} file edits`,
  tool: (n) => `${n} tools used`,
};

export function rowLabel(kind: Kind, count: number) {
  const plural = pluralLabel[kind];
  return count > 1 && plural ? plural(count) : kindLabel[kind];
}

// Placeholder rows say nothing beyond their label, so only the label is shown.
export const isPlaceholder = (item: Pick<TimelineItem, "placeholder">) =>
  item.placeholder === true;

// Neighbouring placeholder rows of the same kind and run become one row with a count.
export function groupRows<
  T extends Pick<TimelineItem, "kind" | "run" | "placeholder">,
>(items: T[]) {
  const rows: Array<{ item: T; count: number }> = [];
  for (const item of items) {
    const last = rows.at(-1);
    const mergesWithLast =
      last &&
      isPlaceholder(item) &&
      isPlaceholder(last.item) &&
      last.item.kind === item.kind &&
      last.item.run === item.run;
    if (mergesWithLast) last.count++;
    else rows.push({ item, count: 1 });
  }
  return rows;
}

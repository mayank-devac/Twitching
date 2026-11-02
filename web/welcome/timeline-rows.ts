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
  web: "Web search",
  error: "Error",
  complete: "Completed",
  output: "Output",
  read: "File read",
} satisfies Record<Kind, string>;

// Label shown when several label-only rows are merged into one.
// Merged rows of these kinds keep their own bodies, one per line under the count.
export const columnKinds = new Set<Kind>(["message", "web", "summary", "output"]);

const pluralLabel: Partial<Record<Kind, (count: number) => string>> = {
  edit: (n) => `${n} files edited`,
  tool: (n) => `${n} tools used`,
  read: (n) => `${n} files read`,
  message: (n) => `${n} messages`,
  web: (n) => `${n} web searches`,
  summary: (n) => `${n} summaries`,
  output: (n) => `${n} outputs`,
  command: (n) => `${n} commands`,
};

export function rowLabel(kind: Kind, count: number) {
  const plural = pluralLabel[kind];
  return count > 1 && plural ? plural(count) : kindLabel[kind];
}

// Placeholder rows say nothing beyond their label, so only the label is shown.
export const isPlaceholder = (item: Pick<TimelineItem, "placeholder">) =>
  item.placeholder === true;

// "Command: grep, head (recorded)" -> ["grep", "head"]
const commandNames = (text: string) =>
  text
    .replace(/^Command:\s*/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .split(", ")
    .filter(Boolean);

// "Command: grep ×3, head ×2, sed" — how many commands used each program.
export function mergedCommandText(texts: string[]) {
  const counts = new Map<string, number>();
  for (const text of texts)
    for (const name of new Set(commandNames(text)))
      counts.set(name, (counts.get(name) ?? 0) + 1);
  const parts = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
  return `Command: ${parts.join(", ")}`;
}

// "Grep ×3, Task" — tool names with how many times each was used.
export function mergedToolText(texts: string[]) {
  const counts = new Map<string, number>();
  for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
}

// Neighbouring placeholder rows, and neighbouring command rows, of the same kind and run
// become one row. Placeholders get a count; commands get a per-program count in `text`.
export function groupRows<
  T extends Pick<TimelineItem, "kind" | "run" | "placeholder" | "text">,
>(items: T[]) {
  // `items` holds every merged row; `text` replaces the body of a merged command/read row;
  // merged messages keep their own bodies and are shown as a column.
  const rows: Array<{ item: T; items: T[]; count: number; text?: string; texts: string[] }> = [];
  for (const item of items) {
    const last = rows.at(-1);
    const sameRun = last && last.item.kind === item.kind && last.item.run === item.run;
    if (sameRun && isPlaceholder(item) && isPlaceholder(last.item)) last.count++;
    else if (
      sameRun &&
      !["prompt", "error", "complete"].includes(item.kind) &&
      // Edit rows merge only when both name their file; bare placeholders merge above.
      (item.kind !== "edit" || (!isPlaceholder(item) && !isPlaceholder(last.item)))
    ) {
      last.count++;
      last.items.push(item);
      last.texts.push(item.text);
      const names = (prefix: RegExp) => [
        ...new Set(last.texts.map((t) => t.replace(prefix, ""))),
      ].join(", ");
      if (item.kind === "command") last.text = mergedCommandText(last.texts);
      else if (item.kind === "tool") last.text = mergedToolText(last.texts);
      else if (item.kind === "read") last.text = `Read ${names(/^Read\s+/)}`;
      else if (item.kind === "edit") last.text = `Edited ${names(/^Edited\s+/)}`;
    } else rows.push({ item, items: [item], count: 1, texts: [item.text] });
  }
  return rows;
}

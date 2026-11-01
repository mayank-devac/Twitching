// Row labels and grouping rules for the session timeline.

const kindLabel:Record<string, string> = {
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
};

// Label shown when several label-only rows are merged into one.
const pluralLabel: Record<string, (count: number) => string> = {
  edit: (n) => `${n} file edits`,
  tool: (n) => `${n} tools used`,
};

// Placeholder bodies that say nothing beyond the label: the row shows only the label.
export const placeholderText = new Set(["Files edited", "Recorded tool activity"]);

export function rowLabel(kind: string, count: number) {
  return count > 1 && pluralLabel[kind]
    ? pluralLabel[kind](count)
    : (kindLabel[kind] ?? kind);
}

// Neighbouring placeholder rows of the same kind and run become one row with a count.
export function groupRows<T extends { kind: string; run: string; text: string }>(
  items: T[],
) {
  const rows: Array<{ item: T; count: number }> = [];
  for (const item of items) {
    const last = rows.at(-1);
    const mergesWithLast =
      last &&
      placeholderText.has(item.text) &&
      placeholderText.has(last.item.text) &&
      last.item.kind === item.kind &&
      last.item.run === item.run;
    if (mergesWithLast) last.count++;
    else rows.push({ item, count: 1 });
  }
  return rows;
}

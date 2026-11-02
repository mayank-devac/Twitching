import type { SessionVisibility } from "./settings.js";
import type { TimelineItem } from "./sessions.js";
import { kindVisible, withFileName } from "./visibility.js";

// Hiding old runs filters only this render; loaded and stored items are retained.
export function visibleTimeline(
  items: TimelineItem[],
  visibility: SessionVisibility,
  hidePrevious: boolean,
  showPrevious: boolean,
  latestRun?: string,
) {
  return items
    .filter(
      (item) =>
        kindVisible(visibility, item.kind) &&
        (!hidePrevious || showPrevious || item.run === latestRun),
    )
    .map((item) => withFileName(item, visibility));
}
export function mergeTimeline(older: TimelineItem[], newer: TimelineItem[]) {
  const merged = new Map(older.map((item) => [item.id, item]));
  for (const item of newer) merged.set(item.id, item);
  // Rows that first appear later (e.g. commands switched on after the page loaded) must
  // land where they happened, not at the end: order by time, then by block order in a record.
  // Sort keys are computed once per row; a record's rows share a base id ("uuid:index").
  // Ties on time fall back to where the record first appeared, then block index, so the
  // order is total (and stable across polls) whatever the id shapes are.
  const firstSeen = new Map<string, number>();
  const keyed = [...merged.values()].map((item, position) => {
    const cut = item.id.lastIndexOf(":");
    const index = cut < 0 ? Number.NaN : Number(item.id.slice(cut + 1));
    const base = Number.isNaN(index) ? item.id : item.id.slice(0, cut);
    if (!firstSeen.has(base)) firstSeen.set(base, position);
    return { item, base, index: Number.isNaN(index) ? 0 : index };
  });
  return keyed
    .sort(
      (a, b) =>
        a.item.at - b.item.at ||
        firstSeen.get(a.base)! - firstSeen.get(b.base)! ||
        a.index - b.index,
    )
    .map((k) => k.item);
}

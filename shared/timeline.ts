import type { SessionVisibility } from "./settings.js";
import type { TimelineItem } from "./sessions.js";
import { kindVisible } from "./visibility.js";

// Hiding old runs filters only this render; loaded and stored items are retained.
export function visibleTimeline(
  items: TimelineItem[],
  visibility: SessionVisibility,
  hidePrevious: boolean,
  showPrevious: boolean,
  latestRun?: string,
) {
  return items.filter(
    (item) =>
      kindVisible(visibility, item.kind) &&
      (!hidePrevious || showPrevious || item.run === latestRun),
  );
}
export function mergeTimeline(older: TimelineItem[], newer: TimelineItem[]) {
  const merged = new Map(older.map((item) => [item.id, item]));
  for (const item of newer) merged.set(item.id, item);
  return [...merged.values()];
}

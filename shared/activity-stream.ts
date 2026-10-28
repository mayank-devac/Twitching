import type { Activity } from "./types.js";

export interface ActivityPatch {
  event: Activity;
  prefixLength?: number;
}

export function activityPatches(previous: Activity[], next: Activity[]): ActivityPatch[] {
  const old = new Map(previous.map((event) => [event.id, event]));
  return next.flatMap<ActivityPatch>((event) => {
    const before = old.get(event.id);
    if (before && before.text === event.text) return [];
    if (before && event.text.startsWith(before.text))
      return [{ event: { ...event, text: event.text.slice(before.text.length) },
        prefixLength: before.text.length }];
    return [{ event }];
  });
}

export function mergeActivityPatches(previous: Activity[], patches: ActivityPatch[], ids: string[]) {
  const events = new Map(previous.map((event) => [event.id, event]));
  for (const { event, prefixLength } of patches) {
    const before = events.get(event.id);
    if (prefixLength !== undefined && (!before || before.text.length < prefixLength))
      throw new Error("Missing activity text; reconnect for a full snapshot");
    events.set(event.id, prefixLength === undefined ? event : {
      ...event, text: before!.text.slice(0, prefixLength) + event.text,
    });
  }
  return ids.map((id) => {
    const event = events.get(id);
    if (!event) throw new Error("Missing activity; reconnect for a full snapshot");
    return event;
  });
}

import type { Activity } from "./types.js";

type TextItem = { id: string; text: string };
export interface ActivityPatch<T extends TextItem = Activity> {
  event: T;
  prefixLength?: number;
}

export function activityPatches<T extends TextItem = Activity>(
  previous: T[],
  next: T[],
): ActivityPatch<T>[] {
  const old = new Map(previous.map((event) => [event.id, event]));
  return next.flatMap<ActivityPatch<T>>((event) => {
    const before = old.get(event.id);
    if (before && before.text === event.text) return [];
    if (before && event.text.startsWith(before.text))
      return [
        {
          event: { ...event, text: event.text.slice(before.text.length) },
          prefixLength: before.text.length,
        },
      ];
    return [{ event }];
  });
}

export function mergeActivityPatches<T extends TextItem = Activity>(
  previous: T[],
  patches: ActivityPatch<T>[],
  ids: string[],
) {
  const events = new Map(previous.map((event) => [event.id, event]));
  for (const { event, prefixLength } of patches) {
    const before = events.get(event.id);
    if (
      prefixLength !== undefined &&
      (!before || before.text.length < prefixLength)
    )
      throw new Error("Missing activity text; reconnect for a full snapshot");
    events.set(
      event.id,
      prefixLength === undefined
        ? event
        : {
            ...event,
            text: before!.text.slice(0, prefixLength) + event.text,
          },
    );
  }
  return ids.map((id) => {
    const event = events.get(id);
    if (!event)
      throw new Error("Missing activity; reconnect for a full snapshot");
    return event;
  });
}

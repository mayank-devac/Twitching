import {
  activityPatches,
  mergeActivityPatches,
  type ActivityPatch,
} from "./activity-stream.js";
import type { OverlayView, TimelineItem } from "./sessions.js";

export interface OverlayFramePatch {
  id: string;
  patches: ActivityPatch<TimelineItem>[];
  ids: string[];
}
// Each output and each conversation has its own ledger, including when outputs share a session.
export function overlayPatches(
  previous: OverlayView | undefined,
  next: OverlayView | undefined,
): OverlayFramePatch[] {
  return (
    next?.frames.map((frame) => {
      const old =
        previous?.id === next.id
          ? previous.frames.find(
              (value) => value.conversation.id === frame.conversation.id,
            )
          : undefined;
      return {
        id: frame.conversation.id,
        patches: activityPatches(old?.page.items ?? [], frame.page.items),
        ids: frame.page.items.map((item) => item.id),
      };
    }) ?? []
  );
}
export function applyOverlayPatches(
  previous: OverlayView | undefined,
  next: OverlayView,
  patches: OverlayFramePatch[],
): OverlayView {
  return {
    ...next,
    frames: next.frames.map((frame) => {
      const patch = patches.find((value) => value.id === frame.conversation.id);
      if (!patch)
        throw new Error("Missing overlay frame; reconnect for a snapshot");
      const old =
        previous?.id === next.id
          ? previous.frames.find(
              (value) => value.conversation.id === frame.conversation.id,
            )
          : undefined;
      return {
        ...frame,
        page: {
          ...frame.page,
          items: mergeActivityPatches(
            old?.page.items ?? [],
            patch.patches,
            patch.ids,
          ),
        },
      };
    }),
  };
}

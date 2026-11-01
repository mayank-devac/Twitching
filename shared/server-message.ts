import type { ActivityPatch } from "./activity-stream.js";
import type { OverlayFramePatch } from "./overlay-stream.js";
import type { TimelineItem } from "./sessions.js";
import type { Activity, ShowState } from "./types.js";

// Frames the server pushes on the read-only /events socket (see server/http.ts).
// A snapshot carries complete state; an update carries state with emptied
// event/item lists plus the patches that rebuild them from the previous frame.
export interface SnapshotMessage {
  type: "snapshot";
  state: ShowState;
  previewOrigin: string;
}
export interface UpdateMessage {
  type: "update";
  state: ShowState;
  previewOrigin: string;
  patches: ActivityPatch[];
  eventIds: string[];
  overlayPatches: OverlayFramePatch[];
  sessionPatches: ActivityPatch<TimelineItem>[];
  sessionItemIds: string[];
}
export type ServerMessage = SnapshotMessage | UpdateMessage;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const isTextItem = (value: unknown) =>
  isRecord(value) && typeof value.id === "string" && typeof value.text === "string";
const isPatchList = <T extends Activity | TimelineItem>(
  value: unknown,
): value is ActivityPatch<T>[] =>
  Array.isArray(value) &&
  value.every(
    (patch) =>
      isRecord(patch) &&
      isTextItem(patch.event) &&
      (patch.prefixLength === undefined || typeof patch.prefixLength === "number"),
  );
const isSessionView = (value: unknown) =>
  isRecord(value) &&
  isRecord(value.conversation) &&
  typeof value.conversation.id === "string" &&
  isRecord(value.page) &&
  Array.isArray(value.page.items) &&
  value.page.items.every(isTextItem);

// Only the fields the client merges or indexes into are checked; the rest of
// ShowState is display data the server already validated before sending.
function isShowState(value: unknown): value is ShowState {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (!Array.isArray(value.events) || !value.events.every(isTextItem)) return false;
  if (value.presentation !== undefined && !isRecord(value.presentation)) return false;
  if (value.sharedSession !== undefined && !isSessionView(value.sharedSession)) return false;
  const overlay = value.sharedOverlay;
  return (
    overlay === undefined ||
    (isRecord(overlay) && Array.isArray(overlay.frames) && overlay.frames.every(isSessionView))
  );
}
const isOverlayPatchList = (value: unknown): value is OverlayFramePatch[] =>
  Array.isArray(value) &&
  value.every(
    (frame) =>
      isRecord(frame) &&
      typeof frame.id === "string" &&
      isPatchList<TimelineItem>(frame.patches) &&
      isStringArray(frame.ids),
  );

// Throws on anything that is not a well-formed frame, so callers can reject it whole.
export function parseServerMessage(data: unknown): ServerMessage {
  const value: unknown = typeof data === "string" ? JSON.parse(data) : undefined;
  if (!isRecord(value) || !isShowState(value.state))
    throw new Error("Malformed server message");
  const previewOrigin = typeof value.previewOrigin === "string" ? value.previewOrigin : "";
  if (value.type === "snapshot")
    return { type: "snapshot", state: value.state, previewOrigin };
  if (value.type !== "update") throw new Error("Unknown server message");
  // JSON drops empty optional lists, so missing session/overlay patches mean none.
  const overlayPatches = value.overlayPatches ?? [];
  const sessionPatches = value.sessionPatches ?? [];
  const sessionItemIds = value.sessionItemIds ?? [];
  if (
    !isPatchList<Activity>(value.patches) ||
    !isStringArray(value.eventIds) ||
    !isOverlayPatchList(overlayPatches) ||
    !isPatchList<TimelineItem>(sessionPatches) ||
    !isStringArray(sessionItemIds)
  )
    throw new Error("Malformed server update");
  return {
    type: "update",
    state: value.state,
    previewOrigin,
    patches: value.patches,
    eventIds: value.eventIds,
    overlayPatches,
    sessionPatches,
    sessionItemIds,
  };
}

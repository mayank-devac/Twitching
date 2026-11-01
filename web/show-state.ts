// Pure merges of /events frames and authenticated host refreshes into the live ShowState.
import { mergeActivityPatches } from "../shared/activity-stream.js";
import { applyOverlayPatches } from "../shared/overlay-stream.js";
import type { UpdateMessage } from "../shared/server-message.js";
import type { OverlayView } from "../shared/sessions.js";
import type { ShowState } from "../shared/types.js";

// A single-frame overlay doubles as the published session; several frames have none.
const soleFrame = (overlay: OverlayView) =>
  overlay.frames.length === 1 ? overlay.frames[0] : undefined;

// Hidden sockets carry no transcript, so the host keeps its last private view, marked
// hidden, until the authenticated refresh supplies the private content.
function hiddenHostView(current: ShowState, incoming: ShowState): ShowState {
  return {
    ...current,
    presentation: current.presentation
      ? { ...current.presentation, hidden: true }
      : incoming.presentation,
  };
}

// The private CLI lanes come only from host refreshes, so frames carry them over.
const hostLanes = (current: ShowState | undefined, keep: boolean) =>
  keep ? (current?.events.filter((event) => event.lane) ?? []) : [];

// What a host refresh belongs to; when it changes, in-flight refreshes are stale.
// An old session/connection must never overwrite a newer private host lane.
export const hostContextKey = (incoming: ShowState) =>
  JSON.stringify([
    incoming.hostContext,
    incoming.experience,
    incoming.round?.id,
    incoming.sharedOverlay?.frames.map((f) => f.conversation.id),
    incoming.presentation?.hidden,
  ]);

// `host` is true only on an authenticated host page, where private lanes exist.
export function applySnapshot(
  current: ShowState | undefined,
  incoming: ShowState,
  host: boolean,
  changedContext: boolean,
): ShowState {
  const snapshot: ShowState = incoming.sharedOverlay
    ? { ...incoming, sharedSession: soleFrame(incoming.sharedOverlay) }
    : incoming;
  if (!host) return snapshot;
  if (snapshot.presentation?.hidden && current) return hiddenHostView(current, snapshot);
  return {
    ...snapshot,
    events: [...snapshot.events, ...hostLanes(current, !changedContext)],
  };
}

// Throws when the patches do not fit the previous frame; the caller then reconnects.
export function applyUpdate(
  current: ShowState | undefined,
  message: UpdateMessage,
  host: boolean,
  changedContext: boolean,
): ShowState {
  const incoming = message.state;
  if (host && incoming.presentation?.hidden && current) return hiddenHostView(current, incoming);
  const events = mergeActivityPatches(current?.events ?? [], message.patches, message.eventIds);
  // Build new objects rather than mutating the parsed frame: React may
  // replay this updater, and a mutated frame would be patched twice.
  let { sharedOverlay, sharedSession } = incoming;
  if (sharedOverlay) {
    sharedOverlay = applyOverlayPatches(current?.sharedOverlay, sharedOverlay, message.overlayPatches);
    sharedSession = soleFrame(sharedOverlay);
  } else if (sharedSession) {
    sharedSession = {
      ...sharedSession,
      page: {
        ...sharedSession.page,
        items: mergeActivityPatches(
          current?.sharedSession?.conversation.id === sharedSession.conversation.id
            ? current.sharedSession.page.items
            : [],
          message.sessionPatches,
          message.sessionItemIds,
        ),
      },
    };
  }
  return {
    ...incoming,
    sharedOverlay,
    sharedSession,
    events: [...events, ...hostLanes(current, host && !changedContext)],
  };
}

// A host refresh replaces everything but keeps the live public transcript, unless the
// output is hidden and the refresh is the only source of content.
export function applyHostState(current: ShowState | undefined, hostState: ShowState): ShowState {
  return {
    ...hostState,
    events:
      current && !hostState.presentation?.hidden
        ? [
            ...current.events.filter((event) => !event.lane),
            ...hostState.events.filter((event) => event.lane),
          ]
        : hostState.events,
  };
}

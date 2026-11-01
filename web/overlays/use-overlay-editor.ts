import { useEffect, useRef, useState } from "react";
import {
  MAX_OVERLAY_SESSIONS,
  type OverlayDefinition,
  type OverlayHostDocument,
  type OverlaySelection,
} from "../../shared/sessions.js";
import { hostRequest } from "../settings/api.js";
import { useUnsavedWarning } from "../settings/use-unsaved-warning.js";
import { useHostAction } from "../use-host-action.js";

// Draft assignments stay private until Apply; revisions reject another tab's stale edits.
export function useOverlayEditor(token: string) {
  const [overlayDoc, setOverlayDoc] = useState<OverlayHostDocument>();
  const [draft, setDraft] = useState<OverlayDefinition>();
  const [baseline, setBaseline] = useState("");
  const [revision, setRevision] = useState(0);
  const { busy, error, notice, setError, setNotice, run } = useHostAction();
  const [loadError, setLoadError] = useState("");
  const [captureRequested, setCaptureRequested] = useState(false);
  const dirty =
    !!draft && (JSON.stringify(draft) !== baseline || captureRequested);
  const confirmLeave = useUnsavedWarning(dirty);
  const current = useRef({ overlayDoc, draft, dirty, busy });
  current.current = { overlayDoc, draft, dirty, busy };
  // Last poll payload, the document object it produced, and whether the draft
  // was reset from it; an identical poll then needs no state update at all.
  const polled = useRef<{
    text: string;
    overlayDoc?: OverlayHostDocument;
    accepted: boolean;
  }>({ text: "", accepted: false });
  function accept(
    next: OverlayHostDocument,
    id = current.current.draft?.id ?? "default",
  ) {
    const overlay =
      next.overlays.find((value) => value.id === id) ?? next.overlays[0];
    setOverlayDoc(next);
    setDraft(structuredClone(overlay));
    setBaseline(JSON.stringify(overlay));
    setRevision(next.revision);
    setCaptureRequested(false);
  }
  useEffect(() => {
    if (!token) return;
    let closed = false,
      pending = false;
    const read = async () => {
      if (pending || current.current.busy) return;
      pending = true;
      try {
        const next = await hostRequest<OverlayHostDocument>(
          token,
          "/api/sessions/overlays",
        );
        if (!closed) {
          setLoadError("");
          // OverlayHostDocument.revision does not cover running sessions or
          // presentation state, so compare the whole payload instead.
          const text = JSON.stringify(next);
          const last = polled.current;
          const shown = current.current;
          const editing = !!shown.draft && shown.dirty;
          if (
            text === last.text &&
            shown.overlayDoc === last.overlayDoc &&
            (editing || last.accepted)
          )
            return;
          setOverlayDoc(next);
          if (!editing) accept(next);
          polled.current = { text, overlayDoc: next, accepted: !editing };
        }
      } catch (e) {
        if (!closed)
          setLoadError(e instanceof Error ? e.message : "Overlays unavailable");
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = setInterval(() => {
      void read();
    }, 2500);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [token]);
  async function mutate(body: unknown) {
    if (busy) return false;
    const saved = await run(async () => {
      const next = await hostRequest<
        OverlayHostDocument & { createdId?: string }
      >(token, "/api/sessions/overlays", body);
      accept(next, next.createdId ?? draft?.id);
      setNotice("Overlay saved. Coding sessions keep running.");
      return true;
    }, "Overlay change failed");
    return saved ?? false;
  }
  function select(id: string) {
    if (overlayDoc && confirmLeave()) {
      accept(overlayDoc, id);
      setError("");
      setNotice("");
    }
  }
  function toggle(id: string) {
    if (!draft || busy) return;
    if (draft.selection === "follow-running") {
      setError("Choose Selected sessions to edit individual checkboxes.");
      return;
    }
    const ids = draft.sessionIds.includes(id)
      ? draft.sessionIds.filter((value) => value !== id)
      : [...draft.sessionIds, id];
    if (ids.length > MAX_OVERLAY_SESSIONS) {
      setError("Each overlay can show up to eight sessions.");
      return;
    }
    setDraft({ ...draft, selection: "selected", sessionIds: ids });
    setCaptureRequested(false);
    setError("");
    setNotice("");
  }
  function selection(mode: OverlaySelection) {
    if (!draft || !overlayDoc) return;
    setError("");
    setNotice("");
    setDraft({
      ...draft,
      selection: mode,
      sessionIds:
        mode === "selected"
          ? draft.sessionIds
          : overlayDoc.running
              .slice(0, MAX_OVERLAY_SESSIONS)
              .map((conversation) => conversation.id),
    });
    setCaptureRequested(mode === "running-snapshot");
  }
  function apply(published = draft?.published ?? false) {
    if (!draft) return Promise.resolve();
    return mutate({
      action: "save",
      captureRunning: captureRequested,
      revision,
      overlay: {
        id: draft.id,
        name: draft.name,
        selection: draft.selection,
        sessionIds: draft.sessionIds,
        published,
      },
    });
  }
  return {
    overlayDoc,
    draft,
    busy,
    dirty,
    error: error || loadError,
    notice,
    stale: !!overlayDoc && overlayDoc.revision !== revision,
    select,
    toggle,
    selection,
    capture: () => {
      if (draft && overlayDoc) {
        setDraft({
          ...draft,
          sessionIds: overlayDoc.running
            .slice(0, MAX_OVERLAY_SESSIONS)
            .map((conversation) => conversation.id),
        });
        setCaptureRequested(true);
      }
    },
    apply,
    setDraft,
    create: (name: string) =>
      mutate({ action: "create", revision: overlayDoc?.revision, name }),
    remove: () => draft && mutate({ action: "delete", revision, id: draft.id }),
    stop: () => draft && mutate({ action: "stop", id: draft.id }),
    reload: () => overlayDoc && accept(overlayDoc),
  };
}
export type OverlayEditor = ReturnType<typeof useOverlayEditor>;

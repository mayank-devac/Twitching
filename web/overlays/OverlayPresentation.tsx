import React, { useEffect, useId, useState } from "react";
import type { PresentationSelection } from "../../shared/presentation.js";
import { PresentationControls } from "../presentation-controls.js";
import { hostRequest } from "../settings/api.js";
import { useHostAction } from "../use-host-action.js";

// Presentation controls live in the top nav as a compact status button;
// the popover carries the goal source, privacy buttons and notes.
export function OverlayPresentation({ token, overlayId, name, initial, published }: {
  token: string; overlayId: string; name: string; initial?: PresentationSelection; published: boolean;
}) {
  const [selection, setSelection] = useState(initial);
  const { busy, error, run } = useHostAction();
  const panelId = useId();
  useEffect(() => {
    if (initial) setSelection((current) => !current || initial.revision >= current.revision ? initial : current);
  }, [initial]);
  const action = (body: Record<string, unknown>) => run(async () => {
    setSelection(await hostRequest<PresentationSelection>(token, "/api/presentation", { ...body, overlay: overlayId }));
  }, "Output controls unavailable");
  if (!selection) return null;
  const dot = selection.globalHidden ? "danger" : selection.own.hidden ? "warn" : "ok";
  const status = selection.globalHidden ? "All overlays hidden" : selection.own.hidden ? "This overlay hidden" : "Visible when published";
  return <div className="overlay-presentation">
    <button
      type="button"
      className="host-tool-button"
      popoverTarget={panelId}
      title={`${name} presentation: goal, stopwatch and overlay privacy`}
      aria-label="Overlay presentation controls"
    >
      <span className={`presentation-dot ${dot}`} aria-hidden="true" />
      Presentation
    </button>
    <div id={panelId} popover="auto" role="dialog" aria-label={`${name} presentation`} className="host-popover presentation-popover">
      <header className="host-popover-heading">
        <div><h2>{name} · presentation</h2><p>{status}</p></div>
        <button type="button" popoverTarget={panelId} popoverTargetAction="hide" aria-label="Close presentation controls">×</button>
      </header>
      <label className="presentation-source-label">
        Goal &amp; stopwatch
        <select value={selection.source} disabled={busy} onChange={(event) => void action({ action: "goal-source", source: event.target.value })}>
          <option value="own">Own goal + stopwatch</option>
          <option value="shared">Shared goal + stopwatch</option>
        </select>
      </label>
      <div className="presentation-controls-row">
        <PresentationControls value={selection.value} token={token} overlayId={overlayId} privacyHidden={selection.own.hidden} globalHidden={selection.globalHidden} source={selection.source} onUpdated={setSelection} showShortcuts={false} />
      </div>
      <div className="overlay-presentation-footer">
        <small>{selection.source === "shared" ? "Shared by every output using this pair." : "Only this output uses this pair."} Changing the source never resets the timer.</small>
        <button disabled={busy} onClick={() => void action({ action: selection.globalHidden ? "show-all" : "hide-all" })}>{selection.globalHidden ? "Show all overlays" : "Hide all overlays"}</button>
      </div>
      {selection.globalHidden && <p className="host-panel-note">Show can't override Hide all. Use Show all overlays.</p>}
      {!published && <p className="host-panel-note">Show only clears hiding; publishing is separate.</p>}
      {error && <p role="alert" className="host-control-error">{error}</p>}
    </div>
  </div>;
}

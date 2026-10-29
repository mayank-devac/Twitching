import React, { useEffect, useRef } from "react";

export interface ModeHandoverState {
  target: "existing" | "new";
  choice?: "wait" | "cancel";
}

// Native modal focus keeps keyboard users inside the decision until it is resolved.
export function ModeHandover({
  state,
  choose,
  stay,
}: {
  state: ModeHandoverState;
  choose(choice: "wait" | "cancel"): void;
  stay(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  const target = state.target === "new" ? "a new session" : "existing sessions";
  const waiting = state.choice === "wait";
  return (
    <dialog
      ref={dialog}
      className="mode-handover"
      aria-labelledby="mode-handover-title"
      aria-describedby="mode-handover-description mode-handover-broadcast"
      onCancel={(event) => {
        event.preventDefault();
        if (!state.choice) stay();
      }}
    >
      <div className="mode-handover-eyebrow">
        Prompt arena →{" "}
        {state.target === "new" ? "New session" : "Existing session"}
      </div>
      <h2 id="mode-handover-title">
        {!state.choice
          ? "Switch out of the arena?"
          : waiting
            ? "Finishing the current run"
            : "Stopping arena work"}
      </h2>
      <p id="mode-handover-description">
        {!state.choice
          ? `An arena run is active. Choose how to finish before opening ${target}.`
          : waiting
            ? `No new rounds will start. We’ll open ${target} after this run and its cleanup finish.`
            : `We’re cancelling the run and checking that it has stopped before opening ${target}.`}
      </p>
      <p id="mode-handover-broadcast" className="mode-handover-note">
        If you’re live, OBS continues broadcasting during this switch. This
        dialog does not hide your overlay or end your broadcast.
      </p>
      {/* Explain the trade-off beside each action, before any cancellation request. */}
      {!state.choice ? (
        <div className="mode-handover-actions">
          <div className="mode-handover-option">
            <button
              className="primary-button"
              aria-describedby="mode-finish-warning"
              onClick={() => choose("wait")}
            >
              Finish and switch
            </button>
            <p id="mode-finish-warning">
              Let the current run finish. Switching waits for completion and
              cleanup, so it may take time. No new rounds will start.
            </p>
          </div>
          <div className="mode-handover-option">
            <button
              className="mode-handover-cancel"
              aria-describedby="mode-cancel-warning"
              onClick={() => choose("cancel")}
            >
              Cancel run and switch
            </button>
            <p id="mode-cancel-warning">
              Interrupt the current run. Its output may be incomplete or
              unavailable. Switching still waits for cleanup.
            </p>
          </div>
          <div className="mode-handover-option">
            <button
              className="mode-handover-stay"
              aria-describedby="mode-stay-description"
              autoFocus
              onClick={stay}
            >
              Stay in arena
            </button>
            <p id="mode-stay-description">
              Close this dialog and leave the arena running as it is.
            </p>
          </div>
        </div>
      ) : (
        <div className="mode-handover-progress" role="status">
          <span>
            {waiting ? "Waiting for completion…" : "Waiting for cleanup…"}
          </span>
          {waiting && (
            <div className="mode-handover-option">
              <p id="mode-cancel-waiting-warning">
                Cancelling now interrupts the run and may leave incomplete or
                unavailable output.
              </p>
              <button
                className="mode-handover-cancel"
                aria-describedby="mode-cancel-waiting-warning"
                onClick={() => choose("cancel")}
              >
                Cancel run and switch instead
              </button>
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}

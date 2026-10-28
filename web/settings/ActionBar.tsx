import React, { useState } from "react";
import type { ShowState } from "../../shared/types.js";
import { hostRequest } from "./api.js";

// Destructive broadcast actions and immediate cancellation require explicit confirmation.
export function ActionBar({
  state,
  token,
  busy,
  onHarness,
  onSave,
  dirty,
  onError,
}: {
  state: ShowState;
  token: string;
  busy: boolean;
  onHarness(): void;
  onSave(): void;
  dirty: boolean;
  onError(error: string): void;
}) {
  const [breakOpen, setBreakOpen] = useState(false);
  const [minutes, setMinutes] = useState(5);
  const [working, setWorking] = useState(false);
  const locked = busy || working || !token;
  async function action(path: string, value: unknown) {
    setWorking(true);
    onError("");
    try {
      await hostRequest(token, path, value);
      setBreakOpen(false);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setWorking(false);
    }
  }
  const remaining = state.breakUntil
    ? Math.max(0, Math.ceil((state.breakUntil - Date.now()) / 1000))
    : 0;
  return (
    <footer className="qs-actions">
      {breakOpen && (
        <div className="qs-break-form">
          <label>
            Break length (minutes)
            <input
              type="number"
              min={1}
              max={60}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            />
          </label>
          <button
            disabled={locked || minutes < 1 || minutes > 60}
            onClick={() =>
              void action("/api/quick-action", {
                action: "break",
                durationMs: Math.round(minutes * 60000),
                immediate: false,
              })
            }
          >
            After this round
          </button>
          <button
            disabled={locked || minutes < 1 || minutes > 60}
            onClick={() => {
              if (
                window.confirm(
                  "Stop active coding work and start this break now? The interrupted round will not resume.",
                )
              )
                void action("/api/quick-action", {
                  action: "break",
                  durationMs: Math.round(minutes * 60000),
                  immediate: true,
                });
            }}
          >
            Stop work and break now
          </button>
          <button onClick={() => setBreakOpen(false)}>Cancel</button>
          <p className="qs-hint">
            The timer lives on the server. When it ends, the show pauses; Resume
            rechecks quota. Quota breaks cannot be shortened.
          </p>
        </div>
      )}
      <div className="qs-row">
        <button
          className="qs-danger"
          disabled={locked || state.mode !== "live"}
          title={
            state.mode !== "live"
              ? "Rehearsal does not stop a public broadcast"
              : "Stop the actual OBS broadcast"
          }
          onClick={() => {
            if (
              window.confirm(
                "Stop the OBS broadcast and active coding work now?",
              )
            )
              void action("/api/quick-action", {
                action: "stop-stream",
                confirm: true,
              });
          }}
        >
          Stop stream
        </button>
        <button
          disabled={
            locked ||
            state.status === "stopped" ||
            state.status === "break" ||
            !!state.manualBreak
          }
          aria-expanded={breakOpen}
          onClick={() => setBreakOpen((o) => !o)}
        >
          Play break with timer
        </button>
        <button disabled={locked} onClick={onHarness}>
          Run a new harness
        </button>
        <span className="qs-spacer" />
        {state.status === "break" ? (
          <span role="timer">
            {state.breakKind === "manual" ? "Timed" : "Quota"} break ·{" "}
            {Math.floor(remaining / 60)}:
            {String(remaining % 60).padStart(2, "0")}
          </span>
        ) : state.manualBreak ? (
          <span>Break scheduled after results</span>
        ) : null}
        <button
          className="qs-primary"
          disabled={locked || !dirty}
          onClick={onSave}
        >
          Save settings
        </button>
      </div>
    </footer>
  );
}

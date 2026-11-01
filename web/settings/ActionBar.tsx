import React, { useState } from "react";
import type { ShowState } from "../../shared/types.js";
import { hostRequest } from "./api.js";
import { useNow } from "../use-now.js";

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
  const [useTimer, setUseTimer] = useState(true);
  const invalidTimer =
    useTimer && (!Number.isFinite(minutes) || minutes < 1 || minutes > 60);
  const [working, setWorking] = useState(false);
  // App no longer re-renders on a clock, so the break countdown ticks itself.
  const now = useNow(250);
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
    ? Math.max(0, Math.ceil((state.breakUntil - now) / 1000))
    : 0;
  return (
    <footer className="qs-actions">
      {breakOpen && state.experience === "arena" && (
        <div className="qs-break-form">
          {/* A null duration is explicit host-ended mode, never a quota override. */}
          <label className="qs-break-toggle">
            <input
              type="checkbox"
              checked={useTimer}
              onChange={(event) => setUseTimer(event.target.checked)}
            />
            Set a timer
          </label>
          {useTimer && (
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
          )}
          <button
            disabled={locked || invalidTimer}
            onClick={() =>
              void action("/api/quick-action", {
                action: "break",
                durationMs: useTimer ? Math.round(minutes * 60000) : null,
                immediate: false,
              })
            }
          >
            After this round
          </button>
          <button
            disabled={locked || invalidTimer}
            onClick={() => {
              if (
                window.confirm(
                  "Stop active coding work and start this break now? The interrupted round will not resume.",
                )
              )
                void action("/api/quick-action", {
                  action: "break",
                  durationMs: useTimer ? Math.round(minutes * 60000) : null,
                  immediate: true,
                });
            }}
          >
            Stop work and break now
          </button>
          <button onClick={() => setBreakOpen(false)}>Cancel</button>
          <p className="qs-hint">
            {useTimer
              ? "Timer expiry pauses the show. You can also Resume when ready."
              : "No timer. The break stays on until you press Start or Resume."}{" "}
            Resume checks quota; quota breaks cannot be shortened.
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
            state.experience !== "arena" ||
            state.status === "stopped" ||
            state.status === "break" ||
            !!state.manualBreak
          }
          aria-expanded={breakOpen}
          onClick={() => setBreakOpen((o) => !o)}
        >
          Play break
        </button>
        <button disabled={locked} onClick={onHarness}>
          Run a new harness
        </button>
        <span className="qs-spacer" />
        {state.status === "break" ? (
          <>
            <span role="timer">
              {state.breakKind === "quota"
                ? "Quota break"
                : state.breakUntil
                  ? "Timed break"
                  : "Break until Resume"}
              {state.breakUntil
                ? ` · ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`
                : ""}
            </span>
            {state.breakKind === "manual" && (
              <button
                disabled={locked}
                onClick={() => void (state.experience === "arena"
                  ? action("/api/action", { action: "resume" })
                  : action("/api/quick-action", { action: "end-break" }))}
              >
                {state.experience === "arena" ? "End break & resume" : "End break"}
              </button>
            )}
          </>
        ) : state.manualBreak ? (
          <span>Break scheduled after results</span>
        ) : null}
        {dirty && (
          <span className="qs-unsaved-note" role="status">
            Unsaved changes
          </span>
        )}
        <button
          className={`qs-primary${dirty ? " qs-unsaved" : ""}`}
          disabled={locked || !dirty}
          onClick={onSave}
        >
          Save settings
        </button>
      </div>
    </footer>
  );
}

import React, { useEffect, useId, useState } from "react";
import type { OverlayHostDocument } from "../shared/sessions.js";
import { hostRequest } from "./settings/api.js";
import "./break-control.css";

// Breaks cover public output only; the host must acknowledge that coding continues.
export function BreakControl({
  token,
  preferredId = "default",
  initial,
}: {
  token: string;
  preferredId?: string;
  initial?: OverlayHostDocument;
}) {
  const id = useId();
  const [document, setDocument] = useState(initial);
  const [selectedId, setSelectedId] = useState(preferredId);
  const [scope, setScope] = useState<"selected" | "all">("selected");
  const [timed, setTimed] = useState(true);
  const [minutes, setMinutes] = useState(5);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => setSelectedId(preferredId), [preferredId]);
  useEffect(() => {
    if (initial) setDocument(initial);
  }, [initial]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function refresh() {
    if (!token) return;
    try {
      const next = await hostRequest<OverlayHostDocument>(
        token,
        "/api/sessions/overlays",
      );
      // Keep the current object when nothing changed to skip a re-render.
      setDocument((old) =>
        old && JSON.stringify(old) === JSON.stringify(next) ? old : next,
      );
      if (!next.overlays.some((output) => output.id === selectedId))
        setSelectedId("default");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Overlay list unavailable");
    }
  }
  async function action(name: "break-start" | "break-end") {
    if (
      !document ||
      !document.overlays.some((output) => output.id === selectedId)
    )
      return;
    setBusy(true);
    setError("");
    try {
      await hostRequest(token, "/api/presentation", {
        action: name,
        ...(scope === "selected" ? { overlay: selectedId } : {}),
        ...(name === "break-start"
          ? { durationMs: timed ? Math.round(minutes * 60000) : null }
          : {}),
      });
      setAcknowledged(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Break change failed");
    } finally {
      setBusy(false);
    }
  }
  const selected = document?.overlays.find(
    (output) => output.id === selectedId,
  );
  const presentation = document?.presentation?.[selectedId];
  const until =
    scope === "all"
      ? presentation?.value.breakUntil
      : presentation?.own.breakUntil;
  const active =
    !!(scope === "all"
      ? presentation?.globalBreakActive
      : presentation?.own.breakActive) &&
    (!until || until > now);
  const invalidTimer =
    timed && (!Number.isInteger(minutes) || minutes < 1 || minutes > 60);
  return (
    <div className="break-control">
      <button
        type="button"
        className="host-tool-button"
        popoverTarget={id}
        disabled={!token}
        onClick={() => void refresh()}
      >
        Break
      </button>
      <div
        id={id}
        popover="auto"
        role="dialog"
        aria-label="Overlay break controls"
        className="host-popover break-popover"
      >
        <header className="host-popover-heading">
          <div>
            <h2>Break screen</h2>
            <p>Choose which viewers see the break.</p>
          </div>
          <button
            type="button"
            popoverTarget={id}
            popoverTargetAction="hide"
            aria-label="Close break controls"
          >
            ×
          </button>
        </header>
        <fieldset className="break-scope">
          <legend>Apply to</legend>
          <label>
            <input
              type="radio"
              name={id + "-scope"}
              checked={scope === "selected"}
              onChange={() => {
                setScope("selected");
                setAcknowledged(false);
              }}
            />
            Selected overlay
          </label>
          <label>
            <input
              type="radio"
              name={id + "-scope"}
              checked={scope === "all"}
              onChange={() => {
                setScope("all");
                setAcknowledged(false);
              }}
            />
            All overlays
          </label>
        </fieldset>
        {scope === "selected" && (
          <label className="break-field">
            Overlay
            <select
              value={selectedId}
              onChange={(event) => {
                setSelectedId(event.target.value);
                setAcknowledged(false);
              }}
            >
              {document?.overlays.map((output) => (
                <option key={output.id} value={output.id}>
                  {output.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="break-check">
          <input
            type="checkbox"
            checked={timed}
            onChange={(event) => setTimed(event.target.checked)}
          />
          Set a timer
        </label>
        {timed && (
          <label className="break-field">
            Length in minutes (1–60)
            <input
              type="number"
              min={1}
              max={60}
              step={1}
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
            />
          </label>
        )}
        <p className="break-warning" role="alert">
          <strong>{document?.running.length ? "A session is running. " : "A session may be running. "}Coding continues during this break.</strong>{" "}
          {scope === "all"
            ? "All public overlays show the break."
            : `Only ${selected?.name ?? "the selected overlay"} shows the break.`}{" "}
          {document?.running.length
            ? `${document.running.length} managed session(s) are listed as running.`
            : "External session activity may be unknown."}{" "}
          Check the private host view before leaving.
        </p>
        <label className="break-check">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          I understand coding keeps running.
        </label>
        {active && (
          <p role="status">
            {until
              ? `Break ends in ${Math.max(0, Math.ceil((until - now) / 1000))} seconds.`
              : "Break stays until you end it."}
          </p>
        )}
        <div className="break-actions">
          <button
            type="button"
            className="host-button-primary"
            disabled={
              !document || busy || !!active || invalidTimer || !acknowledged
            }
            onClick={() => void action("break-start")}
          >
            Start break screen
          </button>
          <button
            type="button"
            disabled={!active || busy}
            onClick={() => void action("break-end")}
          >
            End break screen
          </button>
        </div>
        {scope === "selected" && presentation?.globalBreakActive && (
          <p>
            All overlays also have a break active. End that separately to reveal
            this output.
          </p>
        )}
        {error && (
          <p role="alert" className="host-control-error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

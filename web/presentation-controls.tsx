import React, { useEffect, useId, useRef, useState } from "react";
import type { ShowState } from "../shared/types.js";
import { elapsed, stopwatch, privacyCommand, type Presentation, type PresentationSelection } from "../shared/presentation.js";
import { hostRequest } from "./settings/api.js";
import "./presentation.css";

// Use the server's clock at receipt, then monotonic browser time to avoid wall-clock drift.
function useElapsed(value?: Presentation) {
  const received = useRef({ value, at: performance.now() });
  if (received.current.value !== value) received.current = { value, at: performance.now() };
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick((n) => n + 1), 250); return () => clearInterval(timer); }, []);
  return value ? elapsed(value, value.serverNow + performance.now() - received.current.at) : 0;
}
export function GoalStrip({ value }: { value?: Presentation }) {
  const ms = useElapsed(value);
  if (!value || !value.showGoal || value.hidden || (!value.goal && !ms && value.runningSince === undefined)) return null;
  return <aside className="goal-strip" aria-label="Goal and stopwatch">
    <div className="goal-caption"><span>{value.goal ? "CURRENT GOAL" : "SESSION TIME"}</span>{value.goal && <strong>{value.goal}</strong>}</div>
    <time aria-label={value.runningSince === undefined ? "Stopwatch paused" : "Stopwatch running"}>{stopwatch(ms)}</time>
  </aside>;
}

// Hide and Show are separate idempotent commands; typing, IME and held keys are ignored.
export function usePrivacyShortcuts(token: string, error: (message: string) => void) {
  useEffect(() => {
    if (!token) return;
    const keydown = (event: KeyboardEvent) => {
      const target = event.target;
      const editing = target instanceof Element && !!target.closest("input, textarea, select, [role=textbox], [contenteditable]:not([contenteditable=false])");
      const action = privacyCommand(event, editing);
      if (!action) return;
      event.preventDefault();
      void hostRequest(token, "/api/presentation", { action }).catch((e) => error(e.message));
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [token, error]);
}

// The same compact controls appear on every host route, outside unsaved settings drafts.
export function PresentationControls({ state, value, token, overlayId, privacyHidden, globalHidden, source, onUpdated, shortcutsOnly = false, showShortcuts = true }: {
  state?: ShowState; value?: Presentation; token: string; overlayId?: string; privacyHidden?: boolean;
  globalHidden?: boolean;
  source?: "own" | "shared"; onUpdated?(selection: PresentationSelection): void;
  shortcutsOnly?: boolean; showShortcuts?: boolean;
}) {
  const p = value ?? state?.presentation;
  const hidden = privacyHidden ?? p?.hidden;
  const goalPanel = useId();
  const shortcutsPanel = useId();
  const [goal, setGoal] = useState(p?.goal ?? "");
  const [show, setShow] = useState(p?.showGoal ?? true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ms = useElapsed(p);
  useEffect(() => { setGoal(p?.goal ?? ""); setShow(p?.showGoal ?? true); }, [p?.goal, p?.showGoal, overlayId, source]);
  async function act(body: Record<string, unknown>) {
    setBusy(true); setError("");
    try {
      const result = await hostRequest<PresentationSelection>(token, "/api/presentation", { ...body, ...(overlayId ? { overlay: overlayId } : {}), ...(["goal", "start", "pause", "reset"].includes(String(body.action)) && source ? { source } : {}) });
      if (overlayId) onUpdated?.(result);
    }
    catch (e) { setError(e instanceof Error ? e.message : "Presentation action failed"); }
    finally { setBusy(false); }
  }
  return <section className="presentation-controls" aria-label="Public overlay controls">
    {!shortcutsOnly && <>
      <button className={`privacy-action${hidden ? " is-hidden" : ""}`} disabled={!token || (!!overlayId && !!globalHidden && !!hidden)}
        title={overlayId ? globalHidden && hidden ? "Show all overlays first" : "Privacy for this output only; publication stays unchanged" : "Privacy for every public output"}
        onClick={() => void act({ action: hidden ? "show" : "hide" })}>
        <span className="privacy-dot" aria-hidden="true" />{overlayId ? hidden ? "Show overlay" : "Hide overlay" : hidden ? "Show all overlays" : "Hide all overlays"}
      </button>
      <button type="button" popoverTarget={goalPanel} className="host-tool-button">
        {source === "shared" || !overlayId ? "Shared goal" : "Goal"} <time className="toolbar-stopwatch">{stopwatch(ms)}</time>
      </button>
    </>}
    {showShortcuts && <button type="button" popoverTarget={shortcutsPanel} className="host-tool-button" aria-label="Keyboard shortcuts and OBS privacy setup">
      Shortcuts
    </button>}
    <div id={goalPanel} popover="auto" role="dialog" aria-label="Goal and stopwatch" className="host-popover goal-popover">
      <header className="host-popover-heading"><div><h2>{source === "shared" || !overlayId ? "Shared goal & stopwatch" : "Overlay goal & stopwatch"}</h2><p>{source === "shared" || !overlayId ? "Edits affect every output using the shared pair." : "Only this output uses this goal and time."}</p></div><button type="button" popoverTarget={goalPanel} popoverTargetAction="hide" aria-label="Close goal controls">×</button></header>
      <form onSubmit={(e) => { e.preventDefault(); void act({ action: "goal", text: goal, show }); }}>
        <label className="goal-input-label">Current goal<input autoFocus value={goal} maxLength={160} onChange={(e) => setGoal(e.target.value)} placeholder="Fixing checkout errors" /></label>
        <div className="goal-save-row"><label className="host-check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />Show on overlay</label>
          <button type="button" disabled={busy || !token} onClick={() => void act({ action: "goal", text: "", show })}>Clear</button>
          <button className="host-button-primary" disabled={busy || !token}>Save goal</button>
        </div>
      </form>
      <div className="stopwatch-controls"><div><span>STOPWATCH</span><time aria-label="Stopwatch">{stopwatch(ms)}</time></div>
        <button type="button" disabled={busy || !token} onClick={() => void act({ action: p?.runningSince === undefined ? "start" : "pause" })}>{p?.runningSince === undefined ? ms ? "Resume" : "Start" : "Pause"}</button>
        <button type="button" disabled={busy || !token} onClick={() => { if (window.confirm(source === "shared" || !overlayId ? "Reset the shared stopwatch to zero for every output using it? Running or paused mode stays the same." : "Reset this overlay’s stopwatch to zero? Running or paused mode stays the same.")) void act({ action: "reset" }); }}>Reset</button>
      </div>
      <p className="host-panel-note">Editing the goal keeps the time. Server restarts restore it paused.</p>
      {error && <p role="alert" className="host-control-error">{error}</p>}
    </div>
    <div id={shortcutsPanel} popover="auto" role="dialog" aria-label="Privacy shortcuts" className="host-popover shortcuts-popover">
      <header className="host-popover-heading"><div><h2>Privacy shortcuts</h2><p>Quick controls, wherever you work.</p></div><button type="button" popoverTarget={shortcutsPanel} popoverTargetAction="hide" aria-label="Close shortcut help">×</button></header>
      <h3>While this page is focused</h3>
      <div className="shortcut-row"><span>Hide all overlays</span><kbd>Alt + Shift + H</kbd></div>
      <div className="shortcut-row"><span>Show all overlays</span><kbd>Alt + Shift + S</kbd></div>
      <p className="host-panel-note">Shortcuts ignore typing fields and held keys. Coding and the stopwatch continue while hidden.</p>
      <h3>While your code editor is focused</h3>
      <ol>
        <li>Create a neutral “Privacy” scene in OBS, with no private sources.</li>
        <li>In OBS Settings → Hotkeys, assign separate unused keys to switch to Privacy and your normal scene. For example Ctrl + Shift + F9 / F10.</li>
        <li>In Advanced → Hotkeys, choose “Never disable hotkeys”. Allow keyboard access if macOS asks.</li>
        <li>Test from your editor and inspect OBS Program output. Studio Mode may need an explicit transition.</li>
      </ol>
      <p className="host-panel-note">OBS hotkeys change the broadcast scene; they do not hide this app’s public feed. Use Hide overlay here for that. No OBS settings are changed automatically.</p>
      <p className="host-panel-note">A disconnected page cannot send Hide. Already broadcast content cannot be recalled.</p>
      <a href="https://github.com/obsproject/obs-studio/issues/6624" target="_blank" rel="noreferrer">OBS hotkey reference ↗</a>
    </div>
    {error && <span role="alert" className="host-control-error">{error}</span>}
  </section>;
}

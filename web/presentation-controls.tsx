import React, { useEffect, useRef, useState } from "react";
import type { ShowState } from "../shared/types.js";
import { elapsed, stopwatch, type Presentation } from "../shared/presentation.js";
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
  if (!value?.goal || !value.showGoal || value.hidden) return null;
  return <aside className="goal-strip" aria-label="Pinned goal"><strong>{value.goal}</strong><time aria-label="Goal stopwatch">{stopwatch(ms)}</time></aside>;
}

// Hide and Show are separate idempotent commands; typing, IME and held keys are ignored.
export function usePrivacyShortcuts(token: string, error: (message: string) => void) {
  useEffect(() => {
    if (!token) return;
    const keydown = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.repeat || event.isComposing || event.keyCode === 229 ||
        target instanceof HTMLElement && (target.isContentEditable || !!target.closest("input, textarea, select, [role=textbox]"))) return;
      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
      const action = event.code === "KeyH" ? "hide" : event.code === "KeyS" ? "show" : undefined;
      if (!action) return;
      event.preventDefault();
      void hostRequest(token, "/api/presentation", { action }).catch((e) => error(e.message));
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [token, error]);
}

// The same compact controls appear on every host route, outside unsaved settings drafts.
export function PresentationControls({ state, token }: { state: ShowState; token: string }) {
  const p = state.presentation;
  const [goal, setGoal] = useState(p?.goal ?? "");
  const [show, setShow] = useState(p?.showGoal ?? true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ms = useElapsed(p);
  useEffect(() => { setGoal(p?.goal ?? ""); setShow(p?.showGoal ?? true); }, [p?.goal, p?.showGoal]);
  async function act(body: unknown) {
    setBusy(true); setError("");
    try { await hostRequest(token, "/api/presentation", body); }
    catch (e) { setError(e instanceof Error ? e.message : "Presentation action failed"); }
    finally { setBusy(false); }
  }
  return <section className="presentation-controls" aria-label="Public overlay controls">
    <div className="presentation-row">
      <button className="privacy-action" disabled={!token} onClick={() => void act({ action: p?.hidden ? "show" : "hide" })}>{p?.hidden ? "Show overlay" : "Hide overlay"}</button>
      <span role="status">{p?.hidden ? "Public feed hidden · coding continues" : "Public feed visible"}</span>
      <small>Page focused: Alt + Shift + H hides · Alt + Shift + S shows</small>
    </div>
    <details><summary>Goal &amp; stopwatch</summary>
      <form className="presentation-row" onSubmit={(e) => { e.preventDefault(); void act({ action: "goal", text: goal, show }); }}>
        <label>Current goal <input value={goal} maxLength={160} onChange={(e) => setGoal(e.target.value)} placeholder="Fixing checkout errors" /></label>
        <label><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />Show goal on overlay</label>
        <button disabled={busy || !token}>Pin / Save</button>
        <button type="button" disabled={busy || !token} onClick={() => void act({ action: "goal", text: "", show })}>Clear</button>
        <time aria-label="Stopwatch">{stopwatch(ms)}</time>
        <button type="button" disabled={busy || !token} onClick={() => void act({ action: p?.runningSince === undefined ? "start" : "pause" })}>{p?.runningSince === undefined ? ms ? "Resume" : "Start" : "Pause"}</button>
        <button type="button" disabled={busy || !token} onClick={() => { if (window.confirm("Reset the stopwatch to zero? Its running or paused mode stays the same.")) void act({ action: "reset" }); }}>Reset</button>
      </form>
      <small>Changing the goal never resets time. After a server restart, time restores paused.</small>
    </details>
    <details><summary>Global privacy while coding in another app · OBS setup</summary>
      <ol>
        <li>In OBS, create a neutral scene called “Privacy” with “Back shortly” text and no private sources.</li>
        <li>Open OBS Settings → Hotkeys. Bind “Switch to scene” for Privacy (for example Ctrl + Shift + F9) and your normal scene (Ctrl + Shift + F10) to separate unused keys.</li>
        <li>In Settings → Advanced → Hotkeys, choose “Never disable hotkeys”. On macOS, allow OBS keyboard access if the OS requests it.</li>
        <li>Apply, focus your code editor, press the Privacy hotkey and inspect OBS Program output. In Studio Mode, transition the neutral scene into Program before relying on it.</li>
      </ol>
      <p>These native OBS hotkeys work without this page focused when your OS allows them. OBS scene privacy does not hide this app’s public feed. Use Hide overlay here as well when that feed must be private. No OBS scenes or hotkeys are changed automatically.</p>
      <p>Already broadcast content cannot be recalled. A disconnected page cannot send Hide; public pages show “Back shortly” once they detect disconnection. Use the OBS hotkey as the local fallback.</p>
      <a href="https://github.com/obsproject/obs-studio/issues/6624" target="_blank" rel="noreferrer">OBS hotkey focus reference ↗</a>
    </details>
    {error && <p role="alert">{error}</p>}
  </section>;
}

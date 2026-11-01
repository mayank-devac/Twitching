import React, { useEffect, useId, useRef, useState } from "react";
import {
  MAX_OVERLAYS,
  MAX_OVERLAY_SESSIONS,
  type Conversation,
  type OverlaySelection,
} from "../../shared/sessions.js";
import type { OverlayEditor } from "./use-overlay-editor.js";
import "./overlays.css";

// The streamer chooses a named output first, then ticks sessions in the existing browser.
export function OverlayManager({
  editor,
  conversations,
  children,
}: {
  editor: OverlayEditor;
  conversations: Conversation[];
  children?: React.ReactNode;
}) {
  const [name, setName] = useState("");
  const [copied, setCopied] = useState(false);
  const [comboOpen, setComboOpen] = useState(false);
  // Index of the option holding keyboard focus while the output list is open.
  const [activeOption, setActiveOption] = useState(0);
  const listId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);
  const copiedTimer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  // Roving focus: the active option is the only tabbable one and owns focus.
  useEffect(() => {
    if (comboOpen) optionRefs.current[activeOption]?.focus();
  }, [comboOpen, activeOption]);
  const { overlayDoc, draft } = editor;
  if (!overlayDoc || !draft)
    return (
      <section className="multi-overlays">
        <h2>Overlay output</h2>
        <p>{editor.error || "Loading overlays…"}</p>
        {children}
      </section>
    );
  const url =
    location.origin +
    (draft.id === "default" ? "/overlay" : "/overlay/" + draft.id);
  const titles = new Map(
    [...conversations, ...overlayDoc.running].map((conversation) => [
      conversation.id,
      conversation.title,
    ]),
  );
  const runningOverflow = Math.max(
    0,
    overlayDoc.running.length - MAX_OVERLAY_SESSIONS,
  );
  const applied = overlayDoc.overlays.find((overlay) => overlay.id === draft.id);
  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied; the input stays selectable.
    }
  }
  const outputs = overlayDoc.overlays;
  const openCombo = () => {
    setActiveOption(
      Math.max(0, outputs.findIndex((overlay) => overlay.id === draft.id)),
    );
    setComboOpen(true);
  };
  // Keyboard picks hand focus back to the toggle (APG listbox); mouse picks let the
  // option unmount as before so the combo's focus border does not linger.
  const chooseOutput = (id: string, restoreFocus: boolean) => {
    setComboOpen(false);
    if (restoreFocus) toggleRef.current?.focus();
    if (id !== draft.id) editor.select(id);
  };
  const onListKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const last = outputs.length - 1;
    const move = (index: number) => {
      event.preventDefault();
      setActiveOption(Math.min(last, Math.max(0, index)));
    };
    switch (event.key) {
      case "ArrowDown":
        return move(activeOption + 1);
      case "ArrowUp":
        return move(activeOption - 1);
      case "Home":
        return move(0);
      case "End":
        return move(last);
      case "Enter":
      case " ": {
        event.preventDefault();
        const overlay = outputs[activeOption];
        if (overlay) chooseOutput(overlay.id, true);
        return;
      }
      case "Escape":
        event.preventDefault();
        setComboOpen(false);
        toggleRef.current?.focus();
    }
  };
  const selectionLabel =
    draft.selection === "selected"
      ? "Selected"
      : draft.selection === "running-snapshot"
        ? "Running"
        : "Automatic";
  return (
    <section className="multi-overlays" aria-label="Overlay output">
      <header className="overlay-heading">
        <h2>Overlay output</h2>
        <span className="overlay-heading-meta">
          {overlayDoc.overlays.length}{" "}
          {overlayDoc.overlays.length === 1 ? "output" : "outputs"} ·{" "}
          {applied?.published ? "On stream" : "Not published"}
        </span>
        <details className="overlay-menu">
          <summary
            aria-label="Create, capture or delete outputs"
            title="Create, capture or delete outputs"
          >
            + Create
          </summary>
          <div className="overlay-menu-panel">
            <label className="overlay-menu-new">
              New output
              <input
                placeholder="Name"
                value={name}
                maxLength={80}
                disabled={editor.busy}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <button
              disabled={
                editor.busy ||
                editor.dirty ||
                overlayDoc.overlays.length >= MAX_OVERLAYS ||
                !name.trim()
              }
              onClick={async () => {
                if (await editor.create(name.trim())) setName("");
              }}
            >
              Create output
            </button>
            <button
              disabled={editor.busy || draft.id === "default" || editor.stale}
              onClick={() => {
                if (
                  window.confirm(
                    "Delete this output and its URL assignment? Coding sessions will keep running.",
                  )
                )
                  void editor.remove();
              }}
            >
              Delete this output
            </button>
            {draft.selection === "running-snapshot" && (
              <button disabled={editor.busy} onClick={editor.capture}>
                Capture running sessions again
              </button>
            )}
            {draft.selection === "running-snapshot" && draft.capturedAt && (
              <p>
                Last captured {new Date(draft.capturedAt).toLocaleString()}.
              </p>
            )}
            {overlayDoc.overlays.length >= MAX_OVERLAYS && (
              <p>All {MAX_OVERLAYS} output slots are in use.</p>
            )}
          </div>
        </details>
      </header>
      <div className="overlay-editor-fields">
        <div className="overlay-main-col">
          <div className="overlay-combo">
            <label htmlFor="overlay-output-name">Output name</label>
            <div
              className="overlay-combo-box"
              onBlur={(event) => {
                // Close only once focus leaves the whole combo (input, toggle and list).
                if (!event.currentTarget.contains(event.relatedTarget))
                  setComboOpen(false);
              }}
            >
              <input
                id="overlay-output-name"
                value={draft.name}
                maxLength={80}
                disabled={editor.busy}
                onChange={(event) =>
                  editor.setDraft({ ...draft, name: event.target.value })
                }
              />
              <button
                ref={toggleRef}
                type="button"
                className="overlay-combo-toggle"
                aria-label="Switch output"
                aria-haspopup="listbox"
                aria-expanded={comboOpen}
                aria-controls={comboOpen ? listId : undefined}
                disabled={editor.busy}
                onClick={() => (comboOpen ? setComboOpen(false) : openCombo())}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    openCombo();
                  } else if (event.key === "Escape" && comboOpen) {
                    event.preventDefault();
                    setComboOpen(false);
                  }
                }}
              >
                <svg
                  viewBox="0 0 12 8"
                  width="12"
                  height="8"
                  aria-hidden="true"
                >
                  <path
                    d="M1 1.5l5 5 5-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                </svg>
              </button>
              {comboOpen && (
                <ul
                  id={listId}
                  className="overlay-combo-list"
                  role="listbox"
                  aria-label="Editing output"
                  onKeyDown={onListKeyDown}
                >
                  {outputs.map((overlay, index) => (
                    <li
                      key={overlay.id}
                      ref={(element) => {
                        optionRefs.current[index] = element;
                      }}
                      role="option"
                      tabIndex={index === activeOption ? 0 : -1}
                      aria-selected={overlay.id === draft.id}
                      onClick={() => chooseOutput(overlay.id, false)}
                    >
                      {overlay.name}
                      {overlay.published ? " · On stream" : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <label>
            <span>
              Sessions to show{" "}
              <span
                className="overlay-mode-info"
                tabIndex={0}
                aria-label="Automatic session eligibility"
                title="Automatic mode follows managed sessions with verified running activity. External Codex history has unknown status and must be selected manually. Live outputs require rehearsal confirmation."
              >
                ⓘ
              </span>
            </span>
            <select
              value={draft.selection}
              disabled={editor.busy}
              onChange={(event) =>
                editor.selection(event.target.value as OverlaySelection)
              }
            >
              <option value="selected">Selected sessions</option>
              <option value="running-snapshot">Running now</option>
              <option value="follow-running">Follow running</option>
            </select>
          </label>
          <div className="overlay-selection-col">
            <h3>
              {selectionLabel} · {draft.sessionIds.length} /{" "}
              {MAX_OVERLAY_SESSIONS}
            </h3>
            <div className="overlay-chips">
              {draft.sessionIds.map((id) => (
                <div className="overlay-chip" key={id}>
                  <span>{titles.get(id) ?? id}</span>
                  <button
                    aria-label={"Remove " + (titles.get(id) ?? id)}
                    disabled={
                      editor.busy || draft.selection === "follow-running"
                    }
                    onClick={() => editor.toggle(id)}
                  >
                    ×
                  </button>
                </div>
              ))}
              {!draft.sessionIds.length && (
                <span className="overlay-chips-empty">
                  Tick sessions in the list on the left
                </span>
              )}
            </div>
            <small>
              {applied?.published
                ? `On stream · ${applied.sessionIds.length}`
                : "Not published"}
              {editor.dirty && " · Apply to update"}
            </small>
          </div>
        </div>
        <div className="overlay-side-col">
          {children}
          <div className="overlay-url-row">
            <input
              aria-label="OBS browser source URL"
              value={url}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" onClick={() => void copyUrl()}>
              {copied ? "Copied" : "Copy"}
            </button>
            <a href={url} target="_blank" rel="noreferrer">
              Open ↗
            </a>
          </div>
        </div>
      </div>
      {runningOverflow > 0 && draft.selection !== "selected" && (
        <p className="overlay-url-note">
          {`${runningOverflow} extra running sessions dropped (${MAX_OVERLAY_SESSIONS} max).`}
        </p>
      )}
      <p className="overlay-url-note">
        Add this URL as an OBS browser source. Each output has its own
        assignment.
      </p>
      <p className="overlay-url-note">
        {draft.selection === "selected"
          ? ""
          : draft.selection === "running-snapshot"
            ? "Apply captures running sessions; they stay selected after finishing."
            : overlayDoc.running.length
              ? "Running managed sessions join and leave automatically."
              : "Waiting for verified running activity."}
      </p>
      {editor.stale && (
        <p className="overlay-editor-error">
          Overlays changed in another tab. Reload latest before applying.
        </p>
      )}
      {!applied && (
        <p className="overlay-editor-error">
          This output was removed. Reload latest to pick another.
        </p>
      )}
      {editor.error && (
        <p className="overlay-editor-error" role="alert">
          {editor.error}
        </p>
      )}
      {editor.notice && (
        <p className="overlay-editor-feedback" role="status">
          {editor.notice}
        </p>
      )}
      <div className="overlay-actions">
        <button disabled={editor.busy} onClick={editor.reload}>
          Reload latest
        </button>
        <span className="overlay-spacer" />
        <button
          disabled={editor.busy || !draft.published}
          onClick={() => void editor.stop()}
        >
          Stop
        </button>
        <button
          disabled={editor.busy || editor.stale || !draft.name.trim()}
          onClick={() => void editor.apply()}
        >
          Apply
        </button>
        <button
          className="primary-button"
          disabled={
            editor.busy ||
            editor.stale ||
            !draft.name.trim() ||
            (draft.selection === "selected" && !draft.sessionIds.length)
          }
          onClick={() => void editor.apply(true)}
        >
          {draft.published ? "Update on stream" : "Publish overlay"}
        </button>
      </div>
    </section>
  );
}

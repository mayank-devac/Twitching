import React, { useState } from "react";
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
}: {
  editor: OverlayEditor;
  conversations: Conversation[];
}) {
  const [name, setName] = useState("");
  const { document, draft } = editor;
  if (!document || !draft)
    return (
      <section className="multi-overlays">
        <h2>Multiple overlays</h2>
        <p>{editor.error || "Loading overlays…"}</p>
      </section>
    );
  const url =
    location.origin +
    (draft.id === "default" ? "/overlay" : "/overlay/" + draft.id);
  const titles = new Map(
    [...conversations, ...document.running].map((conversation) => [
      conversation.id,
      conversation.title,
    ]),
  );
  const runningOverflow = Math.max(
    0,
    document.running.length - MAX_OVERLAY_SESSIONS,
  );
  const applied = document.overlays.find((overlay) => overlay.id === draft.id);
  return (
    <section className="multi-overlays" aria-label="Multiple overlays">
      <header className="overlay-heading">
        <h2>Multiple overlays</h2>
        <span>
          {document.overlays.length}{" "}
          {document.overlays.length === 1 ? "output" : "outputs"}
        </span>
      </header>
      <div className="overlay-editor-fields">
        <label>
          Editing output
          <select
            value={draft.id}
            disabled={editor.busy}
            onChange={(event) => editor.select(event.target.value)}
          >
            {document.overlays.map((overlay) => (
              <option key={overlay.id} value={overlay.id}>
                {overlay.name}
                {overlay.published ? " · On stream" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Output name
          <input
            value={draft.name}
            maxLength={80}
            disabled={editor.busy}
            onChange={(event) =>
              editor.setDraft({ ...draft, name: event.target.value })
            }
          />
        </label>
        <label>
          <span>
            Sessions to show{" "}
            <span
              className="overlay-mode-info"
              tabIndex={0}
              aria-label="Automatic session eligibility"
              title="Automatic mode includes sessions started by Twitching with verified running activity. Saved external Codex history has unknown status; select those sessions manually. Live outputs require rehearsal confirmation."
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
            <option value="running-snapshot">
              Running now — fixed selection
            </option>
            <option value="follow-running">Follow running — automatic</option>
          </select>
        </label>
        <label>
          New overlay
          <input
            placeholder="Overlay name"
            value={name}
            maxLength={80}
            disabled={editor.busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
      </div>
      <div className="overlay-editor-actions">
        <button
          disabled={
            editor.busy ||
            editor.dirty ||
            document.overlays.length >= MAX_OVERLAYS ||
            !name.trim()
          }
          onClick={async () => {
            if (await editor.create(name.trim())) setName("");
          }}
        >
          Create overlay
        </button>
        <button disabled={editor.busy} onClick={editor.reload}>
          Reload latest
        </button>
      </div>
      {document.overlays.length >= MAX_OVERLAYS && (
        <p>All {MAX_OVERLAYS} output slots are in use.</p>
      )}
      <div className="overlay-target-summary">
        <b>
          {draft.sessionIds.length} / {MAX_OVERLAY_SESSIONS}{" "}
          {editor.dirty ? "in draft" : "sessions"}
        </b>
        <span>
          {applied?.published
            ? "Live output: " +
              applied.sessionIds.length +
              (applied.sessionIds.length === 1 ? " session" : " sessions")
            : "Not published"}
        </span>
        {editor.dirty && <span>Apply to update this output</span>}
      </div>
      {draft.selection === "running-snapshot" && (
        <button disabled={editor.busy} onClick={editor.capture}>
          Capture running sessions again
        </button>
      )}
      {draft.selection === "running-snapshot" && draft.capturedAt && (
        <p>Last captured {new Date(draft.capturedAt).toLocaleString()}.</p>
      )}
      <p>
        {draft.selection === "selected"
          ? "Tick sessions in the saved-session list on the left. Apply updates this output during the stream."
          : draft.selection === "running-snapshot"
            ? "Apply captures sessions verified as running now. They stay selected after finishing."
            : document.running.length
              ? "Verified running sessions join and leave automatically."
              : "No verified running sessions yet. Automatic mode waits for activity."}
      </p>
      {runningOverflow > 0 && draft.selection !== "selected" && (
        <p>
          {runningOverflow} extra running session(s) cannot fit; the first eight
          are used.
        </p>
      )}
      <div className="overlay-selection-list">
        {draft.sessionIds.map((id) => (
          <div className="overlay-selection-item" key={id}>
            <span>{titles.get(id) ?? id}</span>
            <button
              aria-label={"Remove " + (titles.get(id) ?? id)}
              disabled={editor.busy || draft.selection === "follow-running"}
              onClick={() => editor.toggle(id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="overlay-url">
        <input
          aria-label="OBS browser source URL"
          value={url}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
        />
        <a href={url} target="_blank" rel="noreferrer">
          Open output ↗
        </a>
      </div>
      <p>
        Paste this URL into an OBS browser source. Each output uses its own
        assignment; visible sessions share their saved visibility choices.
      </p>
      {editor.stale && (
        <p className="overlay-editor-error">
          Another tab changed overlays. Reload latest before applying.
        </p>
      )}
      {!applied && (
        <p className="overlay-editor-error">
          This overlay was removed in another tab. Reload latest to choose
          another output.
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
      <div className="overlay-editor-actions">
        <button
          disabled={editor.busy || editor.stale || !draft.name.trim()}
          onClick={() => void editor.apply()}
        >
          {draft.selection === "follow-running"
            ? "Apply automatic selection"
            : "Apply to this overlay"}
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
        <button
          disabled={editor.busy || !draft.published}
          onClick={() => void editor.stop()}
        >
          Stop this overlay
        </button>
        <button
          disabled={editor.busy || draft.id === "default" || editor.stale}
          onClick={() => {
            if (
              window.confirm(
                "Delete this overlay and its URL assignment? Coding sessions will keep running.",
              )
            )
              void editor.remove();
          }}
        >
          Delete overlay
        </button>
      </div>
    </section>
  );
}

import React, { useState } from "react";
import type { ShowState } from "../../shared/types.js";
import { hostRequest } from "./api.js";

// The server checks the captured prompt version again when Save is pressed.
export function PreparedPrompt({
  state,
  token,
}: {
  state: ShowState;
  token: string;
}) {
  const [edit, setEdit] = useState<{ text: string; version: string }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const stale = edit && edit.version !== state.preparedVersion;
  async function save() {
    if (!edit) return;
    setBusy(true);
    setError("");
    try {
      await hostRequest(token, "/api/quick-action", {
        action: "edit-prompt",
        ...edit,
      });
      setEdit(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Prompt was not saved");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="qs-card qs-prepared" aria-labelledby="prepared-title">
      <div className="qs-row">
        <h2 id="prepared-title">Prepared prompt</h2>
        <button
          type="button"
          aria-label="Edit prepared prompt"
          disabled={!state.prepared || !state.preparedVersion || busy}
          onClick={() => {
            setEdit({
              text: state.prepared!.text,
              version: state.preparedVersion!,
            });
            setError("");
          }}
        >
          ✎ Edit
        </button>
      </div>
      {edit ? (
        <>
          <label>
            Next prompt
            <textarea
              value={edit.text}
              minLength={10}
              maxLength={600}
              onChange={(e) => setEdit({ ...edit, text: e.target.value })}
            />
          </label>
          <p className="qs-hint">
            Saved edits are attributed to “Host edited”. Active and past rounds
            cannot be edited.
          </p>
          {stale && (
            <p role="alert">
              This prompt changed or launched. Cancel and open the latest
              prompt.
            </p>
          )}
          <div className="qs-row">
            <button
              disabled={busy || !!stale || edit.text.trim().length < 10}
              onClick={() => void save()}
            >
              Save prompt
            </button>
            <button disabled={busy} onClick={() => setEdit(undefined)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <p>
          {state.prepared?.text ?? "The next selected prompt will appear here."}
        </p>
      )}
      {error && (
        <p className="qs-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

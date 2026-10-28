import React from "react";
import type { SessionConfig } from "../../shared/types.js";
import type { ModelChoice, SessionVisibility } from "../../shared/settings.js";
import { defaultVisibility } from "../../shared/settings.js";

const choices: [keyof SessionVisibility, string][] = [
  ["hidePreviousRuns", "Hide previous prompt runs (history is kept)"],
  ["tool", "Tool use"],
  ["command", "Commands"],
  ["read", "Read file names"],
  ["edit", "Edits"],
  ["message", "Messages"],
  ["summary", "Thinking summaries"],
  ["output", "Output notices"],
  ["complete", "Completion"],
  ["error", "Errors"],
  ["model", "Model name"],
  ["cliIcon", "CLI icon"],
  ["cliName", "CLI name"],
];
// Each card owns a stable session ID, even when both cards use the same CLI.
export function SessionCard({
  session,
  index,
  current,
  visibility,
  models,
  busy,
  change,
  toggle,
  remove,
  visibilitySaveLabel = "Saves immediately",
  displayOnly = false,
}: {
  session: SessionConfig;
  index: number;
  current?: SessionConfig;
  visibility?: SessionVisibility;
  models?: ModelChoice[];
  busy: boolean;
  change(value: SessionConfig): void;
  toggle(value: SessionVisibility): void;
  remove?: () => void;
  visibilitySaveLabel?: string;
  displayOnly?: boolean;
}) {
  const supported = models?.find((m) => m.id === session.model);
  const display = visibility ?? defaultVisibility;
  return (
    <article className="qs-session">
      <div className="qs-row">
        <h3>
          {session.cli === "codex" ? "Codex" : "Cursor"}{" "}
          {displayOnly ? "session" : index === 0 ? "Left" : "Right"}
        </h3>
        <small>{session.id}</small>
        {remove && (
          <button type="button" disabled={busy} onClick={remove}>
            Remove next round
          </button>
        )}
      </div>
      {/* Model controls and a vertical visibility list occupy separate readable columns. */}
      <div className="qs-session-layout">
        <div className="qs-session-models" hidden={displayOnly}>
          <p className="qs-current">
            <span>Current</span>{" "}
            {current
              ? `${current.model}${current.effort ? ` · ${current.effort}` : ""}`
              : "Not launched"}
          </p>
          <div className="qs-fields">
            <label>
              Next model
              <select
                value={session.model}
                disabled={busy || !models?.length}
                onChange={(e) =>
                  change({
                    ...session,
                    model: e.target.value,
                    effort: undefined,
                  })
                }
              >
                {!models?.some((m) => m.id === session.model) && (
                  <option value={session.model}>
                    {session.model}
                    {models
                      ? " (unavailable — choose another)"
                      : " (refresh to change)"}
                  </option>
                )}
                {models?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Next effort
              <select
                value={session.effort ?? ""}
                disabled={busy || !supported?.efforts.length}
                onChange={(e) =>
                  change({ ...session, effort: e.target.value || undefined })
                }
              >
                <option value="">CLI default</option>
                {session.effort &&
                  !supported?.efforts.includes(session.effort) && (
                    <option value={session.effort}>
                      {session.effort} (refresh to verify)
                    </option>
                  )}
                {supported?.efforts.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="qs-hint">
            {!models
              ? "Refresh models to change model or effort."
              : !supported?.efforts.length
                ? "No effort choices for this model."
                : "Supported choices from the installed CLI."}
          </p>
        </div>
        <details open className="qs-details qs-visibility-details">
          <summary>
            Overlay visibility <small>{visibilitySaveLabel}</small>
          </summary>
          <fieldset className="qs-visibility" disabled={busy}>
            <legend className="qs-sr-only">Overlay visibility</legend>
            {choices.map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={!!display[key]}
                  onChange={(e) =>
                    toggle({ ...display, [key]: e.target.checked })
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <p className="qs-hint">
            Only safe output filenames are shown. Private paths and contents
            stay hidden; history is kept.
          </p>
        </details>
      </div>
    </article>
  );
}

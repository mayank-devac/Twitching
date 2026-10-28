import React from "react";
import type { ShowState } from "../../shared/types.js";
import type { QuickPreferences } from "../../shared/settings.js";

// Operational controls keep their existing guards; optional explanations stay collapsed.
export function StreamSettings({
  state,
  value,
  disabled,
  change,
  action,
}: {
  state: ShowState;
  value: QuickPreferences["stream"];
  disabled: boolean;
  change(value: QuickPreferences["stream"]): void;
  action(name: string): void;
}) {
  return (
    <section className="qs-card">
      <div className="qs-section-heading">
        <div>
          <h2>Stream</h2>
          <p className="qs-hint">{state.reason}</p>
        </div>
        <span className="qs-badge">{state.status}</span>
      </div>
      <div className="qs-control-group">
        {["start", "pause", "resume", "skip"].map((name) => (
          <button
            key={name}
            disabled={
              disabled ||
              (name === "start" &&
                !["paused", "stopped"].includes(state.status) &&
                !(state.status === "break" && state.breakKind === "manual")) ||
              (name === "resume" &&
                state.status !== "paused" &&
                !(state.status === "break" && state.breakKind === "manual")) ||
              (name === "pause" &&
                ["paused", "stopped"].includes(state.status)) ||
              (name === "skip" &&
                !Object.values(state.round?.attempts ?? {}).some(
                  (a) => a.status === "running",
                ))
            }
            onClick={() => action(name)}
          >
            {name[0].toUpperCase() + name.slice(1)}
          </button>
        ))}
      </div>
      <div className="qs-setting-block">
        <div>
          <h3>Stream mode</h3>
          <p className="qs-hint">
            Change while paused, after active work finishes.
          </p>
        </div>
        <label>
          <span className="qs-sr-only">Mode</span>
          <select
            disabled={disabled || !["paused", "stopped"].includes(state.status)}
            value={value.mode}
            onChange={(e) =>
              change({ ...value, mode: e.target.value as "live" | "rehearsal" })
            }
          >
            <option value="rehearsal">Private rehearsal</option>
            <option value="live">Live</option>
          </select>
        </label>
      </div>
      <div className="qs-setting-block">
        <div>
          <h3>Chat sources</h3>
          <p className="qs-hint">Reconnect on the next Start or Resume.</p>
        </div>
        <div className="qs-platforms">
          {(["youtube", "twitch", "kick"] as const).map((key) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={value[key]}
                onChange={(e) => change({ ...value, [key]: e.target.checked })}
              />
              {key === "youtube"
                ? "YouTube"
                : key === "twitch"
                  ? "Twitch"
                  : "Kick"}
            </label>
          ))}
        </div>
      </div>
      <div className="qs-setting-block qs-stack">
        <div>
          <h3>Round timing</h3>
          <p className="qs-hint">Seconds · existing timers stay unchanged.</p>
        </div>
        <div className="qs-fields">
          {(
            [
              ["collectionMs", "Collection"],
              ["extensionMs", "Extra collection"],
              ["resultMs", "Results"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                min={1}
                max={3600}
                value={value[key] / 1000}
                onChange={(e) =>
                  change({
                    ...value,
                    [key]: Math.round(Number(e.target.value) * 1000),
                  })
                }
              />
            </label>
          ))}
        </div>
      </div>
      <details className="qs-details">
        <summary>When changes apply</summary>
        <p>
          Live mode keeps rehearsal, quota and OBS checks. Collection timings
          apply to the next collection; results timing applies when the next
          round finishes. Chat account identifiers and credentials use the
          existing startup flow. Prompt-list mode connects chat only after
          switching to chat in Control. These settings do not change remote
          titles or account metadata.
        </p>
      </details>
    </section>
  );
}

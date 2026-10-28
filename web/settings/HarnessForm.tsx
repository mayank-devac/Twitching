import React, { useEffect, useRef, useState } from "react";
import type { Agent, SessionConfig } from "../../shared/types.js";
import type { ModelChoice } from "../../shared/settings.js";

// A full arena requires an explicit slot choice; applying this form only queues configuration.
export function HarnessForm({
  sessions,
  models,
  busy,
  discover,
  apply,
  cancel,
}: {
  sessions: SessionConfig[];
  models: Partial<Record<Agent, ModelChoice[]>>;
  busy: boolean;
  discover(cli: Agent): void;
  apply(cli: Agent, model: string, replacement: string): void;
  cancel(): void;
}) {
  const [cli, setCli] = useState<Agent>("codex");
  const [model, setModel] = useState("");
  const [replacement, setReplacement] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    heading.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);
  return (
    <section className="qs-card qs-harness">
      <h2 ref={heading} tabIndex={-1}>
        New harness
      </h2>
      <p className="qs-hint">Configure a CLI session for the next round.</p>
      <div className="qs-fields">
        <label>
          CLI
          <select
            value={cli}
            onChange={(e) => {
              setCli(e.target.value as Agent);
              setModel("");
            }}
          >
            <option value="codex">Codex</option>
            <option value="cursor">Cursor</option>
          </select>
        </label>
        <label>
          Slot
          <select
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          >
            <option disabled={sessions.length >= 2} value="">
              {sessions.length >= 2
                ? "Choose a slot to replace"
                : "Add second session"}
            </option>
            {sessions.map((s, i) => (
              <option key={s.id} value={s.id}>
                Replace {i === 0 ? "Left" : "Right"} next round ({s.cli})
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="qs-fields">
        <label>
          Model
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">Choose a model</option>
            {models[cli]?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </label>
        <button
          className="qs-field-action"
          disabled={busy}
          onClick={() => discover(cli)}
        >
          Load models
        </button>
      </div>
      <div className="qs-row">
        <button
          disabled={busy || !model || (sessions.length >= 2 && !replacement)}
          onClick={() => apply(cli, model, replacement)}
        >
          Use next round
        </button>
        <button onClick={cancel}>Cancel</button>
      </div>
    </section>
  );
}

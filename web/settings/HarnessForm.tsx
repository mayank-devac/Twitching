import React, { useEffect, useRef, useState } from "react";
import { CLIS, CLI_LABELS, type Agent, type RunnerMode, type SessionConfig } from "../../shared/types.js";
import type { ModelChoice } from "../../shared/settings.js";

// A full arena requires an explicit slot choice; applying this form only queues configuration.
export function HarnessForm({
  sessions,
  busy,
  discover,
  apply,
  cancel,
  scroll = true,
}: {
  sessions: SessionConfig[];
  busy: boolean;
  discover(cli: Agent, runner?: RunnerMode): Promise<ModelChoice[] | undefined>;
  apply(cli: Agent, model: string, replacement: string, runner?: RunnerMode, nativeConsent?: string): void;
  cancel(): void;
  // Settings scrolls the form into view; an inline panel opens where it is.
  scroll?: boolean;
}) {
  const [cli, setCli] = useState<Agent>("codex");
  const [model, setModel] = useState("");
  const [replacement, setReplacement] = useState("");
  // Empty: the runner the app was launched with.
  const [runner, setRunner] = useState<RunnerMode | "">("");
  const [consent, setConsent] = useState("");
  // Models are offered only for the CLI and runner they were loaded from.
  const [loaded, setLoaded] = useState<{ cli: Agent; runner: RunnerMode | ""; models: ModelChoice[] }>();
  const models = loaded?.cli === cli && loaded.runner === runner ? loaded.models : [];
  const native = runner === "native";
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: !scroll });
    if (scroll) heading.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);
  return (
    <section className="qs-card qs-harness">
      <h2 ref={heading} tabIndex={-1} title="Configure a CLI session for the next round.">
        New harness
      </h2>
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
            {CLIS.map((option) => (
              <option key={option} value={option}>
                {CLI_LABELS[option]}
              </option>
            ))}
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
        <label>
          Runner
          <select
            value={runner}
            onChange={(e) => {
              setRunner(e.target.value as RunnerMode | "");
              setModel("");
              setConsent("");
            }}
          >
            <option value="">Launch default</option>
            <option value="docker">Docker (isolated)</option>
            <option value="native">Native (this computer)</option>
          </select>
        </label>
        {native && (
          <label>
            Type NATIVE to confirm
            <input
              value={consent}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setConsent(e.target.value)}
            />
          </label>
        )}
        <label>
          Model
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">{models.length ? "Choose a model" : "Load models first"}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </label>
        <button
          className="qs-field-action"
          disabled={busy}
          onClick={async () => {
            const at = { cli, runner };
            const found = await discover(cli, runner || undefined);
            if (found) setLoaded({ ...at, models: found });
          }}
        >
          Load models
        </button>
      </div>
      {native && (
        <p className="qs-hint">
          Native runs use this computer's installed CLI and login with no Docker
          boundary: the agent can reach your files and network. Live chat rounds
          stay on Docker unless the show was started with --allow-native-chat.
        </p>
      )}
      <div className="qs-row">
        <button
          disabled={
            busy ||
            !model ||
            (sessions.length >= 2 && !replacement) ||
            (native && consent !== "NATIVE")
          }
          onClick={() =>
            apply(cli, model, replacement, runner || undefined, native ? consent : undefined)
          }
        >
          Use next round
        </button>
        <button onClick={cancel}>Cancel</button>
      </div>
    </section>
  );
}

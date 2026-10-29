import React from "react";
import type { Agent } from "../../shared/types.js";

// Runner choices affect only future managed runs; external sessions are always read-only.
export function LaunchChoices({
  newSession,
  busy,
  cli,
  runner,
  consent,
  changeCli,
  changeRunner,
  changeConsent,
  discover,
}: {
  newSession: boolean;
  busy: boolean;
  cli: Agent;
  runner: "docker" | "native";
  consent: string;
  changeCli(cli: Agent): void;
  changeRunner(runner: "docker" | "native"): void;
  changeConsent(value: string): void;
  discover(): void;
}) {
  return (
    <fieldset disabled={busy} className="welcome-card">
      <legend>Launch choices</legend>
      {newSession && (
        <>
          <label>
            CLI
            <select
              value={cli}
              onChange={(e) => changeCli(e.target.value as Agent)}
            >
              <option value="codex">Codex</option>
              <option value="cursor">Cursor</option>
            </select>
          </label>
          <label>
            Runner
            <select
              value={runner}
              onChange={(e) =>
                changeRunner(e.target.value as "docker" | "native")
              }
            >
              <option value="docker">Docker — isolated</option>
              <option value="native">
                Native — runs directly on this computer
              </option>
            </select>
          </label>
          {runner === "native" && (
            <label>
              Native agents run without Docker isolation. The NATIVE opt-in is
              filled.
              <input
                value={consent}
                onChange={(e) => changeConsent(e.target.value)}
                autoComplete="off"
              />
            </label>
          )}
          <button onClick={discover}>
            Load installed models / check login
          </button>
          <p className="qs-hint">
            Each prompt starts a fresh CLI process in this session’s workspace,
            with up to 24,000 characters of recent conversation. Files remain;
            older messages stay in history. No model starts until you send a
            prompt.
          </p>
        </>
      )}
    </fieldset>
  );
}

import React from "react";
import type { Agent } from "../../shared/types.js";

// Runner choices affect only future managed runs; external sessions are always read-only.
export function LaunchChoices({
  newSession,
  busy,
  cli,
  runner,
  nativeAccepted,
  changeCli,
  changeRunner,
  changeNativeAccepted,
  discover,
}: {
  newSession: boolean;
  busy: boolean;
  cli: Agent;
  runner: "docker" | "native";
  nativeAccepted: boolean;
  changeCli(cli: Agent): void;
  changeRunner(runner: "docker" | "native"): void;
  changeNativeAccepted(accepted: boolean): void;
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
            <NativeConsent
              accepted={nativeAccepted}
              change={changeNativeAccepted}
            />
          )}
          <button onClick={discover}>Load installed models</button>
          <p className="qs-hint">
            Each prompt starts a fresh CLI process in this workspace. No model
            starts until you send a prompt.
          </p>
        </>
      )}
    </fieldset>
  );
}

// Native runs skip Docker isolation, so they need an explicit Yes each time.
// "No" is selected until the host chooses otherwise.
export function NativeConsent({
  accepted,
  change,
}: {
  accepted: boolean;
  change(accepted: boolean): void;
}) {
  return (
    <div
      className="native-consent"
      role="group"
      aria-label="Allow native execution"
    >
      <span>Native has no Docker isolation. Allow it on this computer?</span>
      <button type="button" aria-pressed={accepted} onClick={() => change(true)}>
        Yes
      </button>
      <button type="button" aria-pressed={!accepted} onClick={() => change(false)}>
        No
      </button>
    </div>
  );
}

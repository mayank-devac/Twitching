// The New harness form inline on the arena control page. Unlike Quick Settings
// there is no draft: applying saves at once, against the latest settings revision.
import React from "react";
import type { Agent, RunnerMode } from "../../shared/types.js";
import type { ModelChoice, SettingsDocument } from "../../shared/settings.js";
import { HarnessForm } from "../settings/HarnessForm.js";
import { placeHarness } from "../settings/harness.js";
import { hostRequest } from "../settings/api.js";
import { useHostAction, useHostQuery } from "../use-host-action.js";

export function ArenaHarness({ token, onClose }: { token: string; onClose(): void }) {
  const [doc, setDoc] = React.useState<SettingsDocument>();
  const { busy, error, notice, setError, setNotice, run } = useHostAction();
  useHostQuery(
    token,
    () => hostRequest<SettingsDocument>(token, "/api/settings"),
    setDoc,
    (e) => setError(e instanceof Error ? e.message : "Settings unavailable"),
  );
  const discover = (cli: Agent, runner?: RunnerMode) =>
    run(
      async () =>
        (await hostRequest<{ models: ModelChoice[] }>(token, `/api/models/${cli}${runner ? `?runner=${runner}` : ""}`))
          .models,
      "Model discovery failed",
    );
  const apply = (cli: Agent, model: string, replacement: string, runner?: RunnerMode, nativeConsent?: string) =>
    run(async () => {
      // Re-read so a save from another tab is never overwritten.
      const latest = await hostRequest<SettingsDocument>(token, "/api/settings");
      const sessions = placeHarness(latest.value.sessions, cli, model, replacement, runner);
      if (typeof sessions === "string") throw new Error(sessions);
      const saved = await hostRequest<SettingsDocument>(
        token,
        "/api/settings",
        { revision: latest.revision, value: { ...latest.value, sessions }, ...(nativeConsent ? { nativeConsent } : {}) },
        "PUT",
      );
      setDoc(saved);
      setNotice("Harness saved. It runs from the next round; the current sessions continue.");
    }, "Harness was not saved");
  return (
    <div className="arena-harness">
      {doc ? (
        // Remount after a save so the form starts fresh against the new slots.
        <HarnessForm
          key={doc.revision}
          sessions={doc.value.sessions}
          busy={busy}
          discover={discover}
          apply={(...args) => void apply(...args)}
          cancel={onClose}
          scroll={false}
        />
      ) : (
        !error && <p>Loading settings…</p>
      )}
      <div aria-live="polite">
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

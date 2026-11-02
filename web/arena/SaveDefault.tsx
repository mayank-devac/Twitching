// "Save as default" for the arena setup in use (CLI, model, effort, runner per session).
// While it is unsaved, closing the tab asks first so a flag-chosen matchup is not lost by accident.
import React from "react";
import type { SessionConfig } from "../../shared/types.js";
import { hostRequest } from "../settings/api.js";
import { useHostAction } from "../use-host-action.js";

interface DefaultStatus {
  unsaved: boolean;
  sessions: SessionConfig[];
}

export function SaveDefault({ token }: { token: string }) {
  const { busy, error, notice, setNotice, run } = useHostAction();
  const [status, setStatus] = React.useState<DefaultStatus>();

  const refresh = React.useCallback(async () => {
    if (!token) return;
    try {
      setStatus(await hostRequest<DefaultStatus>(token, "/api/settings/default"));
    } catch {
      /* The next poll retries. */
    }
  }, [token]);
  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  // The browser shows its own wording; it cannot be customised or offer a Save choice here.
  React.useEffect(() => {
    if (!status?.unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [status?.unsaved]);

  const save = () =>
    run(async () => {
      await hostRequest(token, "/api/settings/save-default", {}, "POST", {
        error: "The arena setup was not saved",
      });
      setNotice("Saved. This setup is now the default arena.");
      await refresh();
    }, "The arena setup was not saved");

  return (
    <div className="save-default">
      <div className="buttons">
        <button type="button" disabled={busy || !token || !status?.unsaved} onClick={save}>
          Save as default
        </button>
        {status && (
          <span role="status">
            {status.unsaved
              ? "Unsaved arena setup"
              : status.sessions.map((s) => `${s.cli} ${s.model}${s.effort ? ` · ${s.effort}` : ""}`).join("  vs  ")}
          </span>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

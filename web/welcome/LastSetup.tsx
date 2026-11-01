import React, { useId, useRef, useState } from "react";
import type {
  LastSetup as Setup,
  SettingsDocument,
} from "../../shared/settings.js";
import type { SessionView } from "../../shared/sessions.js";
import { hostRequest } from "../settings/api.js";
import { useHostAction, useHostQuery } from "../use-host-action.js";

// Review is separate from Apply, so a saved choice never silently replaces a draft.
export function LastSetup({
  token,
  revision,
  applied,
}: {
  token: string;
  revision?: number;
  applied(value: {
    setup: Setup;
    document: SettingsDocument;
    selected?: SessionView;
  }): void;
}) {
  const [setup, setSetup] = useState<Setup>();
  const panelId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const { busy, error, setError, run } = useHostAction();
  useHostQuery(
    token,
    () => hostRequest<{ setup?: Setup }>(token, "/api/last-setup"),
    (data) => {
      setSetup(data.setup);
      panel.current?.hidePopover();
    },
    (e) => setError((e as Error).message),
    [revision],
  );
  return (
    <section className="last-setup">
      <button
        type="button"
        className="host-tool-button"
        disabled={!setup || busy}
        popoverTarget={panelId}
        title={
          setup
            ? "Review your last applied choices"
            : "No applied setup saved yet"
        }
      >
        Use last setup
      </button>
      <div
        id={panelId}
        ref={panel}
        popover="auto"
        role="dialog"
        aria-label="Review last setup"
        className="host-popover setup-popover"
      >
        <header className="host-popover-heading">
          <div>
            <h2>Use last setup</h2>
            <p>Review saved choices.</p>
          </div>
          <button
            type="button"
            popoverTarget={panelId}
            popoverTargetAction="hide"
            aria-label="Close saved setup"
          >
            ×
          </button>
        </header>
        {setup && (
          <>
            <p>
              Saved {new Date(setup.savedAt).toLocaleString()} · {setup.path} ·{" "}
              {setup.runner} · {setup.stream.mode}
            </p>
            <p>
              {setup.sessionId
                ? `${setup.session?.title ?? setup.sessionId} · ${setup.session?.cli ?? ""} · ${setup.session?.model ?? "provider model"}${setup.session?.effort ? ` · ${setup.session.effort}` : ""}`
                : setup.sessions
                    .map(
                      (s) =>
                        `${s.cli} · ${s.model}${s.effort ? ` · ${s.effort}` : ""}`,
                    )
                    .join(" / ")}
            </p>
            {Object.entries(setup.visibility).map(([id, value]) => (
              <p key={id}>
                {id}:{" "}
                {Object.entries(value)
                  .filter(
                    ([key, enabled]) => enabled && key !== "hidePreviousRuns",
                  )
                  .map(([key]) => key)
                  .join(", ") || "nothing shown"}
                ; previous runs {value.hidePreviousRuns ? "hidden" : "shown"}
              </p>
            ))}
            <p>
              Apply replaces saved model, mode and visibility. Native needs
              fresh consent.
            </p>
            <button
              type="button"
              className="host-button-primary"
              disabled={busy || revision === undefined}
              onClick={() =>
                void run(async () => {
                  const result = await hostRequest<{
                    setup: Setup;
                    document: SettingsDocument;
                    selected?: SessionView;
                  }>(token, "/api/last-setup/apply", {
                    revision,
                    savedAt: setup.savedAt,
                  });
                  applied(result);
                  panel.current?.hidePopover();
                }, "Saved setup unavailable")
              }
            >
              Apply
            </button>
          </>
        )}
        {error && (
          <p role="alert" className="host-control-error">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

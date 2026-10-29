import React, { useEffect, useState } from "react";
import type { LastSetup as Setup, SettingsDocument } from "../../shared/settings.js";
import type { SessionView } from "../../shared/sessions.js";
import { hostRequest } from "../settings/api.js";

// Review is separate from Apply, so a saved choice never silently replaces a draft.
export function LastSetup({ token, revision, applied }: { token: string; revision?: number; applied(value: { setup: Setup; document: SettingsDocument; selected?: SessionView }): void }) {
  const [setup, setSetup] = useState<Setup>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let closed = false;
    if (token) void hostRequest<{ setup?: Setup }>(token, "/api/last-setup").then((data) => { if (!closed) setSetup(data.setup); }).catch((e) => { if (!closed) setError(e.message); });
    return () => { closed = true; };
  }, [token, revision]);
  return <section className="last-setup">
    <button type="button" disabled={!setup || busy} aria-expanded={open} onClick={() => setOpen((value) => !value)}>Use last setup</button>
    {!setup && <small>No applied setup saved yet.</small>}
    {open && setup && <>
      <p>Saved {new Date(setup.savedAt).toLocaleString()} · {setup.path} · {setup.runner} · {setup.stream.mode}</p>
      <p>{setup.sessionId ? `Session: ${setup.session?.title ?? setup.sessionId} · ${setup.session?.cli ?? ""} · ${setup.session?.model ?? "provider model"}${setup.session?.effort ? ` · ${setup.session.effort}` : ""}` : setup.sessions.map((s) => `${s.cli} · ${s.model}${s.effort ? ` · ${s.effort}` : ""}`).join(" / ")}</p>
      {Object.entries(setup.visibility).map(([id, value]) => <p key={id}>{id}: {Object.entries(value).filter(([key, enabled]) => enabled && key !== "hidePreviousRuns").map(([key]) => key).join(", ") || "nothing shown"}; previous runs {value.hidePreviousRuns ? "hidden" : "shown"}</p>)}
      <p>Apply replaces saved model, mode and visibility choices. Native execution needs fresh consent. Publication, coding and OBS remain manual.</p>
      <button type="button" disabled={busy || revision === undefined} onClick={async () => {
        setBusy(true); setError("");
        try { const result = await hostRequest<{ setup: Setup; document: SettingsDocument; selected?: SessionView }>(token, "/api/last-setup/apply", { revision, savedAt: setup.savedAt }); applied(result); setOpen(false); }
        catch (e) { setError(e instanceof Error ? e.message : "Saved setup unavailable"); }
        finally { setBusy(false); }
      }}>Apply reviewed setup</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

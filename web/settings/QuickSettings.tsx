import React, { useEffect, useRef, useState } from "react";
import type { Agent, SessionConfig, ShowState } from "../../shared/types.js";
import type {
  ModelChoice,
  QuickPreferences,
  SettingsDocument,
  SessionVisibility,
} from "../../shared/settings.js";
import { hostRequest } from "./api.js";
import { SessionCard } from "./SessionCard.js";
import { PreparedPrompt } from "./PreparedPrompt.js";
import { HistoryPanel } from "./HistoryPanel.js";
import { BreakMedia } from "./BreakMedia.js";
import { StreamSettings } from "./StreamSettings.js";
import { ActionBar } from "./ActionBar.js";
import "./settings.css";

// This dedicated host page keeps unsaved edits local while live snapshots update alongside it.
export function QuickSettings({
  state,
  token,
  connected,
}: {
  state: ShowState;
  token: string;
  connected: boolean;
}) {
  const [document, setDocument] = useState<SettingsDocument>();
  const [draft, setDraft] = useState<QuickPreferences>();
  const [models, setModels] = useState<Partial<Record<Agent, ModelChoice[]>>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [section, setSection] = useState<
    "sessions" | "stream" | "media" | "jev"
  >("sessions");
  const [harness, setHarness] = useState(false);
  const harnessHeading = useRef<HTMLHeadingElement>(null);
  // Footer actions reveal and focus the form even when the host has scrolled away.
  useEffect(() => {
    if (harness && section === "sessions") {
      harnessHeading.current?.focus();
      harnessHeading.current?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    }
  }, [harness, section]);
  const [harnessCli, setHarnessCli] = useState<Agent>("codex");
  const [harnessModel, setHarnessModel] = useState("");
  const [replacement, setReplacement] = useState("");
  async function reload() {
    setBusy(true);
    setError("");
    try {
      const doc = await hostRequest<SettingsDocument>(token, "/api/settings");
      setDocument(doc);
      setDraft(structuredClone(doc.value));
      setNotice("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Settings unavailable");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (token) void reload();
  }, [token]);
  async function discover(cli: Agent) {
    setBusy(true);
    setError("");
    try {
      const result = await hostRequest<{ models: ModelChoice[] }>(
        token,
        `/api/models/${cli}`,
      );
      setModels((old) => ({ ...old, [cli]: result.models }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Model discovery failed");
    } finally {
      setBusy(false);
    }
  }
  async function save(value?: QuickPreferences, visibilityOnly = false) {
    if (!document || !draft) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await hostRequest<SettingsDocument>(
        token,
        "/api/settings",
        { revision: document.revision, value: value ?? draft },
        "PUT",
      );
      setDocument(saved);
      setDraft((old) =>
        visibilityOnly && old
          ? { ...old, visibility: saved.value.visibility }
          : structuredClone(saved.value),
      );
      setNotice(
        visibilityOnly
          ? "Overlay visibility saved."
          : "Settings saved. Changes apply at the next safe boundary.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Settings were not saved");
    } finally {
      setBusy(false);
    }
  }
  // Immediate visibility writes merge with the last saved document, preserving other local edits.
  function toggle(id: string, value: SessionVisibility) {
    if (!document) return;
    void save(
      {
        ...document.value,
        visibility: { ...document.value.visibility, [id]: value },
      },
      true,
    );
  }
  function updateSession(value: SessionConfig) {
    setDraft((old) =>
      old
        ? {
            ...old,
            sessions: old.sessions.map((s) => (s.id === value.id ? value : s)),
          }
        : old,
    );
  }
  function prepareHarness() {
    if (!draft || !harnessModel) return;
    const target =
      replacement ||
      ["session-1", "session-2"].find(
        (id) => !draft.sessions.some((s) => s.id === id),
      );
    if (!target) {
      setError(
        "Both slots are occupied. Choose an explicit replacement for the next round.",
      );
      return;
    }
    const session: SessionConfig = {
      id: target,
      cli: harnessCli,
      model: harnessModel,
    };
    setDraft({
      ...draft,
      sessions: replacement
        ? draft.sessions.map((s) => (s.id === replacement ? session : s))
        : [...draft.sessions, session],
    });
    setHarness(false);
    setNotice(
      "Harness configured for the next round. Save settings to queue it; the current sessions continue.",
    );
  }
  if (!document || !draft)
    return (
      <main className="quick-settings">
        <h1>Quick Settings</h1>
        <p>{error || "Connecting to host settings…"}</p>
        {error && <button onClick={() => void reload()}>Retry</button>}
      </main>
    );
  const stale =
    (state.quickSettings?.revision ?? document.revision) > document.revision;
  const dirty = JSON.stringify(document.value) !== JSON.stringify(draft);
  async function controlAction(action: string) {
    setBusy(true);
    setError("");
    try {
      await hostRequest(token, "/api/action", { action });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Control failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="quick-settings">
      <header className="qs-header">
        <div>
          <a href="/control">← Control</a>
          <h1>Quick Settings</h1>
        </div>
        <div className="qs-status">
          <span className={`qs-dot ${connected ? "online" : ""}`} />
          {connected ? state.mode : "Reconnecting…"}
          <span className="qs-badge">{state.status}</span>
        </div>
      </header>
      <div className="qs-feedback" aria-live="polite">
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p className="qs-error" role="alert">
            {error}
          </p>
        )}
        {stale && (
          <p role="alert">
            Settings changed in another tab.{" "}
            <button
              disabled={busy}
              onClick={() => {
                if (
                  !dirty ||
                  window.confirm(
                    "Discard unsaved edits and load the latest settings?",
                  )
                )
                  void reload();
              }}
            >
              Reload latest
            </button>
          </p>
        )}
      </div>
      <nav className="qs-nav" aria-label="Settings sections">
        {(
          [
            ["sessions", "Sessions"],
            ["stream", "Stream"],
            ["media", "Break media"],
            ["jev", "Jev"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            disabled={busy}
            aria-current={section === id ? "page" : undefined}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="qs-layout">
        <fieldset className="qs-main" disabled={busy || stale}>
          <section className="qs-card" hidden={section !== "sessions"}>
            <div className="qs-section-heading">
              <div>
                <h2>CLI sessions</h2>
                <p className="qs-hint">
                  Independent sessions. Model changes apply next round.
                </p>
              </div>
              <span className="qs-badge">
                {draft.sessions.length} / 2 slots
              </span>
            </div>
            {(["codex", "cursor"] as const)
              .filter((cli) => draft.sessions.some((s) => s.cli === cli))
              .map((cli) => (
                <section key={cli} className="qs-cli">
                  <div className="qs-row">
                    <h3>{cli === "codex" ? "Codex" : "Cursor"}</h3>
                    <button disabled={busy} onClick={() => void discover(cli)}>
                      Refresh models
                    </button>
                  </div>
                  {draft.sessions.map(
                    (session, index) =>
                      session.cli === cli && (
                        <SessionCard
                          key={session.id}
                          session={session}
                          index={index}
                          current={state.sessions?.find(
                            (s) => s.id === session.id,
                          )}
                          visibility={draft.visibility[session.id]}
                          models={models[cli]}
                          busy={busy || stale}
                          change={updateSession}
                          toggle={(v) => toggle(session.id, v)}
                          remove={
                            draft.sessions.length > 1
                              ? () =>
                                  setDraft({
                                    ...draft,
                                    sessions: draft.sessions.filter(
                                      (s) => s.id !== session.id,
                                    ),
                                  })
                              : undefined
                          }
                        />
                      ),
                  )}
                </section>
              ))}
            <details className="qs-details">
              <summary>About model discovery</summary>
              <p>
                Refresh asks the installed CLI/account for supported models and
                reasoning efforts. It does not start a coding round. Current
                sessions keep their models until they finish.
              </p>
            </details>
          </section>
          {harness && section === "sessions" && (
            <section className="qs-card qs-harness">
              <h2 ref={harnessHeading} tabIndex={-1}>
                New harness
              </h2>
              <p className="qs-hint">
                Configure a CLI session for the next round.
              </p>
              <div className="qs-fields">
                <label>
                  CLI
                  <select
                    value={harnessCli}
                    onChange={(e) => {
                      setHarnessCli(e.target.value as Agent);
                      setHarnessModel("");
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
                    <option disabled={draft.sessions.length >= 2} value="">
                      {draft.sessions.length >= 2
                        ? "Choose a slot to replace"
                        : "Add second session"}
                    </option>
                    {draft.sessions.map((s, i) => (
                      <option key={s.id} value={s.id}>
                        Replace {i === 0 ? "Left" : "Right"} next round ({s.cli}
                        )
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="qs-fields">
                <label>
                  Model
                  <select
                    value={harnessModel}
                    onChange={(e) => setHarnessModel(e.target.value)}
                  >
                    <option value="">Choose a model</option>
                    {models[harnessCli]?.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="qs-field-action"
                  disabled={busy}
                  onClick={() => void discover(harnessCli)}
                >
                  Load models
                </button>
              </div>
              <div className="qs-row">
                <button
                  disabled={
                    busy ||
                    !harnessModel ||
                    (draft.sessions.length >= 2 && !replacement)
                  }
                  onClick={prepareHarness}
                >
                  Use next round
                </button>
                <button onClick={() => setHarness(false)}>Cancel</button>
              </div>
            </section>
          )}
          <div hidden={section !== "stream"}>
            <StreamSettings
              state={state}
              value={draft.stream}
              disabled={busy || !connected}
              change={(stream) => setDraft({ ...draft, stream })}
              action={(name) => void controlAction(name)}
            />
          </div>
          {section === "media" && (
            <div>
              <BreakMedia
                token={token}
                onBusy={setBusy}
                value={draft.media}
                disabled={busy || stale}
                change={(media) => setDraft({ ...draft, media })}
              />
            </div>
          )}
          <section className="qs-card" hidden={section !== "jev"}>
            <div className="qs-section-heading">
              <div>
                <h2>Jev</h2>
                <p className="qs-hint">Guide scoring and prompt selection.</p>
              </div>
              <span className="qs-badge">Next collection</span>
            </div>
            <label>
              Selection criteria
              <textarea
                minLength={10}
                maxLength={4000}
                value={draft.jevCriteria}
                onChange={(e) =>
                  setDraft({ ...draft, jevCriteria: e.target.value })
                }
              />
            </label>
            <label>
              Startup probe
              <textarea
                minLength={10}
                maxLength={700}
                value={draft.jevProbe}
                onChange={(e) =>
                  setDraft({ ...draft, jevProbe: e.target.value })
                }
              />
            </label>
            <details className="qs-details">
              <summary>Safety and timing</summary>
              <p>
                Criteria apply at the next collection. Safety and offline HTML
                rules remain required; cached scores from different criteria
                stay separate. The startup probe (jevProbe) is used on the next
                live Start/Resume. Saving does not call Jev.
              </p>
            </details>
          </section>
        </fieldset>
        <aside className="qs-side">
          <PreparedPrompt state={state} token={token} />
          <HistoryPanel token={token} />
        </aside>
      </div>
      <ActionBar
        state={state}
        token={token}
        busy={busy || stale || !connected}
        dirty={dirty}
        onSave={() => void save()}
        onHarness={() => {
          setSection("sessions");
          setHarness(true);
          setReplacement("");
          setHarnessModel("");
          setNotice("");
        }}
        onError={setError}
      />
    </main>
  );
}

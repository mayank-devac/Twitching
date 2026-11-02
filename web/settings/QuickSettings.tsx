import React, { useEffect, useMemo, useState } from "react";
import { CLIS, CLI_LABELS, type Agent, type RunnerMode, type SessionConfig, type ShowState } from "../../shared/types.js";
import type {
  ModelChoice,
  QuickPreferences,
  SettingsDocument,
  SessionVisibility,
} from "../../shared/settings.js";
import { useUnsavedWarning } from "./use-unsaved-warning.js";
import { hostRequest } from "./api.js";
import { useHostAction } from "../use-host-action.js";
import { SessionCard } from "./SessionCard.js";
import { PreparedPrompt } from "./PreparedPrompt.js";
import { HistoryPanel } from "./HistoryPanel.js";
import { BreakMedia } from "./BreakMedia.js";
import { HarnessForm } from "./HarnessForm.js";
import { placeHarness } from "./harness.js";
import { StreamSettings } from "./StreamSettings.js";
import { ActionBar } from "./ActionBar.js";
import "./settings.css";

// One-click Codex vs Codex setup. No runner: the launch default (Docker) applies.
const DEFAULT_SESSIONS: SessionConfig[] = [
  { id: "session-1", cli: "codex", model: "gpt-6-luna", effort: "medium" },
  { id: "session-2", cli: "codex", model: "gpt-5.6-luna", effort: "medium" },
];

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
  const [settingsDoc, setSettingsDoc] = useState<SettingsDocument>();
  const [draft, setDraft] = useState<QuickPreferences>();
  const [models, setModels] = useState<Partial<Record<Agent, ModelChoice[]>>>(
    {},
  );
  const { busy, error, notice, setBusy, setError, setNotice, run } = useHostAction();
  // Opened from the session controls, the arena's CLI sessions tab does not apply.
  const fromSession =
    new URLSearchParams(location.search).get("from") === "session";
  const [section, setSection] = useState<
    "sessions" | "stream" | "media" | "jev"
  >(fromSession ? "stream" : "sessions");
  const [harness, setHarness] = useState(false);
  // Consent typed in the harness form, sent with the next full save.
  const [nativeConsent, setNativeConsent] = useState<string>();
  const [promptDirty, setPromptDirty] = useState(false);
  // The leave warning covers both durable settings and the separate prepared-prompt editor.
  // Memoised: serialising both settings trees on every live-state render is wasteful.
  const dirty = useMemo(
    () =>
      !!(
        settingsDoc &&
        draft &&
        JSON.stringify(settingsDoc.value) !== JSON.stringify(draft)
      ),
    [settingsDoc, draft],
  );
  const confirmLeave = useUnsavedWarning(dirty || promptDirty);
  // The notice is cleared only once the reload succeeds.
  const reload = () =>
    run(async () => {
      const doc = await hostRequest<SettingsDocument>(token, "/api/settings");
      setSettingsDoc(doc);
      setDraft(structuredClone(doc.value));
      setNotice("");
    }, "Settings unavailable", { keepNotice: true });
  useEffect(() => {
    if (token) void reload();
  }, [token]);
  const discover = (cli: Agent, runner?: RunnerMode) =>
    run(async () => {
      const boundary =
        runner ??
        (state.sharedSession?.conversation.source === "managed" && state.sharedSession.conversation.cli === cli
          ? state.sharedSession.conversation.runner
          : undefined);
      const result = await hostRequest<{ models: ModelChoice[] }>(
        token,
        `/api/models/${cli}${boundary ? `?runner=${boundary}` : ""}`,
      );
      setModels((old) => ({ ...old, [cli]: result.models }));
      return result.models;
    }, "Model discovery failed", { keepNotice: true });
  async function save(value?: QuickPreferences, visibilityOnly = false) {
    if (!settingsDoc || !draft) return;
    await run(async () => {
      const saved = await hostRequest<SettingsDocument>(
        token,
        "/api/settings",
        { revision: settingsDoc.revision, value: value ?? draft, ...(!value && nativeConsent ? { nativeConsent } : {}) },
        "PUT",
      );
      if (!value) setNativeConsent(undefined);
      setSettingsDoc(saved);
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
    }, "Settings were not saved");
  }
  // Immediate visibility writes merge with the last saved document, preserving other local edits.
  function toggle(id: string, value: SessionVisibility) {
    if (!settingsDoc) return;
    void save(
      {
        ...settingsDoc.value,
        visibility: { ...settingsDoc.value.visibility, [id]: value },
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
  function prepareHarness(
    harnessCli: Agent,
    harnessModel: string,
    replacement: string,
    runner?: RunnerMode,
    consent?: string,
  ) {
    if (!draft || !harnessModel) return;
    const sessions = placeHarness(draft.sessions, harnessCli, harnessModel, replacement, runner);
    if (typeof sessions === "string") {
      setError(sessions);
      return;
    }
    if (consent) setNativeConsent(consent);
    setDraft({ ...draft, sessions });
    setHarness(false);
    setNotice(
      "Harness configured for the next round. Save settings to queue it; the current sessions continue.",
    );
  }
  if (!settingsDoc || !draft)
    return (
      <main className="quick-settings">
        <h1>Quick Settings</h1>
        <p>{error || "Connecting to host settings…"}</p>
        {error && <button onClick={() => void reload()}>Retry</button>}
      </main>
    );
  const stale =
    (state.quickSettings?.revision ?? settingsDoc.revision) > settingsDoc.revision;
  const controlAction = (action: string) =>
    run(() => hostRequest(token, "/api/action", { action }), "Control failed", {
      keepNotice: true,
    });
  return (
    <main className="quick-settings">
      <header className="qs-header">
        <div>
          <a
            href="/control"
            onClick={(event) => {
              if (
                event.button === 0 &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.shiftKey &&
                !event.altKey &&
                !confirmLeave()
              )
                event.preventDefault();
            }}
          >
            ← Control
          </a>
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
        ).filter(([id]) => !(fromSession && id === "sessions")).map(([id, label]) => (
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
            {state.sharedSession && <div className="qs-card">
              <h2>Published session display</h2>
              <p>These choices apply only to {state.sharedSession.conversation.title}. Previous prompts are hidden only in the view; history is kept.</p>
              <SessionCard
                displayOnly={state.sharedSession.conversation.source !== "managed"}
                session={{ id: state.sharedSession.conversation.id, cli: state.sharedSession.conversation.cli, model: state.sharedSession.conversation.model ?? "Model unknown", ...draft.managedModels?.[state.sharedSession.conversation.id] }}
                models={models[state.sharedSession.conversation.cli]}
                index={0}
                visibility={draft.visibility[state.sharedSession.conversation.id] ?? state.sharedSession.visibility}
                busy={busy || stale} change={(selection) => setDraft({ ...draft, managedModels: { ...draft.managedModels, [selection.id]: { model: selection.model, effort: selection.effort } } })}
                toggle={(v) => toggle(state.sharedSession!.conversation.id, v)}
              />
              {state.sharedSession.conversation.source === "managed" && <button disabled={busy} onClick={() => void discover(state.sharedSession!.conversation.cli)}>Refresh models for this session</button>}
            </div>}
            <div className="qs-section-heading">
              <div>
                <h2>CLI sessions</h2>
                <p className="qs-hint">
                  Independent sessions. Model changes apply next round.
                </p>
              </div>
              <div className="qs-row">
                <button
                  disabled={busy || stale}
                  title="session-1: codex · gpt-6-luna · medium, session-2: codex · gpt-5.6-luna · medium"
                  onClick={() => {
                    setDraft({ ...draft, sessions: structuredClone(DEFAULT_SESSIONS) });
                    setHarness(false);
                    setNotice(
                      "Sessions reset to Codex gpt-6-luna (medium) vs Codex gpt-5.6-luna (medium). Save settings to apply them next round.",
                    );
                  }}
                >
                  Reset to Codex vs Codex
                </button>
                <span className="qs-badge">
                  {draft.sessions.length} / 2 slots
                </span>
              </div>
            </div>
            {CLIS
              .filter((cli) => draft.sessions.some((s) => s.cli === cli))
              .map((cli) => (
                <section key={cli} className="qs-cli">
                  <div className="qs-row">
                    <h3>{CLI_LABELS[cli]}</h3>
                    <button disabled={busy} onClick={() => void discover(cli, draft.sessions.find((s) => s.cli === cli)?.runner)}>
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
            <HarnessForm
              sessions={draft.sessions}
              busy={busy}
              discover={discover}
              apply={prepareHarness}
              cancel={() => setHarness(false)}
            />
          )}
          <div hidden={section !== "stream"}>
            <StreamSettings
              state={state}
              value={draft.stream}
              disabled={busy || !connected}
              change={(stream) => setDraft({ ...draft, stream })}
              action={(name) => void controlAction(name)}
              directPreview={draft.directPreview}
              changeDirectPreview={(directPreview) => setDraft({ ...draft, directPreview })}
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
          <PreparedPrompt
            state={state}
            token={token}
            onDirtyChange={setPromptDirty}
          />
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
          setNotice("");
        }}
        onError={setError}
      />
    </main>
  );
}

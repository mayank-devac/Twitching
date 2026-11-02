import { LastSetup } from "./LastSetup.js";
import { ModeHandover } from "./ModeHandover.js";
import { useModeSwitch } from "./use-mode-switch.js";
import { RehearsalCheck } from "./RehearsalCheck.js";
import { BreakControl } from "../break-control.js";
import React, { useEffect, useRef, useState } from "react";
import type { Agent, RunnerMode, SessionConfig } from "../../shared/types.js";
import type {
  Conversation,
  ConnectorCapabilities,
  SessionView,
} from "../../shared/sessions.js";
import type { ModelChoice, SettingsDocument } from "../../shared/settings.js";
import type { SessionVisibility } from "../../shared/settings.js";
import { defaultVisibility } from "../../shared/settings.js";
import { SessionCard } from "../settings/SessionCard.js";
import { hostRequest } from "../settings/api.js";
import { useHostAction, useHostQuery } from "../use-host-action.js";
import { Timeline } from "./Timeline.js";
import {
  SessionBrowser,
  type SessionListing as Listing,
} from "./SessionBrowser.js";
import { LaunchChoices, NativeConsent } from "./LaunchChoices.js";
import { uniqueConversations } from "../../shared/sessions.js";
import { useOverlayEditor } from "../overlays/use-overlay-editor.js";
import { OverlayManager } from "../overlays/OverlayManager.js";
import { OverlayPresentation } from "../overlays/OverlayPresentation.js";
import { ChatMenu } from "../chats/ChatMenu.js";
import "../settings/settings.css";

interface Readiness {
  tools: { name: string; available: boolean; message: string }[];
  login: string;
  obs: string;
  connectors: Record<Agent, ConnectorCapabilities>;
}

const visibilityChoices: [keyof SessionVisibility, string][] = [
  ["tool", "Tool use"],
  ["edit", "Edits"],
  ["message", "Messages"],
  ["summary", "Thinking summaries"],
  ["output", "Output notices"],
  ["complete", "Completion"],
  ["error", "Errors"],
  ["model", "Model name"],
  ["effort", "Effort"],
  ["cliIcon", "Icon"],
  ["cliName", "Name"],
  ["command", "Commands"],
  ["web", "Web searches"],
  ["read", "Read file names"],
];

function OverlayVisibility({
  value,
  busy,
  change,
}: {
  value: SessionVisibility;
  busy: boolean;
  change(value: SessionVisibility): void;
}) {
  const shown = visibilityChoices.filter(([key]) => value[key]).length;
  // Rendered inside the Overlay output panel as an inner visibility row.
  return (
    <div className="overlay-visibility">
      <header>
        <h3>Visibility</h3>
        <span>
          {shown} of {visibilityChoices.length} shown
        </span>
      </header>
      <div className="visibility-row">
        <div className="visibility-chips">
          {visibilityChoices.map(([key, label]) => (
            <button
              type="button"
              key={key}
              className="visibility-chip"
              aria-pressed={!!value[key]}
              disabled={busy}
              onClick={() => change({ ...value, [key]: !value[key] })}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="hide-runs-choice">
          <input
            type="checkbox"
            checked={!!value.hidePreviousRuns}
            disabled={busy}
            onChange={(event) =>
              change({ ...value, hidePreviousRuns: event.target.checked })
            }
          />
          Hide previous runs <span>(history is kept)</span>
        </label>
      </div>
    </div>
  );
}

// The welcome dialog edits the same revisioned preferences as Quick Settings.
export function Welcome({
  token,
  publishedId,
  hostControls,
  breakControl = false,
  arenaActive = false,
}: {
  token: string;
  publishedId?: string;
  hostControls?: React.ReactNode;
  breakControl?: boolean;
  arenaActive?: boolean;
}) {
  const [settingsDoc, setSettingsDoc] = useState<SettingsDocument>();
  const [ready, setReady] = useState<Readiness>();
  const { busy, error, notice, setError, setNotice, run } = useHostAction();
  const { path, setPath, handover, setHandover, failedMode, setFailedMode, switchPath } =
    useModeSwitch({ token, arenaActive, setError, setNotice });
  const [cli, setCli] = useState<Agent>("codex");
  const [runner, setRunner] = useState<RunnerMode>("native");
  const [nativeAccepted, setNativeAccepted] = useState(false);
  const [models, setModels] = useState<ModelChoice[]>();
  const [choice, setChoice] = useState<SessionConfig>();
  const [source, setSource] = useState<"managed" | Agent>("codex");
  const [search, setSearch] = useState("");
  const [listing, setListing] = useState<Listing>({ conversations: [] });
  const [selected, setSelected] = useState<SessionView>();
  const [prompt, setPrompt] = useState("");
  const [listBusy, setListBusy] = useState(false);
  const [resultUrl, setResultUrl] = useState("");
  const overlayEditor = useOverlayEditor(token);
  const publishedKeys = (
    overlayEditor.overlayDoc?.publishedSessionIds ??
    (publishedId ? [publishedId] : [])
  ).join("|");
  const selection = useRef(0);
  const listingVersion = useRef(0);
  useEffect(() => {
    const ids = publishedKeys ? publishedKeys.split("|") : [];
    setListing((value) => ({ ...value, publishedId, publishedIds: ids }));
    setSelected(
      (value) =>
        value && { ...value, published: ids.includes(value.conversation.id) },
    );
  }, [publishedId, publishedKeys]);
  const request = <T,>(url: string, body?: unknown, method?: string) =>
    hostRequest<T>(token, url, body, method);
  const perform = <T,>(fn: () => Promise<T>) => run(fn, "Request failed");
  useHostQuery(
    token,
    () =>
      Promise.all([
        request<SettingsDocument>("/api/settings"),
        request<Readiness>("/api/sessions/readiness"),
      ]),
    ([doc, status]) => {
      setSettingsDoc(doc);
      setReady(status);
      // `at(0)` keeps an empty sessions list from being treated as defined.
      setChoice({
        ...doc.value.sessions.at(0),
        id: "session-1",
        cli: "codex",
        model: "",
        effort: undefined,
      });
    },
    (e) => setError(String((e as Error).message)),
  );
  // List loads run on every search keystroke, so they keep their own busy flag and
  // report errors without going through perform(), which wipes notices and
  // disables unrelated controls. Only the newest load may touch state.
  async function list(before?: string) {
    const version = ++listingVersion.current;
    setListBusy(true);
    try {
      const data = await request<Listing>(
        `/api/sessions/list?${new URLSearchParams({ source, search, ...(before ? { before } : {}) })}`,
      );
      if (version === listingVersion.current)
        setListing((old) => ({
          ...data,
          conversations: uniqueConversations(
            before
              ? [...old.conversations, ...data.conversations]
              : data.conversations,
          ).slice(-120),
        }));
    } catch (e) {
      if (version === listingVersion.current)
        setError(e instanceof Error ? e.message : "Couldn’t load sessions");
    } finally {
      if (version === listingVersion.current) setListBusy(false);
    }
  }
  useEffect(() => {
    if (!token) return;
    // A source/search change invalidates in-flight pages before replacing the private browser list.
    ++listingVersion.current;
    setListing({ conversations: [] });
    const timeout = setTimeout(() => {
      void list();
    }, 300);
    return () => {
      clearTimeout(timeout);
      ++listingVersion.current;
    };
  }, [token, source, search]);
  useEffect(() => {
    if (!selected || !token) return;
    const id = selected.conversation.id,
      ticket = selection.current;
    let closed = false,
      pending = false;
    const interval = setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const view = await request<SessionView>(
          `/api/sessions/view?id=${encodeURIComponent(id)}`,
        );
        // An unchanged view keeps the old object so the 4s poll doesn't
        // re-render the whole welcome page.
        if (!closed && ticket === selection.current)
          setSelected((old) =>
            old && JSON.stringify(old) === JSON.stringify(view) ? old : view,
          );
      } catch {
        if (!closed && ticket === selection.current)
          setNotice("Session disconnected. Select it again to reconnect.");
      } finally {
        pending = false;
      }
    }, 4000);
    return () => {
      closed = true;
      clearInterval(interval);
    };
  }, [selected?.conversation.id, token]);
  async function preview(id: string) {
    const ticket = ++selection.current;
    setSelected(undefined);
    setResultUrl("");
    await perform(async () => {
      const view = await request<SessionView>(
        `/api/sessions/view?id=${encodeURIComponent(id)}`,
      );
      if (ticket === selection.current) {
        setSelected(view);
        setChoice(
          view.conversation.config
            ? {
                ...view.conversation.config,
                ...settingsDoc?.value.managedModels?.[id],
              }
            : undefined,
        );
        setModels(undefined);
      }
    });
  }
  async function save(next = settingsDoc) {
    if (!next) throw new Error("Settings are still loading");
    if (
      path === "existing" &&
      selected?.conversation.source === "managed" &&
      models &&
      choice
    ) {
      next = {
        ...next,
        value: {
          ...next.value,
          managedModels: {
            ...next.value.managedModels,
            [selected.conversation.id]: {
              model: choice.model,
              effort: choice.effort,
            },
          },
        },
      };
    }
    const saved = await request<SettingsDocument>(
      `/api/settings${path === "new" ? `?runner=${runner}` : ""}`,
      next,
      "PUT",
    );
    setSettingsDoc(saved);
    return saved;
  }
  async function discover() {
    setModels(undefined);
    await perform(async () => {
      const current = path === "existing" ? selected?.conversation : undefined;
      const selectedCli = current?.cli ?? cli;
      const selectedRunner = current?.runner ?? runner;
      const data = await request<{ models: ModelChoice[] }>(
        `/api/sessions/models?cli=${selectedCli}&runner=${selectedRunner}`,
      );
      setModels(data.models);
      const model = data.models.find((m) => m.id === choice?.model);
      setChoice({
        ...choice,
        id: current?.config?.id ?? "session-1",
        cli: selectedCli,
        model: model?.id ?? "",
        effort:
          model && choice?.effort && model.efforts.includes(choice.effort)
            ? choice.effort
            : undefined,
      });
    });
  }
  // Remember only choices that successfully reached an applied boundary.
  const remember = (nextPath: "arena" | "existing" | "new", id?: string, boundary = runner) => request("/api/last-setup", { path: nextPath, runner: boundary, ...(id ? { sessionId: id } : {}) });
  async function continueFlow() {
    await perform(async () => {
      if (!(await switchPath(path))) return;
      if (path === "arena") {
        // switchPath("arena") above already handed the arena over (the server's
        // arena action is idempotent and does not read settings), so only save.
        await save();
        await remember("arena");
        location.assign("/control");
        return;
      }
      if (path === "existing") {
        await save();
        if (selected) await remember("existing", selected.conversation.id, selected.conversation.runner ?? "docker");
        return;
      }
      if (!choice || !settingsDoc || !models?.some((m) => m.id === choice.model)) {
        setNotice("Load models, then choose one before continuing.");
        return;
      }
      if (runner === "native" && !nativeAccepted) {
        setNotice("Choose Yes to allow native execution, or pick Docker.");
        return;
      }
      const next = {
        ...settingsDoc,
        value: { ...settingsDoc.value, sessions: [{ ...choice, cli }] },
      };
      await save(next);
      const c = await request<Conversation>("/api/sessions/action", {
        action: "create",
        cli,
        runner,
        ...(runner === "native" ? { nativeConsent: "NATIVE" } : {}),
      });
      await remember("existing", c.id, runner);
      ++selection.current;
      setSelected(
        await request<SessionView>(
          `/api/sessions/view?id=${encodeURIComponent(c.id)}`,
        ),
      );
      setPath("existing");
      setSource("managed");
      setResultUrl("");
      setListing({ conversations: [c] });
    });
  }
  const slot =
    (path === "new"
      ? choice?.id
      : (selected?.conversation.id ??
        settingsDoc?.value.sessions.find(
          (s) => s.cli === selected?.conversation.cli,
        )?.id)) ??
    choice?.id ??
    "session-1";
  const visibility =
    settingsDoc?.value.visibility[slot] ??
    selected?.visibility ??
    defaultVisibility;
  // Visibility saves straight away so the overlay follows each toggle. Only
  // this slot's choices are written, on top of the server's latest settings,
  // so other unsaved drafts on this page (mode, models) are not saved with it.
  const updateVisibility = (next: SessionVisibility) => {
    const key = slot;
    setSettingsDoc(
      (current) =>
        current && {
          ...current,
          value: {
            ...current.value,
            visibility: { ...current.value.visibility, [key]: next },
          },
        },
    );
    void perform(async () => {
      const latest = await request<SettingsDocument>("/api/settings");
      const saved = await request<SettingsDocument>(
        "/api/settings",
        {
          ...latest,
          value: {
            ...latest.value,
            visibility: { ...latest.value.visibility, [key]: next },
          },
        },
        "PUT",
      );
      setSettingsDoc(
        (current) =>
          current && {
            ...current,
            revision: saved.revision,
            value: { ...current.value, visibility: saved.value.visibility },
          },
      );
      // Refresh the private preview now instead of waiting for the 4s poll.
      if (selected) {
        const id = selected.conversation.id;
        const view = await request<SessionView>(
          `/api/sessions/view?id=${encodeURIComponent(id)}`,
        );
        setSelected((old) => (old?.conversation.id === id ? view : old));
      }
    });
  };
  const toolStatus = (name: string) =>
    ready?.tools.find((tool) => tool.name === name);
  const overlayDraft = overlayEditor.draft;
  const overlayApplied = overlayEditor.overlayDoc?.overlays.find(
    (overlay) => overlayDraft && overlay.id === overlayDraft.id,
  );
  return (
    <main className="welcome-page">
      <header className="welcome-header">
        <div>
          <span className="welcome-eyebrow">TWITCHING</span>
        </div>
        <div className="welcome-header-tools">
          <LastSetup token={token} revision={settingsDoc?.revision} applied={({ setup, document: saved, selected: restored }) => {
            ++selection.current;
            // A saved setup may list no sessions; keep the current CLI rather than crash.
            const firstSession = setup.sessions.at(0);
            setSettingsDoc(saved); setSelected(restored); setPath(setup.path); setRunner(setup.runner);
            setNativeAccepted(false); setModels(undefined); setChoice(restored?.conversation.config ? { ...restored.conversation.config, ...saved.value.managedModels?.[restored.conversation.id] } : firstSession); setCli((current) => restored?.conversation.cli ?? firstSession?.cli ?? current);
            setResultUrl(""); setNotice("Choices applied. Review, rehearse, then go live. Nothing started.");
          }} />
          {hostControls}
          {breakControl && (
            <BreakControl token={token} preferredId={overlayDraft?.id} initial={overlayEditor.overlayDoc} />
          )}
          {overlayDraft && overlayEditor.overlayDoc && (
            <OverlayPresentation
              key={overlayDraft.id}
              token={token}
              overlayId={overlayDraft.id}
              name={overlayApplied?.name ?? overlayDraft.name}
              initial={overlayEditor.overlayDoc.presentation?.[overlayDraft.id]}
              published={!!overlayApplied?.published}
            />
          )}
        <ChatMenu />
        <a className="quick-settings-link" href="/control/settings">
          Quick settings ↗
        </a>
        </div>
      </header>
      <div className="welcome-layout">
        <aside className="welcome-controls">
          <nav className="welcome-options" aria-label="Choose a mode" aria-busy={busy || !!handover}>
            {(
              [
                ["existing", "Existing session"],
                ["new", "New session"],
              ] as const
            ).map(([id, title]) => (
              <button
                key={id}
                disabled={busy || !!handover || !token}
                aria-pressed={path === id}
                onClick={() => { if (id !== path) void perform(() => switchPath(id)); }}
              >
                {title}
              </button>
            ))}
          </nav>
          <p className="mode-switch-hint">{path === "arena"
            ? "Arena mode · automatic prompt rounds"
            : path === "new" ? "Session mode · choose a model and start coding"
              : "Session mode · choose a conversation to preview"}</p>
          {handover && (
            <ModeHandover state={handover}
              choose={(choice) => setHandover({ ...handover, choice })}
              stay={() => { setHandover(undefined); setPath("arena"); }} />
          )}
          {error && (
            <div className="welcome-error mode-switch-warning" role="alert">
              <div><strong>{failedMode ? "Couldn’t switch modes" : "Action needs attention"}</strong><p>{error}</p></div>
              <div className="mode-switch-warning-actions">
                {failedMode
                  ? <button disabled={busy} onClick={() => { const target = failedMode; if (target) void perform(() => switchPath(target)); }}>Retry switch</button>
                  : <button onClick={() => location.reload()}>Reload</button>}
                <button onClick={() => { setError(""); setFailedMode(undefined); }}>Dismiss</button>
              </div>
            </div>
          )}
          {notice && (
            <p className="welcome-notice" role="status">
              {notice}
            </p>
          )}
          {path === "existing" && (
            <SessionBrowser
              source={source}
              search={search}
              listing={listing}
              selectedId={selected?.conversation.id}
              publishedId={listing.publishedId}
              publishedIds={
                overlayEditor.overlayDoc?.publishedSessionIds ??
                listing.publishedIds
              }
              checkedIds={overlayEditor.draft?.sessionIds ?? []}
              overlayName={overlayEditor.draft?.name}
              selectionDisabled={
                !overlayEditor.draft ||
                overlayEditor.busy ||
                overlayEditor.draft.selection === "follow-running"
              }
              toggleOverlay={overlayEditor.toggle}
              busy={busy}
              loading={listBusy}
              changeSource={setSource}
              changeSearch={setSearch}
              refresh={() => void list()}
              more={(before) => void list(before)}
              select={(id) => void preview(id)}
            />
          )}
          {path === "new" && settingsDoc && (
            <div className="new-session-settings">
              <LaunchChoices
                newSession
                busy={busy}
                cli={cli}
                runner={runner}
                nativeAccepted={nativeAccepted}
                changeCli={(next) => {
                  setCli(next);
                  setModels(undefined);
                  setChoice({ id: "session-1", cli: next, model: "" });
                }}
                changeRunner={(next) => {
                  setRunner(next);
                  setModels(undefined);
                  setNativeAccepted(false);
                }}
                changeNativeAccepted={setNativeAccepted}
                discover={() => void discover()}
              />
              <p
                className="model-readiness"
                role={models ? "status" : undefined}
              >
                {!models
                  ? "Load installed models to continue."
                  : models.some((model) => model.id === choice?.model) &&
                      runner === "native" &&
                      !nativeAccepted
                    ? "Choose Yes to allow native execution."
                    : models.some((model) => model.id === choice?.model)
                      ? "Ready · " + choice?.model
                      : models.length
                        ? "Choose a loaded model to continue."
                        : "No models found. Check the CLI install and login."}
              </p>
              {choice && (
                <SessionCard
                  hideVisibility
                  displayName="New managed session"
                  visibilitySaveLabel="Save with Continue"
                  session={choice}
                  index={0}
                  visibility={visibility}
                  models={models}
                  busy={busy}
                  change={setChoice}
                  toggle={updateVisibility}
                />
              )}
            </div>
          )}
          {path === "existing" &&
            selected?.conversation.source === "managed" && (
              <details className="session-model-settings">
                <summary>
                  Next prompt model ·{" "}
                  {choice?.model ?? selected.conversation.model}
                </summary>
                <button disabled={busy} onClick={() => void discover()}>
                  Refresh models
                </button>
                {choice && (
                  <SessionCard
                    hideVisibility
                    displayName="Managed session"
                    session={choice}
                    index={0}
                    visibility={visibility}
                    models={models}
                    busy={busy}
                    change={setChoice}
                    toggle={updateVisibility}
                  />
                )}
              </details>
            )}
          {path === "arena" && (
            <div className="arena-hint">
              <b>Existing prompt arena</b>
              <span>Continue opens the arena controls. Existing result rules stay.</span>
            </div>
          )}
        </aside>
        <section className="welcome-content">
          <div className="preview-card">
            <header className="preview-card-heading">
              <span>
                Private preview{" "}
                <small
                  className={
                    selected?.published
                      ? "published-status"
                      : "unpublished-status"
                  }
                >
                  {selected?.published ? "On stream" : "Not published"}
                </small>
              </span>
              {selected && (
                <nav className="preview-tabs" aria-label="Preview content">
                  <button
                    aria-pressed={!resultUrl}
                    onClick={() => setResultUrl("")}
                  >
                    Conversation
                  </button>
                  <button
                    aria-pressed={!!resultUrl}
                    disabled={busy || !selected.conversation.result}
                    onClick={() =>
                      void perform(async () => {
                        const result = await request<{ url: string }>(
                          `/api/sessions/result?id=${encodeURIComponent(selected.conversation.id)}`,
                        );
                        setResultUrl(result.url);
                      })
                    }
                  >
                    Result
                  </button>
                </nav>
              )}
              <button
                className="ghost-button"
                disabled={busy || !(overlayEditor.overlayDoc?.overlays.find((overlay) => overlay.id === "default")?.published ?? !!listing.publishedId)}
                onClick={() =>
                  void perform(async () => {
                    await request("/api/sessions/action", {
                      action: "unpublish",
                    });
                    setSelected(
                      (current) => current && { ...current, published: false },
                    );
                    setListing((current) => ({
                      ...current,
                      publishedId: undefined,
                    }));
                  })
                }
              >
                Stop Main
              </button>
            </header>
            {selected ? (
              <>
                <div className="preview-scroll" hidden={!!resultUrl}>
                  <Timeline
                    key={selected.conversation.id}
                    view={selected}
                    older={(before) =>
                      request<SessionView>(
                        `/api/sessions/view?${new URLSearchParams({ id: selected.conversation.id, before })}`,
                      )
                    }
                  />
                  {selected.conversation.source === "managed" && (
                    <form
                      className="welcome-prompt"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void perform(async () => {
                          await save();
                          await request("/api/sessions/action", {
                            action: "run",
                            id: selected.conversation.id,
                            text: prompt,
                            ...(selected.conversation.runner === "native" &&
                            nativeAccepted
                              ? { nativeConsent: "NATIVE" }
                              : {}),
                          });
                          setPrompt("");
                          setResultUrl("");
                        });
                      }}
                    >
                      <textarea
                        aria-label="Next prompt"
                        maxLength={12000}
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                        placeholder="Explain code, fix a bug, or build something…"
                      />
                      {selected.conversation.runner === "native" && (
                        <NativeConsent
                          accepted={nativeAccepted}
                          change={setNativeAccepted}
                        />
                      )}
                      <button
                        className="send-prompt"
                        disabled={
                          busy ||
                          !prompt.trim() ||
                          selected.conversation.pendingRun
                        }
                      >
                        {selected.conversation.pendingRun
                          ? "Prompt running"
                          : "Send prompt"}
                      </button>
                    </form>
                  )}
                </div>
                {resultUrl && (
                  <iframe
                    className="session-result"
                    title="Isolated optional HTML result"
                    src={resultUrl}
                    sandbox="allow-scripts allow-same-origin"
                  />
                )}
              </>
            ) : (
              <div className="preview-empty">
                <h2>Pick a session to preview</h2>
                <p>Choose Show on stream below to publish.</p>
              </div>
            )}
            {selected && (
              <div className="publication-actions">
                {selected.conversation.source !== "managed" && (
                  <p className="read-only-note">
                    Read-only history. This external session can't accept prompts.
                  </p>
                )}
                {selected.published &&
                  settingsDoc?.value.stream.mode === "rehearsal" && (
                    <button
                      className="ghost-button"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await request("/api/sessions/action", {
                            action: "confirm-rehearsal",
                            id: selected.conversation.id,
                          });
                          setNotice(
                            "Rehearsal confirmed. Start OBS, then choose live mode.",
                          );
                        })
                      }
                    >
                      Confirm rehearsal
                    </button>
                  )}
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await save();
                      await request("/api/sessions/action", {
                        action: "publish",
                        id: selected.conversation.id,
                      });
                      await remember("existing", selected.conversation.id, selected.conversation.runner ?? "docker");
                      setSelected(
                        (current) => current && { ...current, published: true },
                      );
                      setListing((current) => ({
                        ...current,
                        publishedId: selected.conversation.id,
                      }));
                    })
                  }
                >
                  Show on stream
                </button>
              </div>
            )}
          </div>
          <OverlayManager
            editor={overlayEditor}
            conversations={listing.conversations}
          >
            <OverlayVisibility
              value={visibility}
              busy={busy}
              change={updateVisibility}
            />
          </OverlayManager>
        </section>
      </div>
      <footer className="welcome-footer">
        <div className="footer-status">
          <label className="footer-mode">
            Mode
            <select
              value={settingsDoc?.value.stream.mode ?? "rehearsal"}
              disabled={!settingsDoc || busy}
              onChange={(event) =>
                setSettingsDoc(
                  (current) =>
                    current && {
                      ...current,
                      value: {
                        ...current.value,
                        stream: {
                          ...current.value.stream,
                          mode: event.target.value as "live" | "rehearsal",
                        },
                      },
                    },
                )
              }
            >
              <option value="rehearsal">Private rehearsal</option>
              <option value="live">Live</option>
            </select>
          </label>
          {(["Codex", "Docker", "Cursor", "Claude Code"] as const).map((name) => {
            const tool = toolStatus(name);
            return (
              <span className="readiness-pill" key={name}>
                <i className={tool?.available ? "ready" : "missing"} />
                {name}
                <b>{tool?.message ?? "Checking"}</b>
              </span>
            );
          })}
          <details className="footer-info">
            <summary
              aria-label="Readiness and connector limits"
              title="Readiness and connector limits"
            >
              <span aria-hidden="true">i</span>
            </summary>
            <div className="footer-info-popover">
              <h2>Readiness and connector limits</h2>
              {ready?.tools.map((tool) => (
                <p key={tool.name}>
                  <b>
                    {tool.name}: {tool.available ? "Ready" : "Needs attention"}
                  </b>{" "}
                  · {tool.message}
                </p>
              ))}
              <p>{ready?.login}</p>
              <p>{ready?.obs}</p>
              {ready &&
                Object.entries(ready.connectors).map(([name, connector]) => (
                  <p key={name}>
                    <b>{name}:</b> {connector.note}
                  </p>
                ))}
            </div>
          </details>
        </div>
        <div className="footer-actions">
          <button
            className="ghost-button"
            disabled={busy}
            onClick={() =>
              void perform(() =>
                request("/api/sessions/action", { action: "open-obs" }),
              )
            }
          >
            Open OBS
          </button>
          <button
            className="ghost-button"
            disabled={busy || !!handover || !token}
            aria-pressed={path === "arena"}
            onClick={() => { if (path !== "arena") void perform(() => switchPath("arena")); }}
          >
            Prompt arena
          </button>
          <RehearsalCheck token={token} context={path === "arena" ? "arena" : selected?.conversation.id ?? "unselected"} revision={settingsDoc?.revision} />
          <a
            className="ghost-button"
            href="/overlay"
            target="_blank"
            rel="noreferrer"
          >
            Preview overlay
          </a>
          <button
            className="primary-button"
            disabled={
              busy ||
              !!handover ||
              !settingsDoc ||
              (path === "new" &&
                (!models?.some((model) => model.id === choice?.model) ||
                  (runner === "native" && !nativeAccepted)))
            }
            onClick={() => void continueFlow()}
          >
            Continue
          </button>
        </div>
      </footer>
    </main>
  );
}

import { LastSetup } from "./LastSetup.js";
import { ModeHandover, type ModeHandoverState } from "./ModeHandover.js";
import { RehearsalCheck } from "./RehearsalCheck.js";
import { BreakControl } from "../break-control.js";
import React, { useEffect, useRef, useState } from "react";
import type { Agent, SessionConfig } from "../../shared/types.js";
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
  ["cliIcon", "Icon"],
  ["cliName", "Name"],
  ["command", "Commands"],
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
  const [document, setDocument] = useState<SettingsDocument>();
  const [ready, setReady] = useState<Readiness>();
  // Reflect server ownership on entry; loading this page must never switch modes.
  const [path, setPath] = useState<"existing" | "new" | "arena">(arenaActive ? "arena" : "existing");
  const [handover, setHandover] = useState<ModeHandoverState>();
  const [failedMode, setFailedMode] = useState<"existing" | "new" | "arena">();
  const [cli, setCli] = useState<Agent>("codex");
  const [runner, setRunner] = useState<"docker" | "native">("native");
  const [nativeAccepted, setNativeAccepted] = useState(false);
  const [models, setModels] = useState<ModelChoice[]>();
  const [choice, setChoice] = useState<SessionConfig>();
  const [source, setSource] = useState<"managed" | Agent>("codex");
  const [search, setSearch] = useState("");
  const [listing, setListing] = useState<Listing>({ conversations: [] });
  const [selected, setSelected] = useState<SessionView>();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const overlayEditor = useOverlayEditor(token);
  const publishedKeys = (
    overlayEditor.document?.publishedSessionIds ??
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
  async function perform<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  // Change tabs only after the server has transferred ownership of the arena.
  async function switchPath(target: "existing" | "new" | "arena") {
    setFailedMode(target);
    if (target === "arena") {
      await request("/api/sessions/action", { action: "arena" });
    } else {
      const result = await request<{ status: "ready" | "choice" | "waiting" }>(
        "/api/sessions/action", { action: "session-mode" });
      if (result.status !== "ready") {
        setPath("arena");
        setHandover({ target, ...(result.status === "waiting" ? { choice: "wait" as const } : {}) });
        setFailedMode(undefined);
        return false;
      }
    }
    setPath(target);
    setFailedMode(undefined);
    return true;
  }
  // Poll only during an explicit handover, one request at a time; never launch a model.
  useEffect(() => {
    if (!handover?.choice) return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const result = await hostRequest<{ status: string }>(token, "/api/sessions/action", {
          action: "session-mode", choice: handover.choice,
        });
        if (closed) return;
        if (result.status === "ready") {
          setPath(handover.target);
          setHandover(undefined);
          setNotice("Arena stopped. You can now continue with your session. OBS was left running.");
        } else timer = setTimeout(() => void check(), 1000);
      } catch (e) {
        if (!closed) {
          setError(e instanceof Error ? e.message : "Mode switch failed");
          setFailedMode(handover.target);
          setHandover(undefined);
        }
      }
    };
    void check();
    return () => { closed = true; clearTimeout(timer); };
  }, [handover, token]);
  useEffect(() => {
    if (!token) return;
    let closed = false;
    void Promise.all([
      request<SettingsDocument>("/api/settings"),
      request<Readiness>("/api/sessions/readiness"),
    ])
      .then(([doc, status]) => {
        if (!closed) {
          setDocument(doc);
          setReady(status);
          setChoice({
            ...doc.value.sessions[0],
            id: "session-1",
            cli: "codex",
            model: "",
            effort: undefined,
          });
        }
      })
      .catch((e) => {
        if (!closed) setError(String(e.message));
      });
    return () => {
      closed = true;
    };
  }, [token]);
  async function list(before?: string) {
    const version = ++listingVersion.current;
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
  }
  useEffect(() => {
    if (!token) return;
    // A source/search change invalidates in-flight pages before replacing the private browser list.
    ++listingVersion.current;
    setListing({ conversations: [] });
    const timeout = setTimeout(() => {
      void perform(() => list());
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
        if (!closed && ticket === selection.current) setSelected(view);
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
                ...document?.value.managedModels?.[id],
              }
            : undefined,
        );
        setModels(undefined);
      }
    });
  }
  async function save(next = document) {
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
    setDocument(saved);
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
        await save();
        await request("/api/sessions/action", { action: "arena" });
        await remember("arena");
        location.assign("/control");
        return;
      }
      if (path === "existing") {
        await save();
        if (selected) await remember("existing", selected.conversation.id, selected.conversation.runner ?? "docker");
        return;
      }
      if (!choice || !document || !models?.some((m) => m.id === choice.model)) {
        setNotice("Load models, then choose one before continuing.");
        return;
      }
      if (runner === "native" && !nativeAccepted) {
        setNotice("Choose Yes to allow native execution, or pick Docker.");
        return;
      }
      const next = {
        ...document,
        value: { ...document.value, sessions: [{ ...choice, cli }] },
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
        document?.value.sessions.find(
          (s) => s.cli === selected?.conversation.cli,
        )?.id)) ??
    choice?.id ??
    "session-1";
  const visibility =
    document?.value.visibility[slot] ??
    selected?.visibility ??
    defaultVisibility;
  const updateVisibility = (next: SessionVisibility) =>
    setDocument(
      (current) =>
        current && {
          ...current,
          value: {
            ...current.value,
            visibility: { ...current.value.visibility, [slot]: next },
          },
        },
    );
  const toolStatus = (name: string) =>
    ready?.tools.find((tool) => tool.name === name);
  const overlayDraft = overlayEditor.draft;
  const overlayApplied = overlayEditor.document?.overlays.find(
    (overlay) => overlayDraft && overlay.id === overlayDraft.id,
  );
  return (
    <main className="welcome-page">
      <header className="welcome-header">
        <div>
          <span className="welcome-eyebrow">TWITCHING</span>
        </div>
        <div className="welcome-header-tools">
          <LastSetup token={token} revision={document?.revision} applied={({ setup, document: saved, selected: restored }) => {
            ++selection.current;
            setDocument(saved); setSelected(restored); setPath(setup.path); setRunner(setup.runner);
            setNativeConsent(""); setModels(undefined); setChoice(restored?.conversation.config ? { ...restored.conversation.config, ...saved.value.managedModels?.[restored.conversation.id] } : setup.sessions[0]); setCli(restored?.conversation.cli ?? setup.sessions[0].cli);
            setResultUrl(""); setNotice("Choices applied. Review, rehearse, then go live. Nothing started.");
          }} />
          {hostControls}
          {breakControl && (
            <BreakControl token={token} preferredId={overlayDraft?.id} initial={overlayEditor.document} />
          )}
          {overlayDraft && overlayEditor.document && (
            <OverlayPresentation
              key={overlayDraft.id}
              token={token}
              overlayId={overlayDraft.id}
              name={overlayApplied?.name ?? overlayDraft.name}
              initial={overlayEditor.document.presentation?.[overlayDraft.id]}
              published={!!overlayApplied?.published}
            />
          )}
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
                overlayEditor.document?.publishedSessionIds ??
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
              changeSource={setSource}
              changeSearch={setSearch}
              refresh={() => void perform(() => list())}
              more={(before) => void perform(() => list(before))}
              select={(id) => void preview(id)}
            />
          )}
          {path === "new" && document && (
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
              <button
                className="ghost-button"
                disabled={busy || !(overlayEditor.document?.overlays.find((overlay) => overlay.id === "default")?.published ?? !!listing.publishedId)}
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
                  document?.value.stream.mode === "rehearsal" && (
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
              value={document?.value.stream.mode ?? "rehearsal"}
              disabled={!document || busy}
              onChange={(event) =>
                setDocument(
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
          {(["Codex", "Docker", "Cursor"] as const).map((name) => {
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
          <RehearsalCheck token={token} context={path === "arena" ? "arena" : selected?.conversation.id ?? "unselected"} revision={document?.revision} />
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
              !document ||
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

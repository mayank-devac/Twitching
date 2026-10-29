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
import { LaunchChoices } from "./LaunchChoices.js";
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
  ["cliIcon", "CLI icon"],
  ["cliName", "CLI name"],
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
  return (
    <section className="overlay-visibility">
      <header>
        <h2>Overlay visibility</h2>
        <span>
          {shown} of {visibilityChoices.length} shown
        </span>
      </header>
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
        Hide previous prompt runs <span>(history is kept)</span>
      </label>
    </section>
  );
}

// The welcome dialog edits the same revisioned preferences as Quick Settings.
export function Welcome({
  token,
  publishedId,
}: {
  token: string;
  publishedId?: string;
}) {
  const [document, setDocument] = useState<SettingsDocument>();
  const [ready, setReady] = useState<Readiness>();
  const [path, setPath] = useState<"existing" | "new" | "arena">("existing");
  const [cli, setCli] = useState<Agent>("codex");
  const [runner, setRunner] = useState<"docker" | "native">("docker");
  const [nativeConsent, setNativeConsent] = useState("");
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
  const selection = useRef(0);
  const listingVersion = useRef(0);
  useEffect(() => {
    setListing((value) => ({ ...value, publishedId }));
    setSelected(
      (value) =>
        value && { ...value, published: value.conversation.id === publishedId },
    );
  }, [publishedId]);
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
        conversations: before
          ? [...old.conversations, ...data.conversations].slice(-120)
          : data.conversations,
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
          setNotice(
            "Session disconnected. Keeping the last available conversation; retry selection to reconnect.",
          );
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
    await perform(async () => {
      const current = path === "existing" ? selected?.conversation : undefined;
      const selectedCli = current?.cli ?? cli;
      const selectedRunner = current?.runner ?? runner;
      const data = await request<{ models: ModelChoice[] }>(
        `/api/sessions/models?cli=${selectedCli}&runner=${selectedRunner}`,
      );
      setModels(data.models);
      const model =
        data.models.find((m) => m.id === choice?.model) ?? data.models[0];
      if (model)
        setChoice({
          id: current?.config?.id ?? "session-1",
          cli: selectedCli,
          model: model.id,
          effort:
            choice?.effort && model.efforts.includes(choice.effort)
              ? choice.effort
              : undefined,
        });
    });
  }
  async function continueFlow() {
    await perform(async () => {
      if (path === "arena") {
        await save();
        await request("/api/sessions/action", { action: "arena" });
        location.assign("/control");
        return;
      }
      if (path === "existing") {
        await save();
        setNotice(
          "Choose a session below to open its private preview. Nothing is published until Show on stream.",
        );
        return;
      }
      if (!choice || !document || !models?.some((m) => m.id === choice.model))
        throw new Error("Load installed models and choose one first");
      const next = {
        ...document,
        value: { ...document.value, sessions: [{ ...choice, cli }] },
      };
      await save(next);
      const c = await request<Conversation>("/api/sessions/action", {
        action: "create",
        cli,
        runner,
        ...(runner === "native" ? { nativeConsent } : {}),
      });
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
  return (
    <main className="welcome-page">
      <header className="welcome-header">
        <div>
          <span className="welcome-eyebrow">TWITCHING</span>
          <h1>Share the work. Keep your screen private.</h1>
        </div>
        <a className="quick-settings-link" href="/control/settings">
          Quick settings ↗
        </a>
      </header>
      <div className="welcome-layout">
        <aside className="welcome-controls">
          <nav className="welcome-options" aria-label="Experience">
            {(
              [
                ["existing", "Existing session"],
                ["new", "New session"],
                ["arena", "Prompt arena"],
              ] as const
            ).map(([id, title]) => (
              <button
                key={id}
                disabled={busy}
                aria-pressed={path === id}
                onClick={() => {
                  setPath(id);
                  setError("");
                }}
              >
                {title}
              </button>
            ))}
          </nav>
          {error && (
            <p className="welcome-error" role="alert">
              {error} <button onClick={() => location.reload()}>Reload</button>
            </p>
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
                consent={nativeConsent}
                changeCli={(next) => {
                  setCli(next);
                  setModels(undefined);
                  setChoice({ id: "session-1", cli: next, model: "" });
                }}
                changeRunner={(next) => {
                  setRunner(next);
                  setModels(undefined);
                  setNativeConsent("");
                }}
                changeConsent={setNativeConsent}
                discover={() => void discover()}
              />
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
              <span>
                Continue to open the arena controls. Its existing HTML result
                rules remain in place.
              </span>
            </div>
          )}
          <details className="welcome-readiness">
            <summary>Readiness and connector limits</summary>
            {ready?.tools.map((tool) => (
              <p key={tool.name}>
                {tool.name}: {tool.available ? "Ready" : "Needs attention"} ·{" "}
                {tool.message}
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
          </details>
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
                disabled={busy || !listing.publishedId}
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
                Stop publication
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
                            ...(nativeConsent === "NATIVE"
                              ? { nativeConsent }
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
                        <label className="native-consent">
                          Type NATIVE to approve this server’s native runs
                          <input
                            value={nativeConsent}
                            onChange={(event) =>
                              setNativeConsent(event.target.value)
                            }
                            autoComplete="off"
                          />
                        </label>
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
                  {selected.conversation.source !== "managed" && (
                    <p className="read-only-note">
                      Read-only saved history. Sending prompts and controlling
                      this external CLI are unavailable.
                    </p>
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
                <p>
                  Nothing reaches the overlay until you choose Show on stream.
                </p>
              </div>
            )}
            {selected && (
              <div className="publication-actions">
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
                            "Private rehearsal confirmed. Start OBS manually before choosing live mode.",
                          );
                        })
                      }
                    >
                      Confirm private rehearsal
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
                  {selected.published ? "On stream" : "Show on stream"}
                </button>
              </div>
            )}
          </div>
          <OverlayVisibility
            value={visibility}
            busy={busy}
            change={updateVisibility}
          />
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
            disabled={busy || !document}
            onClick={() => void continueFlow()}
          >
            Continue
          </button>
        </div>
      </footer>
    </main>
  );
}

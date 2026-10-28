import React, { useEffect, useRef, useState } from "react";
import type { Agent, SessionConfig } from "../../shared/types.js";
import type {
  Conversation,
  ConnectorCapabilities,
  SessionView,
} from "../../shared/sessions.js";
import type { ModelChoice, SettingsDocument } from "../../shared/settings.js";
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
  const [source, setSource] = useState<"managed" | Agent>("managed");
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
  return (
    <main className="welcome-page">
      <header className="welcome-header">
        <div>
          <span className="welcome-eyebrow">TWITCHING</span>
          <h1>Share the work. Keep your screen private.</h1>
          <p>
            Choose a session, preview its conversation, then decide what goes on
            stream.
          </p>
        </div>
        <a href="/control/settings">Quick Settings ↗</a>
      </header>
      <div className="welcome-layout">
        <section className="welcome-controls">
          <nav className="welcome-options" aria-label="Experience">
            {(
              [
                ["existing", "Share existing session"],
                ["new", "Start new session"],
                ["arena", "Existing prompt arena"],
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
            <p className="qs-error" role="alert">
              {error}{" "}
              <button onClick={() => location.reload()}>Reload latest</button>
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          <LaunchChoices
            newSession={path === "new"}
            busy={busy || !document}
            cli={cli}
            runner={runner}
            consent={nativeConsent}
            mode={document?.value.stream.mode ?? "rehearsal"}
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
            changeMode={(mode) =>
              setDocument(
                (d) =>
                  d && {
                    ...d,
                    value: { ...d.value, stream: { ...d.value.stream, mode } },
                  },
              )
            }
            discover={() => void discover()}
          />
          {document && (
            <>
              {path === "existing" &&
                selected?.conversation.source === "managed" && (
                  <button disabled={busy} onClick={() => void discover()}>
                    Load models for this session’s next prompt
                  </button>
                )}
              <SessionCard
                displayOnly={
                  path !== "new" && selected?.conversation.source !== "managed"
                }
                visibilitySaveLabel="Save with Continue or Show on stream"
                session={
                  (path === "new" ||
                    selected?.conversation.source === "managed") &&
                  choice
                    ? choice
                    : (document.value.sessions.find((s) => s.id === slot) ??
                      document.value.sessions[0])
                }
                index={0}
                visibility={visibility}
                models={models}
                busy={busy}
                change={setChoice}
                toggle={(v) =>
                  setDocument(
                    (d) =>
                      d && {
                        ...d,
                        value: {
                          ...d.value,
                          visibility: { ...d.value.visibility, [slot]: v },
                        },
                      },
                  )
                }
              />
            </>
          )}
          <p className="qs-hint">
            Keep previous prompt runs visible by default. The hide option
            changes the display only; history is never deleted.
          </p>
          <div className="welcome-actions">
            <button
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
              className="welcome-button"
              href="/overlay"
              target="_blank"
              rel="noreferrer"
            >
              Preview overlay
            </a>
            <button
              className="primary"
              disabled={busy || !document}
              onClick={() => void continueFlow()}
            >
              Continue
            </button>
          </div>
          <details className="welcome-card">
            <summary>Readiness & connector limits</summary>
            {ready?.tools.map((t) => (
              <p key={t.name}>
                {t.name}: {t.available ? "Ready" : "Needs attention"} ·{" "}
                {t.message}
              </p>
            ))}
            <p>{ready?.login}</p>
            <p>{ready?.obs}</p>
            {ready &&
              Object.entries(ready.connectors).map(([name, c]) => (
                <p key={name}>
                  <b>{name}:</b> {c.note}
                </p>
              ))}
          </details>
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
        </section>
        <section className="welcome-preview">
          <header className="welcome-preview-heading">
            <span>Private session preview</span>
            <button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await request("/api/sessions/action", {
                    action: "unpublish",
                  });
                  setSelected((s) => s && { ...s, published: false });
                  setListing((s) => ({ ...s, publishedId: undefined }));
                })
              }
            >
              Stop publication
            </button>
          </header>
          {selected ? (
            <>
              <nav className="welcome-actions" aria-label="Session view">
                <button onClick={() => setResultUrl("")}>Conversation</button>
                <button
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
                  Result (optional HTML)
                </button>
              </nav>
              <div hidden={!!resultUrl}>
                <Timeline
                  key={selected.conversation.id}
                  view={selected}
                  older={(before) =>
                    request(
                      `/api/sessions/view?${new URLSearchParams({ id: selected.conversation.id, before })}`,
                    )
                  }
                />
              </div>
              {resultUrl && (
                <iframe
                  className="session-result"
                  title="Isolated optional HTML result"
                  src={resultUrl}
                  sandbox="allow-scripts allow-same-origin"
                />
              )}
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await save();
                    await request("/api/sessions/action", {
                      action: "publish",
                      id: selected.conversation.id,
                    });
                    setSelected((s) => s && { ...s, published: true });
                    setListing((s) => ({
                      ...s,
                      publishedId: selected.conversation.id,
                    }));
                  })
                }
              >
                Show conversation on stream
              </button>
              {selected.published &&
                document?.value.stream.mode === "rehearsal" && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await request("/api/sessions/action", {
                          action: "confirm-rehearsal",
                          id: selected.conversation.id,
                        });
                        setNotice(
                          "Private rehearsal confirmed for this session. You can now choose live mode and publish after starting OBS manually.",
                        );
                      })
                    }
                  >
                    Confirm private rehearsal
                  </button>
                )}
              {selected.conversation.source === "managed" ? (
                <form
                  className="welcome-prompt"
                  onSubmit={(e) => {
                    e.preventDefault();
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
                  <label>
                    Next prompt
                    <textarea
                      maxLength={12000}
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder="Explain code, fix a bug, or build something…"
                    />
                  </label>
                  {selected.conversation.runner === "native" && (
                    <label>
                      Native runs have access to this computer. Type NATIVE if
                      this server has not been approved yet.
                      <input
                        value={nativeConsent}
                        onChange={(e) => setNativeConsent(e.target.value)}
                        autoComplete="off"
                      />
                    </label>
                  )}
                  <button
                    disabled={
                      busy || !prompt.trim() || selected.conversation.pendingRun
                    }
                  >
                    {selected.conversation.pendingRun
                      ? "Prompt running"
                      : "Send prompt"}
                  </button>
                </form>
              ) : (
                <p className="qs-hint">
                  Read-only saved history. Sending prompts, resuming, and
                  controlling this external CLI are disabled.
                </p>
              )}
            </>
          ) : (
            <div className="welcome-empty">
              <h2>Your conversation appears here.</h2>
              <p>
                Choose a session or start a new one. Nothing from this private
                preview goes to the overlay until you select Show on stream.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

import { hostRefresh } from "./host-refresh.js";
import {
  PresentationControls,
  GoalStrip,
  usePrivacyShortcuts,
} from "./presentation-controls.js";
import { RehearsalCheck } from "./welcome/RehearsalCheck.js";
import { sessionCli, sessionLabel } from "../shared/types.js";
import { QuickSettings } from "./settings/QuickSettings.js";
import { Welcome } from "./welcome/Welcome.js";
import { Timeline } from "./welcome/Timeline.js";
import { OverlayScreen } from "./overlays/OverlayScreen.js";
import { applyOverlayPatches } from "../shared/overlay-stream.js";
import { parseServerMessage } from "../shared/server-message.js";
import { BreakScreen } from "./break-screen.js";
import { BreakControl } from "./break-control.js";
import { defaultVisibility } from "../shared/settings.js";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import { markdownComponents, markdownPlugins } from "./markdown.js";
import "./markdown.css";
import type {
  Activity,
  ActivityLane,
  SessionId,
  ShowState,
} from "../shared/types.js";
import "./style.css";
import codexLogo from "../assets/codex/codex.svg";
import botLogo from "../assets/chatgpt/chatgpt-icon.svg";
import cursorLogo from "../assets/cursor/Cube/SVG/CUBE_2D_DARK.svg";
import { mergeActivityPatches } from "../shared/activity-stream.js";
import { useNow } from "./use-now.js";
// The settings tab shares host authentication but renders its own focused page.
const settingsPage = location.pathname === "/control/settings";
const welcomePage = location.pathname === "/control/welcome";
const namedOverlay = location.pathname.startsWith("/overlay/");
const outputId = namedOverlay
  ? location.pathname.slice("/overlay/".length)
  : "default";
const control = location.pathname === "/control" || settingsPage || welcomePage;
function MarkdownText({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        skipHtml
        remarkPlugins={markdownPlugins}
        components={markdownComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
function clock(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
// Renders only the remaining time so the 250ms tick stays out of App.
function Countdown({ until }: { until: number }) {
  const now = useNow(250);
  return <>{clock(until - now)}</>;
}
function App() {
  const [state, setState] = useState<ShowState>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [suggestion, setSuggestion] = useState(
    "!prompt Create a colourful bouncing ball animation with gravity controls",
  );
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [cliBoardsOpen, setCliBoardsOpen] = useState(true);
  const [stopMenu, setStopMenu] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [chatYoutube, setChatYoutube] = useState(false);
  const [chatTwitch, setChatTwitch] = useState(false);
  const [chatKick, setChatKick] = useState(false);
  const [csrf, setCsrf] = useState("");
  const csrfRef = useRef("");
  const [previewOrigin, setPreviewOrigin] = useState("");
  useEffect(() => {
    let closed = false;
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let delay = 1000;
    let context = "";
    const refresh = hostRefresh(
      async (signal) => {
        const response = await fetch("/api/host-state", {
          signal,
          headers: { "X-Host-Token": csrfRef.current },
        });
        if (!response.ok) throw new Error("Host refresh failed");
        return response.json() as Promise<ShowState>;
      },
      (hostState) =>
        setState((current) => ({
          ...hostState,
          experience: hostState.experience,
          sharedSession: hostState.sharedSession,
          sharedOverlay: hostState.sharedOverlay,
          events:
            current && !hostState.presentation?.hidden
              ? [
                  ...current.events.filter((event) => !event.lane),
                  ...hostState.events.filter((event) => event.lane),
                ]
              : hostState.events,
          presentation: hostState.presentation,
        })),
    );
    const loadHostState = () => refresh.request();
    const connect = () => {
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/events${namedOverlay ? `?overlay=${encodeURIComponent(outputId)}` : ""}`,
      );
      ws.onopen = () => {
        setConnected(true);
        delay = 1000;
      };
      ws.onmessage = (e) => {
        try {
          // Malformed frames throw here and fall through to the error below.
          const message = parseServerMessage(e.data);
          const incoming = message.state;
          // An old session/connection must never overwrite a newer private host lane.
          const nextContext = JSON.stringify([
            incoming.hostContext,
            incoming.experience,
            incoming.round?.id,
            incoming.sharedOverlay?.frames.map((f) => f.conversation.id),
            incoming.presentation?.hidden,
          ]);
          const changedContext = nextContext !== context;
          if (changedContext) {
            context = nextContext;
            refresh.invalidate();
          }

          if (message.type === "update") {
            setPreviewOrigin(message.previewOrigin);
            setState((current) => {
              // Hidden sockets carry no transcript; the authenticated refresh supplies private host content.
              if (control && incoming.presentation?.hidden && current) {
                return {
                  ...current,
                  presentation: current.presentation
                    ? { ...current.presentation, hidden: true }
                    : incoming.presentation,
                };
              }
              try {
                const events = mergeActivityPatches(
                  current?.events ?? [],
                  message.patches,
                  message.eventIds,
                );
                // Build new objects rather than mutating the parsed frame: React may
                // replay this updater, and a mutated frame would be patched twice.
                let { sharedOverlay, sharedSession } = incoming;
                if (sharedOverlay) {
                  sharedOverlay = applyOverlayPatches(
                    current?.sharedOverlay,
                    sharedOverlay,
                    message.overlayPatches,
                  );
                  sharedSession =
                    sharedOverlay.frames.length === 1
                      ? sharedOverlay.frames[0]
                      : undefined;
                } else if (sharedSession) {
                  sharedSession = {
                    ...sharedSession,
                    page: {
                      ...sharedSession.page,
                      items: mergeActivityPatches(
                        current?.sharedSession?.conversation.id ===
                          sharedSession.conversation.id
                          ? current.sharedSession.page.items
                          : [],
                        message.sessionPatches,
                        message.sessionItemIds,
                      ),
                    },
                  };
                }
                return {
                  ...incoming,
                  sharedOverlay,
                  sharedSession,
                  presentation:
                    control &&
                    incoming.presentation?.hidden &&
                    current?.presentation
                      ? { ...current.presentation, hidden: true }
                      : incoming.presentation,
                  events: [
                    ...events,
                    ...(control && !changedContext
                      ? (current?.events.filter((event) => event.lane) ?? [])
                      : []),
                  ],
                };
              } catch {
                ws.close();
                return current;
              }
            });
            if (control && csrfRef.current) void loadHostState();
          } else {
            const snapshot: ShowState = incoming.sharedOverlay
              ? {
                  ...incoming,
                  sharedSession:
                    incoming.sharedOverlay.frames.length === 1
                      ? incoming.sharedOverlay.frames[0]
                      : undefined,
                }
              : incoming;
            setPreviewOrigin(message.previewOrigin);
            if (control && csrfRef.current) {
              setState((current) =>
                control && snapshot.presentation?.hidden && current
                  ? {
                      ...current,
                      presentation: current.presentation
                        ? { ...current.presentation, hidden: true }
                        : snapshot.presentation,
                    }
                  : {
                      ...snapshot,
                      presentation:
                        control &&
                        snapshot.presentation?.hidden &&
                        current?.presentation
                          ? { ...current.presentation, hidden: true }
                          : snapshot.presentation,
                      events: [
                        ...snapshot.events,
                        ...(!changedContext
                          ? (current?.events.filter((event) => event.lane) ??
                            [])
                          : []),
                      ],
                    },
              );
              void loadHostState();
            } else setState(snapshot);
          }
        } catch {
          setError("Invalid overlay update");
        }
      };
      ws.onclose = () => {
        refresh.invalidate();
        setConnected(false);
        if (!closed) {
          retry = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 10000);
        }
      };
      ws.onerror = () => ws.close();
    };
    connect();
    if (control)
      fetch("/api/host")
        .then((r) => r.json())
        .then((data) => {
          if (closed) return;
          refresh.invalidate();
          csrfRef.current = data.csrf;
          setCsrf(data.csrf);
          return loadHostState();
        })
        .catch(() => setError("Host controls unavailable"));
    return () => {
      closed = true;
      refresh.close();
      clearTimeout(retry);
      ws?.close();
    };
  }, []);
  useEffect(() => {
    if (state?.awaitingHostChoice) setStopMenu(true);
    if (state?.status === "stopped") setStopMenu(false);
  }, [state?.awaitingHostChoice, state?.status]);
  useEffect(() => {
    if (!stopMenu) {
      setChatOpen(false);
      setEndOpen(false);
    }
  }, [stopMenu]);
  usePrivacyShortcuts(control ? csrf : "", setError);
  const roundId = state?.round?.id;
  const roundTask = state?.round?.task.text;
  const [pop, setPop] = useState(false);
  useEffect(() => {
    if (roundTask) setPop(true);
  }, [roundId, roundTask]);
  useEffect(() => {
    if (!pop) return;
    const t = setTimeout(() => setPop(false), 4500);
    return () => clearTimeout(t);
  }, [pop]);
  async function action(name: string, extra: Record<string, unknown> = {}) {
    setWorking(true);
    setError("");
    try {
      const response = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Host-Token": csrf },
        body: JSON.stringify({ action: name, text: suggestion, ...extra }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Action failed");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
      return false;
    } finally {
      setWorking(false);
    }
  }
  async function pickStop(choice: string) {
    const ok = await action("stop-choice", {
      choice,
      youtube: chatYoutube,
      twitch: chatTwitch,
      kick: chatKick,
    });
    if (ok) setStopMenu(false);
  }
  if (!state)
    return (
      <main className="connecting">
        <span className="wordmark">
          PROMPT<span>ARENA</span>
        </span>
        <p>Connecting to the local controller…</p>
        <p>OBS refreshes reconnect to the same round.</p>
      </main>
    );
  // Host bootstrap and privacy-shortcut failures land in App's error, which the
  // arena layout renders inline; the settings and welcome routes need it shown too.
  const hostError = error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
  // A normal route keeps Quick Settings separate from the broadcast layout.
  if (settingsPage)
    return (
      <>
        {hostError}
        <QuickSettings state={state} token={csrf} connected={connected} />
      </>
    );
  if (welcomePage || (control && state.experience !== "arena"))
    return (
      <>
        {hostError}
        <Welcome
          token={csrf}
          arenaActive={state.experience === "arena"}
          publishedId={state.sharedSession?.conversation.id}
          breakControl={welcomePage}
          hostControls={
            <PresentationControls state={state} token={csrf} shortcutsOnly />
          }
        />
      </>
    );
  if (!control && (state.presentation?.hidden || !connected))
    return <main className="privacy-screen">Back shortly</main>;
  if (!control && state.presentation?.breakActive)
    return <BreakScreen state={state} host={false} />;
  if (
    !control &&
    (namedOverlay || (state.experience && state.experience !== "arena"))
  )
    return (
      <div className="public-surface">
        <GoalStrip value={state.presentation} />
        <OverlayScreen view={state.sharedOverlay} />
      </div>
    );
  const round = state.round;
  const countdown =
    state.status === "break"
      ? state.breakUntil
      : state.status === "results"
        ? state.resultUntil
        : state.collectionDeadline;
  return (
    <main className={control ? "host" : "overlay"}>
      {control ? (
        <nav className="host-top-tools" aria-label="Show controls">
          {welcomePage ? <BreakControl token={csrf} /> : null}
        </nav>
      ) : (
        <GoalStrip value={state.presentation} />
      )}
      {control && (
        <RehearsalCheck
          token={csrf}
          context="arena"
          revision={state.quickSettings?.revision}
        />
      )}
      {control && (
        <section className="prompt-strip" hidden={!round?.task.text}>
          {round?.task.text && <h1>{round.task.text}</h1>}
          <div className="prompt-meta">
            <span>
              {round?.task.author && (
                <>
                  by <b>{round.task.author}</b>
                </>
              )}
            </span>
            <span className="suggest-count">{state.candidateCount}/30</span>
            <span className="phase-count">
              {state.status === "break"
                ? "BREAK"
                : state.status === "results"
                  ? "NEXT"
                  : state.prepared
                    ? "READY"
                    : "COLLECT"}{" "}
              <b>{countdown ? <Countdown until={countdown} /> : ""}</b>
            </span>
          </div>
        </section>
      )}
      {control && (
        <div className="status-bar">
          <span className="status-pill">{state.status}</span>
          {state.playlistTotal ? (
            <span className="status-pill">
              LIST {state.playlistIndex ?? 0}/{state.playlistTotal}
            </span>
          ) : null}
          <span className="status-reason">{state.reason}</span>
          {state.obsReconnectDeadline && (
            <span className="status-pill" role="alert">
              RECONNECTING <Countdown until={state.obsReconnectDeadline} />
            </span>
          )}
          {state.quota && (
            <span
              className="quota"
              title="Shared Codex account allowance for all Codex sessions"
            >
              {Math.round(state.quota.remainingPercent)}%
            </span>
          )}
          <div className="show-label">
            <span className={`dot ${connected ? "online" : ""}`} />
            {!connected && "RECONNECTING"}
            ROUND {String(round?.id ?? 0).padStart(2, "0")}
          </div>
        </div>
      )}
      {!control && state.prepared?.text && (
        <footer className="next-strip">
          <span>{state.prepared.text}</span>
        </footer>
      )}
      {state.status === "break" ? (
        <BreakScreen state={state} host={control} />
      ) : (
        <>
          {!control && round?.task.text && (
            <div className="overlay-prompt" aria-label="Current prompt">
              <p>{round.task.text}</p>
            </div>
          )}
          <div className={`arena ${state.agents?.length === 1 ? "solo" : ""}`}>
            {(state.agents ?? (["cursor", "codex"] as const)).map((agent) => (
              <AgentPanel key={agent} agent={agent} state={state} />
            ))}
            {!control && !state.round && state.agents?.length !== 1 && (
              <div className="versus">VS</div>
            )}
          </div>
        </>
      )}
      {!control && pop && round?.task.text && (
        <div className="prompt-pop">
          <div>
            <span>ROUND {String(round.id).padStart(2, "0")}</span>
            <h2>{round.task.text}</h2>
            {round.task.author && <p>{round.task.author}</p>}
          </div>
        </div>
      )}
      {control && (
        <section className="controls">
          {/* Host settings open in a separate accessible tab. */}
          <div className="control-heading">
            <a href="/control/welcome">Sessions</a>
            <a
              href="/control/settings"
              target="_blank"
              rel="noopener noreferrer"
            >
              Quick Settings ↗
            </a>
            <a href="/overlay" target="_blank" rel="noreferrer">
              overlay ↗
            </a>
          </div>
          <div className="control-toolbar">
            <div className="buttons">
              <button
                disabled={
                  working ||
                  !csrf ||
                  (["running", "collecting", "results", "break"].includes(
                    state.status,
                  ) &&
                    !(state.status === "break" && state.breakKind === "manual"))
                }
                onClick={() => action("start")}
              >
                Start
              </button>
              <button
                disabled={
                  working || ["paused", "stopped"].includes(state.status)
                }
                onClick={() => action("pause")}
              >
                Pause
              </button>
              <button
                disabled={
                  working ||
                  (state.status !== "paused" &&
                    !(state.status === "break" && state.breakKind === "manual"))
                }
                onClick={() => action("resume")}
              >
                Resume
              </button>
              <button
                disabled={
                  working ||
                  !round ||
                  !Object.values(round.attempts).some(
                    (a) => a.status === "running",
                  )
                }
                onClick={() => action("skip")}
              >
                Skip
              </button>
              <button
                className={stopMenu ? "danger toggle-on" : "danger"}
                disabled={working || state.status === "stopped"}
                aria-expanded={stopMenu}
                onClick={() => setStopMenu((open) => !open)}
              >
                Stop
              </button>
              {stopMenu && state.status !== "stopped" && (
                <>
                  {(state.playlistTotal || state.awaitingHostChoice) && (
                    <button
                      className={chatOpen ? "toggle-on" : ""}
                      aria-expanded={chatOpen}
                      disabled={working}
                      onClick={() => {
                        setEndOpen(false);
                        setChatOpen((open) => !open);
                      }}
                    >
                      Chat
                    </button>
                  )}
                  <button
                    className={endOpen ? "danger toggle-on" : "danger"}
                    aria-expanded={endOpen}
                    disabled={working}
                    onClick={() => {
                      setChatOpen(false);
                      setEndOpen((open) => !open);
                    }}
                  >
                    End
                  </button>
                  {chatOpen &&
                    (state.playlistTotal || state.awaitingHostChoice) && (
                      <>
                        <label className="stop-platform">
                          <input
                            type="checkbox"
                            checked={chatYoutube}
                            onChange={(e) => setChatYoutube(e.target.checked)}
                          />
                          YouTube
                        </label>
                        <label className="stop-platform">
                          <input
                            type="checkbox"
                            checked={chatTwitch}
                            onChange={(e) => setChatTwitch(e.target.checked)}
                          />
                          Twitch
                        </label>
                        <label className="stop-platform">
                          <input
                            type="checkbox"
                            checked={chatKick}
                            onChange={(e) => setChatKick(e.target.checked)}
                          />
                          Kick
                        </label>
                        <button
                          disabled={
                            working ||
                            (!chatYoutube && !chatTwitch && !chatKick)
                          }
                          onClick={() => void pickStop("chat-after")}
                        >
                          After this round
                        </button>
                        <button
                          disabled={
                            working ||
                            (!chatYoutube && !chatTwitch && !chatKick)
                          }
                          onClick={() => void pickStop("chat-now")}
                        >
                          Now
                        </button>
                      </>
                    )}
                  {endOpen && (
                    <>
                      <button
                        disabled={working}
                        onClick={() => void pickStop("stream-after")}
                      >
                        After this round
                      </button>
                      <button
                        className="danger"
                        disabled={working}
                        onClick={() => void pickStop("stream-now")}
                      >
                        Now
                      </button>
                    </>
                  )}
                </>
              )}
              {state.mode === "rehearsal" && !state.playlistTotal && (
                <>
                  <button
                    disabled={
                      working ||
                      !["paused", "collecting"].includes(state.status)
                    }
                    onClick={() => action("rehearsal-task")}
                  >
                    Task
                  </button>
                  <button
                    disabled={
                      working ||
                      !round ||
                      Object.values(round.attempts).some(
                        (a) => a.status !== "complete",
                      )
                    }
                    onClick={() => action("confirm-rehearsal")}
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    className={suggestOpen ? "toggle-on" : ""}
                    aria-expanded={suggestOpen}
                    onClick={() => setSuggestOpen((open) => !open)}
                  >
                    Prompt
                  </button>
                </>
              )}
            </div>
            <button
              type="button"
              className={`cli-toggle${cliBoardsOpen ? " toggle-on" : ""}`}
              aria-expanded={cliBoardsOpen}
              onClick={() => setCliBoardsOpen((open) => !open)}
            >
              {cliBoardsOpen ? "Hide CLI" : "CLI"}
            </button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {state.mode === "rehearsal" &&
            !state.playlistTotal &&
            suggestOpen && (
              <form
                className="suggest-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action("suggest");
                }}
              >
                <label htmlFor="suggest">Prompt</label>
                <textarea
                  id="suggest"
                  rows={2}
                  value={suggestion}
                  onChange={(e) => setSuggestion(e.target.value)}
                />
                <button disabled={working}>Test</button>
              </form>
            )}
          {cliBoardsOpen && <CliBoards state={state} />}
          <div className="host-grid">
            <div>
              <ul className="checks">
                {Object.entries(state.connections).map(([p, s]) => (
                  <li key={p}>
                    <span>{p}</span>
                    <b>{s}</b>
                  </li>
                ))}
                {state.checks.map((check) => (
                  <li key={check}>✓ {check}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="candidates">
                {state.candidates.map((c) => (
                  <article key={c.id}>
                    <div>
                      <b>{c.score.toFixed(1)}</b>
                      <span>
                        {c.message.author} · {c.message.platform}
                      </span>
                    </div>
                    <p>{c.text}</p>
                    <button
                      disabled={working}
                      onClick={() => action("reject", { id: c.id })}
                    >
                      x
                    </button>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
const lanes: ActivityLane[] = ["read", "write", "tool", "terminal"];
const laneLabel: Record<ActivityLane, string> = {
  read: "READ",
  write: "WRITE",
  tool: "tool call",
  terminal: "terminal use",
};
const CLI_TAG_MS = 1400;
function CliColumn({
  agent,
  cli,
  lane,
  rows,
}: {
  agent: SessionId;
  cli: string | undefined;
  lane: ActivityLane;
  rows: Activity[];
}) {
  const log = useRef<HTMLUListElement>(null);
  const textSize = rows.reduce((size, row) => size + row.text.length, 0);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [rows.length, textSize]);
  const [tagVisible, setTagVisible] = useState(false);
  const hideTagTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(hideTagTimer.current), []);
  const flashTag = () => {
    clearTimeout(hideTagTimer.current);
    setTagVisible(true);
    hideTagTimer.current = setTimeout(() => setTagVisible(false), CLI_TAG_MS);
  };
  const hideTag = () => {
    clearTimeout(hideTagTimer.current);
    setTagVisible(false);
  };
  return (
    <div
      className="cli-column"
      aria-label={`${agent} ${laneLabel[lane]}`}
      onMouseEnter={flashTag}
      onMouseLeave={hideTag}
      onFocus={flashTag}
      onBlur={hideTag}
    >
      <span
        className={`cli-column-tag${tagVisible ? " visible" : ""}`}
        aria-hidden="true"
      >
        <img src={cli === "cursor" ? cursorLogo : codexLogo} alt="" />
        {laneLabel[lane]}
      </span>
      <ul ref={log}>
        {rows.map((row) => (
          <li
            key={row.id}
            className={lane === "terminal" ? "command-line" : undefined}
          >
            {row.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
function CliBoards({ state }: { state: ShowState }) {
  return (
    <div className={`cli-boards ${state.agents?.length === 1 ? "solo" : ""}`}>
      {(state.agents ?? (["cursor", "codex"] as const)).map((agent) => (
        <section
          key={agent}
          className="cli-board"
          aria-label={`${agent} activity`}
        >
          <div className="cli-columns">
            {lanes.map((lane) => {
              const rows = state.events.filter(
                (e) => e.agent === agent && e.lane === lane,
              );
              return (
                <CliColumn
                  key={lane}
                  agent={agent}
                  cli={sessionCli(state, agent)}
                  lane={lane}
                  rows={rows}
                />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
// Only the header timer ticks; the transcript below re-renders on state changes.
function AttemptTimer({
  startedAt,
  endedAt,
}: {
  startedAt?: number;
  endedAt?: number;
}) {
  const now = useNow(250);
  const elapsed = startedAt ? (endedAt ?? now) - startedAt : 0;
  return <time>{clock(elapsed)}</time>;
}
function AgentPanel({ agent, state }: { agent: SessionId; state: ShowState }) {
  const attempt = state.round?.attempts[agent];
  const cli = sessionCli(state, agent);
  const model = attempt ? sessionLabel(attempt) : state.models?.[agent];
  // Visibility affects public presentation only; host inspection keeps the full view.
  const visibility = control
    ? defaultVisibility
    : (state.quickSettings?.visibility[agent] ?? defaultVisibility);
  const cliLabel = `${cli === "codex" ? "Codex" : "Cursor"} ${(state.agents?.indexOf(agent) ?? 0) === 0 ? "Left" : "Right"}`;
  const showIntro = !control && !state.round;
  const events = state.events.filter((e) => e.agent === agent && !e.lane);
  const log = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    if (attempt?.preview) {
      previewTimer.current = setTimeout(() => setFailed(true), 10000);
      return () => clearTimeout(previewTimer.current);
    }
  }, [attempt?.preview]);
  const textSize = events.reduce((n, e) => n + e.text.length, 0);
  useEffect(() => {
    const node = log.current;
    if (!node) return;
    const scroll = () => {
      node.scrollTop = node.scrollHeight;
    };
    scroll();
    const frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [events.length, textSize]);
  // Group consecutive real Cursor deltas to keep character streaming readable.
  const lines: Activity[] = [];
  for (const event of events) {
    const last = lines.at(-1);
    if (event.append && event.kind === "message" && last?.kind === "message")
      last.text += event.text;
    else lines.push({ ...event });
  }
  return (
    <section className={`agent-panel ${cli}`}>
      <div className="agent-header">
        {visibility.cliIcon && (
          <div className="agent-icon">
            <img
              src={cli === "codex" ? codexLogo : cursorLogo}
              alt={cli === "codex" ? "Codex" : "Cursor"}
            />
          </div>
        )}
        <div>
          {visibility.cliName && <h2>{cliLabel}</h2>}
          {visibility.model && model && <p>{model}</p>}
        </div>
        <div className="agent-state" aria-label={attempt?.status ?? "idle"}>
          <span
            className={`dot ${attempt?.status === "running" ? "online" : ""}`}
          />
        </div>
        <AttemptTimer
          startedAt={attempt?.startedAt}
          endedAt={attempt?.endedAt}
        />
      </div>
      <div className="agent-content">
        {showIntro ? (
          <div className="empty-state model-intro">
            {visibility.cliIcon && (
              <img
                className="empty-logo"
                src={cli === "codex" ? codexLogo : cursorLogo}
                alt=""
              />
            )}
            {visibility.cliName && <h3>{cliLabel}</h3>}
            {visibility.model && model && <p>{model}</p>}
          </div>
        ) : attempt?.status === "complete" && attempt.preview && !failed ? (
          <>
            <iframe
              title={`${agent} HTML result`}
              src={attempt.preview}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className={loaded ? "result-frame" : "result-frame loading"}
              onLoad={() => {
                if (previewTimer.current) clearTimeout(previewTimer.current);
                setLoaded(true);
                setFailed(false);
              }}
              onError={() => setFailed(true)}
            />
            {!loaded && (
              <div className="empty-state">
                <span className="orbit" />
              </div>
            )}
          </>
        ) : (attempt &&
            ["error", "timeout", "cancelled"].includes(attempt.status)) ||
          failed ? (
          <div className="failure-card">
            <span>!</span>
            <h3>{attempt?.status}</h3>
            <p>
              {visibility.error
                ? (attempt?.error ?? "")
                : "Error details hidden by overlay settings"}
            </p>
          </div>
        ) : (
          <div className="activity-log" ref={log}>
            {lines.length ? (
              lines.map((e) => (
                <div key={e.id} className={`event ${e.kind}`}>
                  <span className="event-kind">
                    {e.kind === "summary" ? "THINKING" : e.kind.toUpperCase()}
                  </span>
                  {e.kind === "message" || e.kind === "summary" ? (
                    <MarkdownText>{e.text}</MarkdownText>
                  ) : e.diff || (e.kind === "edit" && e.text.includes("<")) ? (
                    <pre className="edit-source">{e.text}</pre>
                  ) : (
                    <p>{e.text}</p>
                  )}
                </div>
              ))
            ) : (
              <div className="empty-state">
                {visibility.cliIcon && (
                  <img
                    className="empty-logo"
                    src={cli === "codex" ? botLogo : cursorLogo}
                    alt=""
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

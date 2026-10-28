import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import type {
  Activity,
  ActivityLane,
  Agent,
  ShowState,
} from "../shared/types.js";
import "./style.css";
import codexLogo from "../assets/codex/codex.svg";
import botLogo from "../assets/chatgpt/chatgpt-icon.svg";
import cursorLogo from "../assets/cursor/Cube/SVG/CUBE_2D_DARK.svg";
import { mergeActivityPatches } from "../shared/activity-stream.js";
const control = location.pathname === "/control";
function MarkdownText({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
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
function App() {
  const [state, setState] = useState<ShowState>();
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
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
  const [audioError, setAudioError] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    let closed = false;
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let delay = 1000;
    let hostTicket = 0;
    const loadHostState = (token: string, fallback?: ShowState) => {
      const ticket = ++hostTicket;
      return fetch("/api/host-state", {
        headers: { "X-Host-Token": token },
      })
        .then((response) => {
          if (!response.ok) throw new Error("host");
          return response.json() as Promise<ShowState>;
        })
        .then((hostState) => {
          if (!closed && ticket === hostTicket) setState(hostState);
        })
        .catch(() => {
          if (!closed && ticket === hostTicket && fallback) setState(fallback);
        });
    };
    const connect = () => {
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/events`,
      );
      ws.onopen = () => {
        setConnected(true);
        delay = 1000;
      };
      ws.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          if (payload.type === "update") {
            setPreviewOrigin(payload.previewOrigin);
            setState((current) => {
              try {
                const events = mergeActivityPatches(current?.events ?? [], payload.patches, payload.eventIds);
                return { ...payload.state, events: [
                  ...events,
                  ...(control ? current?.events.filter((event) => event.lane) ?? [] : []),
                ] };
              } catch {
                ws.close();
                return current;
              }
            });
            if (control && csrfRef.current) void loadHostState(csrfRef.current);
          } else if (payload.type === "snapshot") {
            setPreviewOrigin(payload.previewOrigin);
            if (control && csrfRef.current) {
              setState((current) => ({
                ...payload.state,
                events: [
                  ...payload.state.events,
                  ...(current?.events.filter((event) => event.lane) ?? []),
                ],
              }));
              void loadHostState(csrfRef.current, payload.state);
            } else setState(payload.state);
          }
        } catch {
          setError("Invalid overlay update");
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) {
          retry = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 10000);
        }
      };
      ws.onerror = () => ws.close();
    };
    connect();
    const timer = setInterval(() => setNow(Date.now()), 250);
    if (control)
      fetch("/api/host")
        .then((r) => r.json())
        .then((data) => {
          csrfRef.current = data.csrf;
          setCsrf(data.csrf);
          return loadHostState(data.csrf);
        })
        .catch(() => setError("Host controls unavailable"));
    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(timer);
      ws?.close();
    };
  }, []);
  useEffect(() => {
    if (state?.status === "break")
      void audio.current
        ?.play()
        .catch(() =>
          setAudioError(
            "Audio was blocked. Enable autoplay in OBS or press Play music in control.",
          ),
        );
    else {
      audio.current?.pause();
      setAudioError("");
    }
  }, [state?.status]);
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
  const round = state.round;
  const countdown =
    state.status === "break"
      ? state.breakUntil
      : state.status === "results"
        ? state.resultUntil
        : state.collectionDeadline;
  return (
    <main className={control ? "host" : "overlay"}>
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
              <b>{countdown ? clock(countdown - now) : ""}</b>
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
              RECONNECTING {clock(state.obsReconnectDeadline - now)}
            </span>
          )}
          {state.quota && (
            <span className="quota">
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
        <section className="break-screen">
          <iframe
            title="Pixel eye break visual"
            src={`${previewOrigin}/break`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
          />
          <div className="break-label">
            <h2>{clock((state.breakUntil ?? now) - now)}</h2>
            {audioError && <p className="error">{audioError}</p>}
          </div>
          <audio ref={audio} src="/media/break.mp3" autoPlay loop />
        </section>
      ) : (
        <>
          {!control && round?.task.text && (
            <div className="overlay-prompt" aria-label="Current prompt">
              <p>{round.task.text}</p>
            </div>
          )}
          <div className={`arena ${state.agents?.length === 1 ? "solo" : ""}`}>
            {(state.agents ?? (["cursor", "codex"] as const)).map((agent) => (
              <AgentPanel key={agent} agent={agent} state={state} now={now} />
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
          <div className="control-heading">
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
                ["running", "collecting", "results", "break"].includes(
                  state.status,
                )
              }
              onClick={() => action("start")}
            >
              Start
            </button>
            <button
              disabled={working || ["paused", "stopped"].includes(state.status)}
              onClick={() => action("pause")}
            >
              Pause
            </button>
            <button
              disabled={working || state.status !== "paused"}
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
                          working || (!chatYoutube && !chatTwitch && !chatKick)
                        }
                        onClick={() => void pickStop("chat-after")}
                      >
                        After this round
                      </button>
                      <button
                        disabled={
                          working || (!chatYoutube && !chatTwitch && !chatKick)
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
                    working || !["paused", "collecting"].includes(state.status)
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
            {state.status === "break" && (
              <button
                onClick={() =>
                  void audio.current
                    ?.play()
                    .catch(() =>
                      setAudioError("Could not play the configured music"),
                    )
                }
              >
                Music
              </button>
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
  lane,
  rows,
}: {
  agent: Agent;
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
        <img src={agent === "cursor" ? cursorLogo : codexLogo} alt="" />
        {laneLabel[lane]}
      </span>
      <ul ref={log}>
        {rows.map((row) => (
          <li key={row.id} className={lane === "terminal" ? "command-line" : undefined}>
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
function AgentPanel({
  agent,
  state,
  now,
}: {
  agent: Agent;
  state: ShowState;
  now: number;
}) {
  const attempt = state.round?.attempts[agent];
  const model = attempt?.model ?? state.models?.[agent];
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
  const elapsed = attempt?.startedAt
    ? (attempt.endedAt ?? now) - attempt.startedAt
    : 0;
  // Group consecutive real Cursor deltas to keep character streaming readable.
  const lines: Activity[] = [];
  for (const event of events) {
    const last = lines.at(-1);
    if (event.append && event.kind === "message" && last?.kind === "message")
      last.text += event.text;
    else lines.push({ ...event });
  }
  return (
    <section className={`agent-panel ${agent}`}>
      <div className="agent-header">
        <div className="agent-icon">
          <img
            src={agent === "codex" ? codexLogo : cursorLogo}
            alt={agent === "codex" ? "Codex" : "Cursor"}
          />
        </div>
        <div>
          <h2>{agent === "codex" ? "Codex" : "Cursor"}</h2>
          {model && <p>{model}</p>}
        </div>
        <div className="agent-state" aria-label={attempt?.status ?? "idle"}>
          <span
            className={`dot ${attempt?.status === "running" ? "online" : ""}`}
          />
        </div>
        <time>{clock(elapsed)}</time>
      </div>
      <div className="agent-content">
        {showIntro ? (
          <div className="empty-state model-intro">
            <img
              className="empty-logo"
              src={agent === "codex" ? codexLogo : cursorLogo}
              alt=""
            />
            <h3>{agent === "codex" ? "Codex" : "Cursor"}</h3>
            {model && <p>{model}</p>}
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
            <p>{attempt?.error ?? ""}</p>
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
                <img
                  className="empty-logo"
                  src={agent === "codex" ? botLogo : cursorLogo}
                  alt=""
                />
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

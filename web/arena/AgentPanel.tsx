// One agent's arena panel: header, live transcript, HTML result or failure card.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { sessionCli, sessionLabel } from "../../shared/types.js";
import type { Activity, SessionId, ShowState } from "../../shared/types.js";
import { defaultVisibility } from "../../shared/settings.js";
import { SafeMarkdown } from "../markdown.js";
import codexLogo from "../../assets/codex/codex.svg";
import botLogo from "../../assets/chatgpt/chatgpt-icon.svg";
import cursorLogo from "../../assets/cursor/Cube/SVG/CUBE_2D_DARK.svg";
import { attemptFailed } from "./arena-status.js";
import { AttemptTimer } from "./timers.js";

// SafeMarkdown is memoised, so a parent re-render only re-parses changed text.
function MarkdownText({ children }: { children: string }) {
  return (
    <div className="markdown">
      <SafeMarkdown text={children} />
    </div>
  );
}
export function AgentPanel({
  agent,
  state,
  host,
}: {
  agent: SessionId;
  state: ShowState;
  // The private host view always shows full detail and never the idle intro.
  host: boolean;
}) {
  const attempt = state.round?.attempts[agent];
  const cli = sessionCli(state, agent);
  const model = attempt ? sessionLabel(attempt) : state.models?.[agent];
  // Visibility affects public presentation only; host inspection keeps the full view.
  const visibility = host
    ? defaultVisibility
    : (state.quickSettings?.visibility[agent] ?? defaultVisibility);
  const cliLabel = `${cli === "codex" ? "Codex" : "Cursor"} ${(state.agents?.indexOf(agent) ?? 0) === 0 ? "Left" : "Right"}`;
  const showIntro = !host && !state.round;
  const events = useMemo(
    () => state.events.filter((e) => e.agent === agent && !e.lane),
    [state.events, agent],
  );
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
  const textSize = useMemo(
    () => events.reduce((n, e) => n + e.text.length, 0),
    [events],
  );
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
  const lines = useMemo(() => {
    const grouped: Activity[] = [];
    for (const event of events) {
      const last = grouped.at(-1);
      if (event.append && event.kind === "message" && last?.kind === "message")
        last.text += event.text;
      else grouped.push({ ...event });
    }
    return grouped;
  }, [events]);
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
        ) : attemptFailed(attempt) || failed ? (
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

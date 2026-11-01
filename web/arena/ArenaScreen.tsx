// The arena layout shared by the host control page and the public arena overlay.
import React, { Suspense, useEffect, useState } from "react";
import type { Round, ShowState } from "../../shared/types.js";
import { BreakScreen } from "../break-screen.js";
import { RehearsalCheck } from "../host-screens.js";
import { GoalStrip } from "../presentation-controls.js";
import { AgentPanel } from "./AgentPanel.js";
import { ArenaHostControls } from "./ArenaHostControls.js";
import { phaseDeadline, phaseLabel } from "./arena-status.js";
import { Countdown } from "./timers.js";
import type { ArenaControls } from "./use-arena-controls.js";

// A new round's prompt pops over the public overlay for a few seconds.
export function usePromptPop(round?: Round) {
  const roundId = round?.id;
  const roundTask = round?.task.text;
  const [pop, setPop] = useState(false);
  useEffect(() => {
    if (roundTask) setPop(true);
  }, [roundId, roundTask]);
  useEffect(() => {
    if (!pop) return;
    const t = setTimeout(() => setPop(false), 4500);
    return () => clearTimeout(t);
  }, [pop]);
  return pop;
}

export function ArenaScreen({
  state,
  connected,
  host,
  token,
  controls,
  pop,
}: {
  state: ShowState;
  connected: boolean;
  // The /control host view; otherwise this is the public arena overlay.
  host: boolean;
  token: string;
  controls: ArenaControls;
  pop: boolean;
}) {
  const round = state.round;
  const countdown = phaseDeadline(state);
  return (
    <main className={host ? "host" : "overlay"}>
      {host ? (
        // The welcome route returns earlier, so the arena nav never held BreakControl.
        <nav className="host-top-tools" aria-label="Show controls" />
      ) : (
        <GoalStrip value={state.presentation} />
      )}
      {host && (
        <Suspense fallback={null}>
          <RehearsalCheck
            token={token}
            context="arena"
            revision={state.quickSettings?.revision}
          />
        </Suspense>
      )}
      {host && (
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
              {phaseLabel(state)}{" "}
              <b>{countdown ? <Countdown until={countdown} /> : ""}</b>
            </span>
          </div>
        </section>
      )}
      {host && (
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
      {!host && state.prepared?.text && (
        <footer className="next-strip">
          <span>{state.prepared.text}</span>
        </footer>
      )}
      {state.status === "break" ? (
        <BreakScreen state={state} host={host} />
      ) : (
        <>
          {!host && round?.task.text && (
            <div className="overlay-prompt" aria-label="Current prompt">
              <p>{round.task.text}</p>
            </div>
          )}
          <div className={`arena ${state.agents?.length === 1 ? "solo" : ""}`}>
            {(state.agents ?? (["cursor", "codex"] as const)).map((agent) => (
              <AgentPanel key={agent} agent={agent} state={state} host={host} />
            ))}
            {!host && !state.round && state.agents?.length !== 1 && (
              <div className="versus">VS</div>
            )}
          </div>
        </>
      )}
      {!host && pop && round?.task.text && (
        <div className="prompt-pop">
          <div>
            <span>ROUND {String(round.id).padStart(2, "0")}</span>
            <h2>{round.task.text}</h2>
            {round.task.author && <p>{round.task.author}</p>}
          </div>
        </div>
      )}
      {host && <ArenaHostControls state={state} token={token} controls={controls} />}
    </main>
  );
}

// The arena host's control section: show actions, stop choices, rehearsal prompt,
// CLI boards, connection checks and the candidate queue.
import React from "react";
import type { ShowState } from "../../shared/types.js";
import { allowedActions } from "./arena-status.js";
import { CliBoards } from "./CliBoards.js";
import { ChatHistory } from "../chats/ChatHistory.js";
import { chatPlatforms, type ArenaControls } from "./use-arena-controls.js";

function StopMenu({
  state,
  controls,
}: {
  state: ShowState;
  controls: ArenaControls;
}) {
  const { working, stopPanel, toggleStop, toggleStopChoice, platforms, pickStop } = controls;
  const open = stopPanel !== "closed";
  // Chat handover exists only for playlists or when the server asks the host to choose.
  const chatAllowed = !!(state.playlistTotal || state.awaitingHostChoice);
  const noPlatform = platforms.size === 0;
  return (
    <>
      <button
        className={open ? "danger toggle-on" : "danger"}
        disabled={working || !allowedActions(state).stop}
        aria-expanded={open}
        onClick={toggleStop}
      >
        Stop
      </button>
      {open && state.status !== "stopped" && (
        <>
          {chatAllowed && (
            <button
              className={stopPanel === "chat" ? "toggle-on" : ""}
              aria-expanded={stopPanel === "chat"}
              disabled={working}
              onClick={() => toggleStopChoice("chat")}
            >
              Chat
            </button>
          )}
          <button
            className={stopPanel === "end" ? "danger toggle-on" : "danger"}
            aria-expanded={stopPanel === "end"}
            disabled={working}
            onClick={() => toggleStopChoice("end")}
          >
            End
          </button>
          {stopPanel === "chat" && chatAllowed && (
            <>
              {chatPlatforms.map(([id, label]) => (
                <label key={id} className="stop-platform">
                  <input
                    type="checkbox"
                    checked={platforms.has(id)}
                    onChange={(e) => controls.togglePlatform(id, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
              <button
                disabled={working || noPlatform}
                onClick={() => void pickStop("chat-after")}
              >
                After this round
              </button>
              <button
                disabled={working || noPlatform}
                onClick={() => void pickStop("chat-now")}
              >
                Now
              </button>
            </>
          )}
          {stopPanel === "end" && (
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
    </>
  );
}

export function ArenaHostControls({
  state,
  token,
  controls,
}: {
  state: ShowState;
  token: string;
  controls: ArenaControls;
}) {
  const { working, error, action, suggestOpen, cliBoardsOpen } = controls;
  const allowed = allowedActions(state);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  // Rehearsal tools apply to hand-run rounds, not playlists.
  const rehearsal = state.mode === "rehearsal" && !state.playlistTotal;
  return (
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
        <a href="/chat" target="_blank" rel="noreferrer">
          chat ↗
        </a>
        <a href="/chats/prompts" target="_blank" rel="noreferrer">
          !prompts ↗
        </a>
        <button
          type="button"
          className={`cli-toggle${historyOpen ? " toggle-on" : ""}`}
          aria-label="Chat history"
          title="Chat history"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          🕘
        </button>
      </div>
      {historyOpen && (
        <ChatHistory
          token={token}
          arenaOpen={state.experience === "arena" && !["stopped", "break"].includes(state.status)}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      <div className="control-toolbar">
        <div className="buttons">
          <button
            disabled={working || !token || !allowed.start}
            onClick={() => action("start")}
          >
            Start
          </button>
          <button
            disabled={working || !allowed.pause}
            onClick={() => action("pause")}
          >
            Pause
          </button>
          <button
            disabled={working || !allowed.resume}
            onClick={() => action("resume")}
          >
            Resume
          </button>
          <button
            disabled={working || !allowed.skip}
            onClick={() => action("skip")}
          >
            Skip
          </button>
          <StopMenu state={state} controls={controls} />
          {rehearsal && (
            <>
              <button
                disabled={working || !allowed.rehearsalTask}
                onClick={() => action("rehearsal-task")}
              >
                Task
              </button>
              <button
                disabled={working || !allowed.confirmRehearsal}
                onClick={() => action("confirm-rehearsal")}
              >
                Confirm
              </button>
              <button
                type="button"
                className={suggestOpen ? "toggle-on" : ""}
                aria-expanded={suggestOpen}
                onClick={() => controls.setSuggestOpen((open) => !open)}
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
          onClick={() => controls.setCliBoardsOpen((open) => !open)}
        >
          {cliBoardsOpen ? "Hide CLI" : "CLI"}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {rehearsal && suggestOpen && (
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
            value={controls.suggestion}
            onChange={(e) => controls.setSuggestion(e.target.value)}
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
  );
}

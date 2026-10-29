import React from "react";
import type { OverlayView, SessionView } from "../../shared/sessions.js";
import { Timeline } from "../welcome/Timeline.js";
import "./overlays.css";

// Every tile pages only its own conversation through the same named output.
export function OverlayScreen({ view }: { view: OverlayView | undefined }) {
  if (!view?.published)
    return (
      <main className="overlay-grid-empty">No sessions on this overlay</main>
    );
  const columns =
    view.frames.length <= 3
      ? Math.max(1, view.frames.length)
      : view.frames.length <= 4
        ? 2
        : view.frames.length <= 6
          ? 3
          : 4;
  return (
    <main className="overlay-grid-screen">
      {(view.error || view.omittedRunning > 0) && (
        <div className="overlay-grid-notice">
          {view.error}
          {view.omittedRunning > 0 &&
            ` · ${view.omittedRunning} running session(s) omitted by the eight-session limit or rehearsal requirements.`}
        </div>
      )}
      {!view.frames.length ? (
        <div className="overlay-grid-empty">
          Waiting for selected or verified running sessions
        </div>
      ) : (
        <div
          className="overlay-grid"
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(0,1fr))`,
            gridTemplateRows: `repeat(${Math.ceil(view.frames.length / columns)},minmax(0,1fr))`,
          }}
        >
          {view.frames.map((frame) => (
            <section className="overlay-tile" key={frame.conversation.id}>
              <Timeline
                key={view.id + ":" + frame.conversation.id}
                view={frame}
                older={async (before) => {
                  const response = await fetch(
                    "/api/public-session?" +
                      new URLSearchParams({
                        overlay: view.id,
                        id: frame.conversation.id,
                        before,
                      }),
                  );
                  const page = await response.json();
                  if (!response.ok)
                    throw new Error(page.error ?? "History unavailable");
                  return page as SessionView;
                }}
              />
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

import { playExclusive } from "../audio-owner.js";
import React, { useEffect, useId, useRef, useState } from "react";
import { hostRequest } from "../settings/api.js";
import { useHostAction } from "../use-host-action.js";
const choices = [
  ["session", "I checked the correct session and its current public content."],
  ["readable", "I can read the preview at my target OBS output dimensions."],
  ["visible", "I can see the intended overlay in OBS Program output."],
  ["audible", "I heard the break music through the intended OBS audio path."],
] as const;

// Human confirmation covers what a source URL or file-existence probe cannot prove.
// The check lives in the top nav as a compact button; its panel is a popover.
export function RehearsalCheck({
  token,
  context,
  revision,
}: {
  token: string;
  context: string;
  revision?: number;
}) {
  const [refresh, setRefresh] = useState(0);
  const [review, setReview] = useState<{
    key: string;
    confirmed: boolean;
    hidden: boolean;
  }>();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const { busy, error, setError, run } = useHostAction();
  const audio = useRef<HTMLAudioElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const alive = useRef(true);
  const [music, setMusic] = useState("/media/break.mp3");
  const shown = useRef<{ scope: string; review?: typeof review }>({
    scope: "",
  });
  shown.current.review = review;
  useEffect(() => {
    alive.current = true;
    const element = audio.current;
    return () => {
      alive.current = false;
      element?.pause();
    };
  }, []);
  useEffect(() => {
    if (!token) return;
    let closed = false;
    const element = audio.current;
    // A new token, context or Refresh click starts a fresh review as before; a
    // settings revision bump only re-reads it, keeping state when nothing changed.
    const scope = JSON.stringify([token, context, refresh]);
    if (shown.current.scope !== scope) {
      shown.current.scope = scope;
      setReview(undefined);
      setChecked({});
    }
    setError("");
    void Promise.all([
      hostRequest<{ key: string; confirmed: boolean; hidden: boolean }>(
        token,
        `/api/rehearsal?context=${encodeURIComponent(context)}`,
      ),
      hostRequest<{ value: { media: { audio?: string } } }>(
        token,
        "/api/settings",
      ),
    ])
      .then(([value, settings]) => {
        if (!closed) {
          const old = shown.current.review;
          if (
            !old ||
            old.key !== value.key ||
            old.confirmed !== value.confirmed ||
            old.hidden !== value.hidden
          ) {
            setReview(value);
            // Ticks made while a fresh review loads are kept, as before.
            if (old) setChecked({});
          }
          setMusic(
            settings.value.media.audio
              ? `/media/break/${settings.value.media.audio}`
              : "/media/break.mp3",
          );
        }
      })
      .catch((e) => {
        if (!closed) setError(e.message);
      });
    return () => {
      closed = true;
      element?.pause();
    };
  }, [token, context, revision, refresh]);
  async function testAudio() {
    setError("");
    if (!audio.current) return;
    try {
      await playExclusive(audio.current);
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "Audio playback failed");
    }
  }
  return (
    <section className="rehearsal-check">
      <button
        type="button"
        className="host-tool-button"
        disabled={!token}
        popoverTarget={panelId}
        title="Confirm the pre-live checks in OBS before going live"
      >
        <span className="rehearsal-plus" aria-hidden="true">
          +
        </span>
        Pre-live check
        {review?.confirmed ? " · confirmed" : " before live"}
      </button>
      <div
        id={panelId}
        ref={panel}
        popover="auto"
        role="dialog"
        aria-label="Pre-live check"
        className="host-popover rehearsal-popover"
      >
        <header className="host-popover-heading">
          <div>
            <h2>Pre-live check</h2>
            <p>{review?.confirmed ? "Confirmed" : "before live"}</p>
          </div>
          <button
            type="button"
            popoverTarget={panelId}
            popoverTargetAction="hide"
            aria-label="Close pre-live check"
          >
            ×
          </button>
        </header>
        <p>
          Confirm against OBS Program output — the app can't check this for you.
        </p>
        <div className="rehearsal-actions">
          <button type="button" onClick={() => setRefresh((n) => n + 1)}>
            Refresh
          </button>
          <a href="/overlay" target="_blank" rel="noreferrer">
            Open Main preview ↗
          </a>
          <button type="button" onClick={() => void testAudio()}>
            Test audio
          </button>
          <button
            type="button"
            onClick={() => {
              audio.current?.pause();
            }}
          >
            Stop audio
          </button>
        </div>
        <p className="host-panel-note">
          For a named output, use its Preview link at its target dimensions.
        </p>
        <p className="host-panel-note">
          Local playback doesn't prove OBS captures audio. Stop this test before
          checking OBS — it uses a separate browser profile.
        </p>
        <div className="rehearsal-choices">
          {choices.map(([id, label]) => (
            <label key={id}>
              <input
                type="checkbox"
                checked={!!checked[id]}
                onChange={(e) =>
                  setChecked((old) => ({ ...old, [id]: e.target.checked }))
                }
              />
              {label}
            </label>
          ))}
        </div>
        <div className="rehearsal-actions">
          <button
            type="button"
            className="host-button-primary"
            disabled={!review || busy || !choices.every(([id]) => checked[id])}
            onClick={() =>
              void run(async () => {
                await hostRequest(token, "/api/rehearsal", {
                  context,
                  key: review!.key,
                  session: true,
                  readable: true,
                  visible: true,
                  audible: true,
                });
                setReview((old) => old && { ...old, confirmed: true });
                panel.current?.hidePopover();
              }, "Confirmation failed")
            }
          >
            Confirm checks
          </button>
        </div>
        {error && (
          <p role="alert" className="host-control-error">
            {error}
          </p>
        )}
      </div>
      <audio
        ref={audio}
        src={music}
        preload="none"
        onError={() => {
          setError("Break audio could not play. Check the selected file.");
        }}
      />
    </section>
  );
}

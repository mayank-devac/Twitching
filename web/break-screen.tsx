import React, { useEffect, useRef, useState } from "react";
import type { ShowState } from "../shared/types.js";

// Only an overlay owns autoplay; host tabs show the timer without duplicating music.
export function BreakScreen({
  state,
  now,
  previewOrigin,
  host,
}: {
  state: ShowState;
  now: number;
  previewOrigin: string;
  host: boolean;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [blocked, setBlocked] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [musicFailed, setMusicFailed] = useState(false);
  const media = state.quickSettings?.media;
  useEffect(() => setImageFailed(false), [media?.visual]);
  useEffect(() => setMusicFailed(false), [media?.audio]);
  const music =
    media?.audio && !musicFailed
      ? `/media/break/${media.audio}`
      : "/media/break.mp3";
  // Changing a selected track during a break replaces it without keeping the old audio alive.
  useEffect(() => {
    if (!host)
      void audio.current
        ?.play()
        .then(() => setBlocked(false))
        .catch(() => setBlocked(true));
  }, [music, host]);
  const seconds = Math.max(
    0,
    Math.ceil(((state.breakUntil ?? now) - now) / 1000),
  );
  return (
    <section className="break-screen">
      {media?.visual && !imageFailed ? (
        <img
          className="break-upload"
          alt="Break visual"
          src={`/media/break/${media.visual}`}
          onError={() => setImageFailed(true)}
        />
      ) : (
        <iframe
          title="Break visual"
          src={`${previewOrigin}/break`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
        />
      )}
      <div className="break-label">
        <h2>
          {String(Math.floor(seconds / 60)).padStart(2, "0")}:
          {String(seconds % 60).padStart(2, "0")}
        </h2>
        <p>
          {state.breakKind === "manual"
            ? "Timed break · Resume after the timer ends"
            : "Waiting for quota to recover"}
        </p>
        {blocked && !host && (
          <>
            <p className="error">
              Music was blocked. Enable autoplay in OBS or press Play music
              here.
            </p>
            <button
              onClick={() =>
                void audio.current
                  ?.play()
                  .then(() => setBlocked(false))
                  .catch(() => setBlocked(true))
              }
            >
              Play music
            </button>
          </>
        )}
        {musicFailed && (
          <p className="error">
            Selected music unavailable; using the original track.
          </p>
        )}
      </div>
      {!host && (
        <audio
          ref={audio}
          src={music}
          autoPlay
          loop
          onError={() => {
            setMusicFailed(true);
            setBlocked(true);
          }}
        />
      )}
    </section>
  );
}

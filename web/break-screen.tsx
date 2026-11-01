import { playExclusive } from "./audio-owner.js";
import React, { useEffect, useRef, useState } from "react";
import type { ShowState } from "../shared/types.js";
import { breakVisualObjectFit } from "../shared/settings.js";
import { useNow } from "./use-now.js";

// The overlay fills the output frame; host previews keep controls available and never autoplay.
export function BreakScreen({
  state,
  host,
}: {
  state: ShowState;
  host: boolean;
}) {
  // The countdown ticks here so the break clock doesn't re-render the parent tree.
  const now = useNow(250);
  const screen = useRef<HTMLElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [blocked, setBlocked] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [defaultMissing, setDefaultMissing] = useState(false);
  const [musicFailed, setMusicFailed] = useState(false);
  const media = state.quickSettings?.media;
  useEffect(() => {
    setImageFailed(false);
    setDefaultMissing(false);
  }, [media?.visual]);
  useEffect(() => setMusicFailed(false), [media?.audio]);
  const music =
    media?.audio && !musicFailed
      ? `/media/break/${media.audio}`
      : "/media/break.mp3";
  const custom = !!media?.visual && !imageFailed;
  const visual = custom
    ? `/media/break/${media!.visual}`
    : "/media/break-visual.gif";
  // Track changes replace the previous audio element source without another playback owner.
  useEffect(() => {
    const element = audio.current;
    if (!host && element)
      void playExclusive(element)
        .then(() => setBlocked(false))
        .catch(() => setBlocked(true));
    return () => { element?.pause(); };
  }, [music, host]);
  const seconds = state.breakUntil
    ? Math.max(0, Math.ceil((state.breakUntil - now) / 1000))
    : undefined;
  return (
    <section
      ref={screen}
      className={`break-screen ${host ? "break-host" : "break-overlay"}`}
      aria-label="Break screen"
    >
      {!defaultMissing && (
        <img
          className="break-upload"
          alt="Break visual"
          style={{
            objectFit: breakVisualObjectFit[media?.visualFit ?? "fit"],
          }}
          src={visual}
          onError={() =>
            custom ? setImageFailed(true) : setDefaultMissing(true)
          }
        />
      )}
      <div className="break-label">
        {seconds !== undefined ? (
          <time role="timer">
            {String(Math.floor(seconds / 60)).padStart(2, "0")}:
            {String(seconds % 60).padStart(2, "0")}
          </time>
        ) : (
          <span>Taking a break</span>
        )}
        {state.breakKind === "quota" && <span>Waiting for quota</span>}
        {host && (
          <button
            onClick={() => {
              if (!screen.current?.requestFullscreen) {
                setFullscreenError(true);
                return;
              }
              void screen.current
                .requestFullscreen()
                .catch(() => setFullscreenError(true));
            }}
          >
            Full screen
          </button>
        )}
        {blocked && !host && (
          <button
            onClick={() =>
              audio.current && void playExclusive(audio.current)
                .then(() => setBlocked(false))
                .catch(() => setBlocked(true))
            }
          >
            Play music
          </button>
        )}
        {fullscreenError && (
          <span className="error">Full screen unavailable</span>
        )}
        {defaultMissing && <span className="error">Break GIF unavailable</span>}
        {musicFailed && <span className="error">Using default music</span>}
      </div>
      {!host && (
        <audio
          ref={audio}
          src={music}
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

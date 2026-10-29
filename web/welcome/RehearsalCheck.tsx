import React, { useEffect, useRef, useState } from "react";
import { hostRequest } from "../settings/api.js";

const choices = [
  ["session", "I checked the correct session and its current public content."],
  ["readable", "I can read the preview at my target OBS output dimensions."],
  ["visible", "I can see the intended overlay in OBS Program output."],
  ["audible", "I heard the break music through the intended OBS audio path."],
] as const;

// Human confirmation covers what a source URL or file-existence probe cannot prove.
export function RehearsalCheck({ token, context, revision }: { token: string; context: string; revision?: number }) {
  const [refresh, setRefresh] = useState(0);
  const [review, setReview] = useState<{ key: string; confirmed: boolean; hidden: boolean }>();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const release = useRef<(() => void) | undefined>(undefined);
  const pending = useRef(false);
  const alive = useRef(true);
  const [music, setMusic] = useState("/media/break.mp3");
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; audio.current?.pause(); release.current?.(); };
  }, []);
  useEffect(() => {
    if (!token) return;
    let closed = false;
    setReview(undefined); setChecked({}); setError("");
    void Promise.all([
      hostRequest<{ key: string; confirmed: boolean; hidden: boolean }>(token, `/api/rehearsal?context=${encodeURIComponent(context)}`),
      hostRequest<{ value: { media: { audio?: string } } }>(token, "/api/settings"),
    ]).then(([value, settings]) => {
      if (!closed) { setReview(value); setMusic(settings.value.media.audio ? `/media/break/${settings.value.media.audio}` : "/media/break.mp3"); }
    }).catch((e) => { if (!closed) setError(e.message); });
    return () => { closed = true; audio.current?.pause(); release.current?.(); };
  }, [token, context, revision, refresh]);
  async function testAudio() {
    if (pending.current || release.current) return;
    setError("");
    if (!navigator.locks) { setError("This browser cannot reserve audio across tabs. Test break audio directly in OBS instead."); return; }
    pending.current = true;
    try {
      await navigator.locks.request("twitching-rehearsal-audio", { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("Another tab is testing audio. Stop it there first.");
        if (!alive.current || !audio.current) return;
        await new Promise<void>((resolve, reject) => {
          release.current = () => { release.current = undefined; resolve(); };
          void audio.current!.play().catch((e) => { release.current?.(); reject(e); });
        });
      });
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "Audio playback failed"); }
    finally { pending.current = false; }
  }
  return <details className="rehearsal-check"><summary>Short pre-live check{review?.confirmed ? " · host confirmed" : " · required before live"}</summary>
    <p>Check the actual OBS Program output. These are your confirmations; the app cannot measure readability, visibility or what you hear.</p>
    <button type="button" onClick={() => setRefresh((n) => n + 1)}>Refresh changed choices</button>
    <a href="/overlay" target="_blank" rel="noreferrer">Open Main preview ↗</a>
    <p>For a named output, use its Preview link in Overlays. Inspect each intended layout at its target dimensions.</p>
    <button type="button" onClick={() => void testAudio()}>Test audio in this tab</button>
    <button type="button" onClick={() => { audio.current?.pause(); release.current?.(); }}>Stop test audio</button>
    <audio ref={audio} src={music} preload="none" onEnded={() => release.current?.()} onPause={() => release.current?.()} onError={() => { release.current?.(); setError("Break audio could not play. Check the selected file."); }} />
    <p>The local test does not prove OBS captures audio. Confirm the intended OBS audio path separately; stop the test before opening a break preview.</p>
    {choices.map(([id, label]) => <label key={id}><input type="checkbox" checked={!!checked[id]} onChange={(e) => setChecked((old) => ({ ...old, [id]: e.target.checked }))} />{label}</label>)}
    <button type="button" disabled={!review || busy || !choices.every(([id]) => checked[id])} onClick={async () => {
      setBusy(true); setError("");
      try { await hostRequest(token, "/api/rehearsal", { context, key: review!.key, session: true, readable: true, visible: true, audible: true }); setReview((old) => old && { ...old, confirmed: true }); }
      catch (e) { setError(e instanceof Error ? e.message : "Confirmation failed"); }
      finally { setBusy(false); }
    }}>Confirm these checks</button>
    {error && <p role="alert">{error}</p>}
  </details>;
}

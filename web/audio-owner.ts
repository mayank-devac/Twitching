// Same-origin tabs share one audio lease; a closed tab automatically releases its lock.
const playing = new WeakMap<HTMLAudioElement, Promise<void>>();
export function playExclusive(audio: HTMLAudioElement): Promise<void> {
  const existing = playing.get(audio);
  if (existing) return existing;
  if (!navigator.locks) return Promise.reject(new Error("Audio needs a browser with Web Locks. Test directly in OBS."));
  const started = new Promise<void>((resolve, reject) => {
    void navigator.locks.request("twitching-audio", { ifAvailable: true }, async (lock) => {
      if (!audio.isConnected) { resolve(); return; }
      if (!lock) throw new Error("Another tab is playing break or test audio. Stop it there first.");
      await new Promise<void>((release) => {
        const done = () => {
          audio.removeEventListener("pause", done);
          audio.removeEventListener("ended", done);
          audio.removeEventListener("error", done);
          playing.delete(audio);
          release();
        };
        audio.addEventListener("pause", done);
        audio.addEventListener("ended", done);
        audio.addEventListener("error", done);
        void audio.play().then(resolve).catch((error) => { done(); reject(error); });
      });
    }).catch((error) => { playing.delete(audio); reject(error); });
  });
  playing.set(audio, started);
  return started;
}

// Watches a direct-preview iframe through the heartbeat the server injects into the page.
// A page that stops beating is reloaded once; if it stalls again the panel gives up on it.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type FrameHealth = "ok" | "slow" | "gave-up";
// The injected script beats every 500 ms; a gap this long means the page's main thread is stuck.
export const STALL_MS = 4000;
const CHECK_MS = 1000;

export function useFrameWatchdog(
  frame: RefObject<HTMLIFrameElement | null>,
  active: boolean,
  resetKey: string | undefined,
) {
  const [health, setHealth] = useState<FrameHealth>("ok");
  // Bumping this remounts the iframe, which discards a hung page.
  const [attempt, setAttempt] = useState(0);
  const lastBeat = useRef(0);
  const reloads = useRef(0);

  useEffect(() => {
    setHealth("ok");
    setAttempt(0);
    lastBeat.current = 0;
    reloads.current = 0;
  }, [resetKey]);

  useEffect(() => {
    if (!active) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { twitching?: string; long?: number } | null;
      if (data?.twitching !== "hb") return;
      lastBeat.current = Date.now();
      if (typeof data.long === "number") setHealth((now) => (now === "gave-up" ? now : "slow"));
    };
    window.addEventListener("message", onMessage);
    const timer = setInterval(() => {
      // Until the first beat the load timeout in AgentPanel decides; this only judges a page that was alive.
      if (!lastBeat.current || Date.now() - lastBeat.current < STALL_MS) return;
      lastBeat.current = 0;
      if (reloads.current < 1) {
        reloads.current++;
        setAttempt((n) => n + 1);
      } else setHealth("gave-up");
    }, CHECK_MS);
    return () => {
      window.removeEventListener("message", onMessage);
      clearInterval(timer);
    };
  }, [active, frame]);

  const reload = useCallback(() => {
    reloads.current = 0;
    lastBeat.current = 0;
    setHealth("ok");
    setAttempt((n) => n + 1);
  }, []);

  return { health, attempt, reload };
}

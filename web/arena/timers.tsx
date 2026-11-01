// Self-ticking clocks, so the 250ms tick re-renders only the time text, not the arena.
import React from "react";
import { useNow } from "../use-now.js";
import { clock } from "./arena-status.js";

export function Countdown({ until }: { until: number }) {
  const now = useNow(250);
  return <>{clock(until - now)}</>;
}

// Only the header timer ticks; the transcript below re-renders on state changes.
export function AttemptTimer({
  startedAt,
  endedAt,
}: {
  startedAt?: number;
  endedAt?: number;
}) {
  const now = useNow(250);
  const elapsed = startedAt ? (endedAt ?? now) - startedAt : 0;
  return <time>{clock(elapsed)}</time>;
}

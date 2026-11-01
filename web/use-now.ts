import { useEffect, useState } from "react";

// Only components that display a clock subscribe, so a tick re-renders the
// countdown text rather than the whole app tree.
export function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

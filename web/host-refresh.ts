// Keep one active fetch and one pending refresh, with a minimum start interval.
export function hostRefresh<T>(fetchValue: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void, interval = 750) {
  let generation = 0, active: AbortController | undefined, pending = false, closed = false, last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function pump() {
    if (closed || active || timer || !pending) return;
    const wait = Math.max(0, last + interval - Date.now());
    if (wait) { timer = setTimeout(() => { timer = undefined; pump(); }, wait); return; }
    pending = false;
    const version = generation;
    const request = active = new AbortController();
    last = Date.now();
    void fetchValue(request.signal).then((value) => {
      if (!closed && version === generation) apply(value);
    }).catch(() => { /* Live public updates remain usable; the next event can retry. */ }).finally(() => {
      if (active === request) active = undefined;
      pump();
    });
  }
  return {
    request() { pending = true; pump(); },
    invalidate() { generation++; pending = false; active?.abort(); clearTimeout(timer); timer = undefined; },
    close() { closed = true; generation++; active?.abort(); clearTimeout(timer); },
  };
}

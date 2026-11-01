// Keeps the live ShowState: the /events socket with backoff plus, on host pages,
// the authenticated host token and private host-state refreshes.
import { useEffect, useRef, useState } from "react";
import { parseServerMessage } from "../shared/server-message.js";
import type { ShowState } from "../shared/types.js";
import { hostRefresh } from "./host-refresh.js";
import { hostRequest } from "./settings/api.js";
import { applyHostState, applySnapshot, applyUpdate, hostContextKey } from "./show-state.js";

export function useShowState({
  host,
  overlay,
  setError,
}: {
  // Host pages authenticate and merge private lanes; public pages never do.
  host: boolean;
  // A named overlay output subscribes to its own frames.
  overlay?: string;
  setError(message: string): void;
}) {
  const [state, setState] = useState<ShowState>();
  const [connected, setConnected] = useState(false);
  const [csrf, setCsrf] = useState("");
  const csrfRef = useRef("");
  useEffect(() => {
    let closed = false;
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let delay = 1000;
    let context = "";
    const refresh = hostRefresh(
      (signal) =>
        hostRequest<ShowState>(csrfRef.current, "/api/host-state", undefined, "GET", { signal }),
      (hostState) => setState((current) => applyHostState(current, hostState)),
    );
    const loadHostState = () => refresh.request();
    const connect = () => {
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/events${overlay ? `?overlay=${encodeURIComponent(overlay)}` : ""}`,
      );
      ws.onopen = () => {
        setConnected(true);
        delay = 1000;
      };
      ws.onmessage = (e) => {
        try {
          // Malformed frames throw here and fall through to the error below.
          const message = parseServerMessage(e.data);
          const nextContext = hostContextKey(message.state);
          const changedContext = nextContext !== context;
          if (changedContext) {
            context = nextContext;
            refresh.invalidate();
          }
          if (message.type === "update") {
            setState((current) => {
              try {
                return applyUpdate(current, message, host, changedContext);
              } catch {
                ws.close();
                return current;
              }
            });
            if (host && csrfRef.current) void loadHostState();
          } else if (host && csrfRef.current) {
            setState((current) => applySnapshot(current, message.state, true, changedContext));
            void loadHostState();
          } else setState(applySnapshot(undefined, message.state, false, changedContext));
        } catch {
          setError("Invalid overlay update");
        }
      };
      ws.onclose = () => {
        refresh.invalidate();
        setConnected(false);
        if (!closed) {
          retry = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 10000);
        }
      };
      ws.onerror = () => ws.close();
    };
    connect();
    if (host)
      fetch("/api/host")
        .then((r) => r.json())
        .then((data) => {
          if (closed) return;
          refresh.invalidate();
          csrfRef.current = data.csrf;
          setCsrf(data.csrf);
          return loadHostState();
        })
        .catch(() => setError("Host controls unavailable"));
    return () => {
      closed = true;
      refresh.close();
      clearTimeout(retry);
      ws?.close();
    };
    // Route flags are fixed for the page's lifetime, so the socket opens once.
  }, []);
  return { state, connected, csrf };
}

import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";

// Owns the busy/error/notice state that every host form wraps around a hostRequest call.
export function useHostAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Resolves to fn's result, or to undefined once its error is shown. A form that
  // closes mid-request drops the late state updates instead of writing to nothing.
  const run = useCallback(
    async <T>(
      fn: () => Promise<T>,
      fallback: string,
      { keepNotice = false }: { keepNotice?: boolean } = {},
    ): Promise<T | undefined> => {
      setBusy(true);
      setError("");
      if (!keepNotice) setNotice("");
      try {
        return await fn();
      } catch (e) {
        if (mounted.current) setError(e instanceof Error ? e.message : fallback);
        return undefined;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [],
  );
  return { busy, error, notice, setBusy, setError, setNotice, run };
}

// Loads host data whenever the token (or `deps`) change, once a token exists. A load
// superseded by a newer one, or finishing after unmount, never applies.
export function useHostQuery<T>(
  token: string,
  load: () => Promise<T>,
  apply: (value: T) => void,
  fail: (error: unknown) => void,
  deps: DependencyList = [],
) {
  const handlers = useRef({ load, apply, fail });
  handlers.current = { load, apply, fail };
  useEffect(() => {
    if (!token) return;
    let closed = false;
    handlers.current.load().then(
      (value) => {
        if (!closed) handlers.current.apply(value);
      },
      (error: unknown) => {
        if (!closed) handlers.current.fail(error);
      },
    );
    return () => {
      closed = true;
    };
  }, [token, ...deps]);
}

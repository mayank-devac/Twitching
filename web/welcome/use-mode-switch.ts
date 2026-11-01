import { useEffect, useState } from "react";
import { hostRequest } from "../settings/api.js";
import type { ModeHandoverState } from "./ModeHandover.js";

export type WelcomePath = "existing" | "new" | "arena";

// Owns the existing/new/arena tab plus the arena handover. Tabs change only after the
// server has transferred ownership of the arena.
export function useModeSwitch({
  token,
  arenaActive,
  setError,
  setNotice,
}: {
  token: string;
  arenaActive: boolean;
  setError: (message: string) => void;
  setNotice: (message: string) => void;
}) {
  // Reflect server ownership on entry; loading this page must never switch modes.
  const [path, setPath] = useState<WelcomePath>(arenaActive ? "arena" : "existing");
  const [handover, setHandover] = useState<ModeHandoverState>();
  const [failedMode, setFailedMode] = useState<WelcomePath>();

  async function switchPath(target: WelcomePath) {
    setFailedMode(target);
    if (target === "arena") {
      await hostRequest(token, "/api/sessions/action", { action: "arena" });
    } else {
      const result = await hostRequest<{ status: "ready" | "choice" | "waiting" }>(
        token, "/api/sessions/action", { action: "session-mode" });
      if (result.status !== "ready") {
        setPath("arena");
        setHandover({ target, ...(result.status === "waiting" ? { choice: "wait" as const } : {}) });
        setFailedMode(undefined);
        return false;
      }
    }
    setPath(target);
    setFailedMode(undefined);
    return true;
  }

  // Poll only during an explicit handover, one request at a time; never launch a model.
  useEffect(() => {
    if (!handover?.choice) return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const result = await hostRequest<{ status: string }>(token, "/api/sessions/action", {
          action: "session-mode", choice: handover.choice,
        });
        if (closed) return;
        if (result.status === "ready") {
          setPath(handover.target);
          setHandover(undefined);
          setNotice("Arena stopped. You can now continue with your session. OBS was left running.");
        } else timer = setTimeout(() => void check(), 1000);
      } catch (e) {
        if (!closed) {
          setError(e instanceof Error ? e.message : "Mode switch failed");
          setFailedMode(handover.target);
          setHandover(undefined);
        }
      }
    };
    void check();
    return () => { closed = true; clearTimeout(timer); };
  }, [handover, token]);

  return { path, setPath, handover, setHandover, failedMode, setFailedMode, switchPath };
}

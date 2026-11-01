// Host toolbar state for the arena: actions, the stop panel, chat platforms and the
// rehearsal prompt. App owns it so it survives switching away from the arena layout.
import { useEffect, useState } from "react";
import type { ShowState } from "../../shared/types.js";
import {
  CHAT_PLATFORMS,
  chatPlatformLabels,
  type ChatPlatform,
} from "../../shared/settings.js";
import { hostRequest } from "../settings/api.js";
import type { useHostAction } from "../use-host-action.js";

// Only one stop sub-panel is open at a time; "menu" shows just its Chat/End choices.
export type StopPanel = "closed" | "menu" | "chat" | "end";
export type { ChatPlatform };
export const chatPlatforms = CHAT_PLATFORMS.map(
  (id) => [id, chatPlatformLabels[id]] as const,
);

export function useArenaControls(
  state: ShowState | undefined,
  token: string,
  { busy, error, run }: ReturnType<typeof useHostAction>,
) {
  const [suggestion, setSuggestion] = useState(
    "!prompt Create a colourful bouncing ball animation with gravity controls",
  );
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [cliBoardsOpen, setCliBoardsOpen] = useState(true);
  const [stopPanel, setStopPanel] = useState<StopPanel>("closed");
  const [platforms, setPlatforms] = useState<ReadonlySet<ChatPlatform>>(() => new Set());
  useEffect(() => {
    // A playlist end asks the host to choose; an already open sub-panel stays open.
    if (state?.awaitingHostChoice) setStopPanel((panel) => (panel === "closed" ? "menu" : panel));
    if (state?.status === "stopped") setStopPanel("closed");
  }, [state?.awaitingHostChoice, state?.status]);
  // Resolves true once the server accepted the action; failures show in `error`.
  const action = (name: string, extra: Record<string, unknown> = {}) =>
    run(async () => {
      await hostRequest(token, "/api/action", { action: name, text: suggestion, ...extra }, "POST", {
        error: "Action failed",
      });
      return true;
    }, "Action failed");
  async function pickStop(choice: string) {
    const flags = Object.fromEntries(chatPlatforms.map(([id]) => [id, platforms.has(id)]));
    if (await action("stop-choice", { choice, ...flags })) setStopPanel("closed");
  }
  function togglePlatform(id: ChatPlatform, on: boolean) {
    setPlatforms((old) => {
      const next = new Set(old);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  // Stop opens or closes the whole panel; Chat and End swap with each other, and
  // pressing the open one folds back to the menu.
  const toggleStop = () => setStopPanel((open) => (open === "closed" ? "menu" : "closed"));
  const toggleStopChoice = (panel: "chat" | "end") =>
    setStopPanel((open) => (open === panel ? "menu" : panel));
  return {
    working: busy,
    error,
    suggestion,
    setSuggestion,
    suggestOpen,
    setSuggestOpen,
    cliBoardsOpen,
    setCliBoardsOpen,
    stopPanel,
    toggleStop,
    toggleStopChoice,
    platforms,
    togglePlatform,
    action,
    pickStop,
  };
}
export type ArenaControls = ReturnType<typeof useArenaControls>;

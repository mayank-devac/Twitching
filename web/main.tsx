import {
  PresentationControls,
  GoalStrip,
  usePrivacyShortcuts,
} from "./presentation-controls.js";
// Host CSS stays eager, in its original position, so the cascade order against
// welcome/overlay/style sheets is unchanged now that the host screens load lazily.
// break-control.css also styles the arena host's .host-top-tools nav.
import "./settings/settings.css";
import "./break-control.css";
import { OverlayScreen } from "./overlays/OverlayScreen.js";
import { BreakScreen } from "./break-screen.js";
import { ChatFeedPage } from "./chats/ChatFeedPage.js";
import { ChatHistory } from "./chats/ChatHistory.js";
import React, { Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./markdown.css";
import "./style.css";
import { useHostAction } from "./use-host-action.js";
import { useShowState } from "./use-show-state.js";
import { preloadHostScreens, QuickSettings, Welcome } from "./host-screens.js";
import { ArenaScreen, usePromptPop } from "./arena/ArenaScreen.js";
import { useArenaControls } from "./arena/use-arena-controls.js";
// Routes are fixed for the page's lifetime; components receive them as props.
// The settings tab shares host authentication but renders its own focused page.
const settingsPage = location.pathname === "/control/settings";
const welcomePage = location.pathname === "/control/welcome";
const namedOverlay = location.pathname.startsWith("/overlay/");
const outputId = namedOverlay
  ? location.pathname.slice("/overlay/".length)
  : "default";
const chatsPage = location.pathname === "/control/chats";
const control = location.pathname === "/control" || settingsPage || welcomePage || chatsPage;
if (control) preloadHostScreens(settingsPage);
function App() {
  // One host error covers socket/bootstrap failures, privacy shortcuts and arena actions.
  const hostAction = useHostAction();
  const { error, setError } = hostAction;
  const { state, connected, csrf } = useShowState({
    host: control,
    overlay: namedOverlay ? outputId : undefined,
    setError,
  });
  usePrivacyShortcuts(control ? csrf : "", setError);
  // Kept in App so toolbar and pop state survive switching away from the arena layout.
  const arenaControls = useArenaControls(state, csrf, hostAction);
  const pop = usePromptPop(state?.round);
  if (!state)
    return (
      <main className="connecting">
        <span className="wordmark">
          PROMPT<span>ARENA</span>
        </span>
        <p>Connecting to the local controller…</p>
        <p>OBS refreshes reconnect to the same round.</p>
      </main>
    );
  // Host bootstrap and privacy-shortcut failures land in the shared host error, which
  // the arena layout renders inline; the settings and welcome routes need it shown too.
  const hostError = error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
  // The chat filter page opened in a new tab from the chat history drawer.
  if (chatsPage)
    return (
      <>
        {hostError}
        <ChatHistory
          page
          token={csrf}
          arenaOpen={state.experience === "arena" && !["stopped", "break"].includes(state.status)}
        />
      </>
    );
  // A normal route keeps Quick Settings separate from the broadcast layout.
  if (settingsPage)
    return (
      <>
        {hostError}
        <Suspense fallback={null}>
          <QuickSettings state={state} token={csrf} connected={connected} />
        </Suspense>
      </>
    );
  if (welcomePage || (control && state.experience !== "arena"))
    return (
      <>
        {hostError}
        <Suspense fallback={null}>
          <Welcome
            token={csrf}
            arenaActive={state.experience === "arena"}
            publishedId={state.sharedSession?.conversation.id}
            breakControl={welcomePage}
            hostControls={
              <PresentationControls state={state} token={csrf} shortcutsOnly />
            }
          />
        </Suspense>
      </>
    );
  if (!control && (state.presentation?.hidden || !connected))
    return <main className="privacy-screen">Back shortly</main>;
  if (!control && state.presentation?.breakActive)
    return <BreakScreen state={state} host={false} />;
  if (
    !control &&
    (namedOverlay || (state.experience && state.experience !== "arena"))
  )
    return (
      <div className="public-surface">
        <GoalStrip value={state.presentation} />
        <OverlayScreen view={state.sharedOverlay} />
      </div>
    );
  return (
    <ArenaScreen
      state={state}
      connected={connected}
      host={control}
      token={csrf}
      controls={arenaControls}
      pop={pop}
    />
  );
}
// The OBS chat page needs no show state or host token, so it skips the socket entirely.
createRoot(document.getElementById("root")!).render(
  location.pathname === "/chat" || location.pathname === "/chats/prompts" ? <ChatFeedPage /> : <App />,
);

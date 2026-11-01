// Host-only screens are split out so OBS overlay pages never download them.
import { lazy } from "react";

const loadWelcome = () => import("./welcome/Welcome.js");
const loadQuickSettings = () => import("./settings/QuickSettings.js");
const loadRehearsalCheck = () => import("./welcome/RehearsalCheck.js");

// Host routes start fetching at once, before the socket delivers the first state,
// so the lazy components are normally ready by the time they first render.
export function preloadHostScreens(settingsPage: boolean) {
  void (settingsPage ? loadQuickSettings() : loadWelcome()).catch(() => {});
  if (!settingsPage) void loadRehearsalCheck().catch(() => {});
}

export const Welcome = lazy(() => loadWelcome().then((m) => ({ default: m.Welcome })));
export const QuickSettings = lazy(() =>
  loadQuickSettings().then((m) => ({ default: m.QuickSettings })),
);
export const RehearsalCheck = lazy(() =>
  loadRehearsalCheck().then((m) => ({ default: m.RehearsalCheck })),
);

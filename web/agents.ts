// One place for each CLI's display name and logos; components never branch on CLI ids.
import { CLI_LABELS, type Agent } from "../shared/types.js";
import codexLogo from "../assets/codex/codex.svg";
import botLogo from "../assets/chatgpt/chatgpt-icon.svg";
import cursorLogo from "../assets/cursor/Cube/SVG/CUBE_2D_DARK.svg";
import claudeLogo from "../assets/claude/claude.svg";

const logos: Record<Agent, string> = {
  codex: codexLogo,
  cursor: cursorLogo,
  claude: claudeLogo,
};
// The empty transcript shows a model mark rather than the CLI mark for Codex.
const idleLogos: Record<Agent, string> = {
  codex: botLogo,
  cursor: cursorLogo,
  claude: claudeLogo,
};

// An unknown CLI (very old saved rounds) keeps the previous Cursor fallback.
export function cliName(cli: Agent | undefined) {
  return CLI_LABELS[cli ?? "cursor"];
}
export function cliLogo(cli: Agent | undefined) {
  return logos[cli ?? "cursor"];
}
export function cliIdleLogo(cli: Agent | undefined) {
  return idleLogos[cli ?? "cursor"];
}

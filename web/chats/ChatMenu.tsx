import React, { useId } from "react";
import "./chats.css";

// One top-bar dropdown for everything chat: the host history and the two OBS pages.
// Uses the same native popover as the other host tools, so it closes on outside click.
export function ChatMenu() {
  const panel = useId();
  return (
    <>
      <button type="button" popoverTarget={panel} className="host-tool-button" aria-label="Chat history and OBS chat pages">
        Chats ▾
      </button>
      <div id={panel} popover="auto" role="menu" aria-label="Chats" className="host-popover chat-menu-popover">
        <a role="menuitem" href="/control/chats" target="_blank" rel="noreferrer">
          <b>Chat history ↗</b>
          <span>Filters, search and send as prompt (host only)</span>
        </a>
        <a role="menuitem" href="/chat" target="_blank" rel="noreferrer">
          <b>All chats ↗</b>
          <span>OBS browser source with every comment</span>
        </a>
        <a role="menuitem" href="/chats/prompts" target="_blank" rel="noreferrer">
          <b>!prompts ↗</b>
          <span>OBS browser source with !prompt comments only</span>
        </a>
        <p className="host-panel-note">The feed is off unless started with --chats. You can also turn it on in Chat history.</p>
      </div>
    </>
  );
}

import React, { useState } from "react";
import { CHAT_PLATFORMS, chatPlatformLabels, type ChatPlatform } from "../../shared/settings.js";
import { hostRequest } from "../settings/api.js";
import { useChatFeed, useFilteredEntries } from "./use-chat-feed.js";
import "./chats.css";

// The host's chat history. As a drawer it is a quick read-only list with "Send prompt";
// as a full page (opened by "Filters ↗" in a new tab) it adds every filter and setting.
export function ChatHistory({
  token,
  arenaOpen,
  onClose,
  page = false,
}: {
  token: string;
  arenaOpen: boolean;
  onClose?: () => void;
  page?: boolean;
}) {
  const [platforms, setPlatforms] = useState<Set<ChatPlatform>>(new Set(CHAT_PLATFORMS));
  const [prompts, setPrompts] = useState(false);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState<string>();
  const { entries, meta, selected, refresh } = useChatFeed({ prompts: page && prompts });
  const rows = useFilteredEntries(entries, selected, {
    platforms,
    selectedOnly: page && selectedOnly,
    search: page ? search : "",
  });
  const enabled = meta?.settings.enabled ?? false;
  const change = async (patch: object) => {
    try {
      await hostRequest(token, "/api/chat-feed/settings", patch);
      setError("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Not saved");
    }
  };
  const send = async (platform: ChatPlatform, id: string) => {
    try {
      await hostRequest(token, "/api/chat-feed/send", { platform, id });
      setSent(id);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Not sent");
    }
  };
  const hide = meta?.settings.hideBlocked ?? true;
  return (
    <aside className={`chat-history${page ? " page" : ""}`} aria-label="Chat history">
      <header>
        <h2>Chat history</h2>
        {!page && (
          <>
            <a href="/control/chats" target="_blank" rel="noreferrer" className="chat-history-open">
              Filters ↗
            </a>
            <button type="button" onClick={onClose} aria-label="Close chat history">×</button>
          </>
        )}
      </header>
      {page && (
        <div className="chat-history-filters">
          {CHAT_PLATFORMS.map((p) => {
            const status = meta?.platforms.find((s) => s.platform === p);
            return (
              <label key={p} title={status ? `${status.configured ? "key set" : "no key"} · ${status.status}` : ""}>
                <input
                  type="checkbox"
                  checked={platforms.has(p)}
                  onChange={(e) =>
                    setPlatforms((old) => {
                      const next = new Set(old);
                      if (e.target.checked) next.add(p);
                      else next.delete(p);
                      return next;
                    })
                  }
                />
                {chatPlatformLabels[p]}
                {status && <small className={status.status === "Connected" ? "live" : ""}> {status.configured ? status.status : "no key"}</small>}
              </label>
            );
          })}
          <label><input type="checkbox" checked={prompts} onChange={(e) => setPrompts(e.target.checked)} /> !prompt only</label>
          <label><input type="checkbox" checked={selectedOnly} onChange={(e) => setSelectedOnly(e.target.checked)} /> Jev selected</label>
          <label><input type="checkbox" checked={hide} disabled={!enabled} onChange={(e) => void change({ hideBlocked: e.target.checked })} /> Hide blocked words</label>
          {hide && (
            <label>
              <select value={meta?.settings.mode ?? "hide"} disabled={!enabled} onChange={(e) => void change({ mode: e.target.value })}>
                <option value="hide">Hide whole comment</option>
                <option value="mask">Mask the word</option>
              </select>
            </label>
          )}
          <input type="search" placeholder="Search author or text" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {meta && !enabled ? (
        <p className="empty">
          Chat feed is off, so no comments are kept or shown. Skip this if you read chat elsewhere.{" "}
          <button type="button" onClick={() => void change({ enabled: true })}>Turn on chat feed</button>
        </p>
      ) : (
        <ul>
          {rows.map((e) => {
            const isSelected = selected.has(e.id);
            return (
              <li key={`${e.platform}:${e.id}`} className={isSelected ? "selected" : ""}>
                <span className={`tag p-${e.platform}`}>{chatPlatformLabels[e.platform]}</span>
                <b>{e.author}</b>
                {e.prompt && <span className="tag">!prompt</span>}
                {isSelected && <span className="tag good">Jev selected</span>}
                <p>{e.text}</p>
                {arenaOpen && (
                  <button
                    type="button"
                    disabled={sent === e.id}
                    onClick={() => void send(e.platform, e.id)}
                  >
                    {sent === e.id ? "Sent" : "Send prompt"}
                  </button>
                )}
              </li>
            );
          })}
          {!rows.length && <li className="empty">No comments match.</li>}
        </ul>
      )}
      {enabled && (
        <button type="button" onClick={() => void change({ enabled: false })}>Turn off chat feed (clears history)</button>
      )}
    </aside>
  );
}

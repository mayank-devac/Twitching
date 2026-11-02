import React, { useEffect, useMemo, useRef } from "react";
import { CHAT_PLATFORMS, chatPlatformLabels, type ChatPlatform } from "../../shared/settings.js";
import { useChatFeed } from "./use-chat-feed.js";
import "./chats.css";

// /chat shows every comment, /chats/prompts only the !prompt ones. A plain list for an
// OBS browser source on a green (chroma key) background unless ?bg= says otherwise.
// Options: ?platforms=twitch,kick&status=1&max=14 (status=1 adds the platform key/connection chips)
export function ChatFeedPage() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const platforms = params.get("platforms")?.split(",").filter((p): p is ChatPlatform => (CHAT_PLATFORMS as readonly string[]).includes(p));
  // Host diagnostics (key and connection per platform) stay off stream unless ?status=1.
  const showStatus = params.get("status") === "1";
  const max = Math.min(Math.max(Number(params.get("max")) || 14, 1), 60);
  const bg = /^#?[0-9a-f]{3,8}$/i.test(params.get("bg") ?? "") ? `#${params.get("bg")!.replace("#", "")}` : "#00b140";
  const { entries, meta, offline } = useChatFeed({ platforms, prompts: location.pathname === "/chats/prompts" });
  // Platforms without a key are not listed at all; a red dot marks the ones that are live.
  const shown = (meta?.platforms ?? []).filter((p) => p.configured && (!platforms || platforms.includes(p.platform)));
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.body.style.background = bg;
    document.body.style.overflow = "hidden";
  }, [bg]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [entries]);
  return (
    <main className="chat-obs" style={{ background: bg }}>
      {showStatus && (shown.length > 0 || offline) && (
        <div className="chat-obs-status">
          {shown.map((p) => (
            <span key={p.platform} className={`chip${p.status === "Connected" ? " live" : ""}`}>
              {chatPlatformLabels[p.platform]}
            </span>
          ))}
          {offline && <span className="chip">controller offline</span>}
        </div>
      )}
      <ul className="chat-obs-list">
        {entries.slice(-max).map((e) => (
          <li key={`${e.platform}:${e.id}`} className={`p-${e.platform}`}>
            <b>{e.author}</b> <span>{e.text}</span>
          </li>
        ))}
      </ul>
      <div ref={end} />
    </main>
  );
}

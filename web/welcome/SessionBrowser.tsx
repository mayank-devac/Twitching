import React from "react";
import type { Agent } from "../../shared/types.js";
import type { Conversation } from "../../shared/sessions.js";

export interface SessionListing {
  publishedId?: string;
  conversations: Conversation[];
  before?: string;
  note?: string;
}

// The browser owns discovery controls; selecting a row only opens the private preview.
export function SessionBrowser({
  source,
  search,
  listing,
  selectedId,
  publishedId,
  busy,
  changeSource,
  changeSearch,
  refresh,
  more,
  select,
}: {
  source: "managed" | Agent;
  search: string;
  listing: SessionListing;
  selectedId?: string;
  publishedId?: string;
  busy: boolean;
  changeSource(source: "managed" | Agent): void;
  changeSearch(search: string): void;
  refresh(): void;
  more(before: string): void;
  select(id: string): void;
}) {
  return (
    <section className="session-browser">
      <div className="session-toolbar">
        <label className="session-search">
          <span className="sr-only">Search sessions</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            placeholder="Search sessions"
            value={search}
            onChange={(e) => changeSearch(e.target.value)}
          />
        </label>
        <label className="session-source">
          <span className="sr-only">Session source</span>
          <select
            value={source}
            onChange={(e) => changeSource(e.target.value as typeof source)}
          >
            <option value="codex">Codex saved</option>
            <option value="managed">Managed</option>
            <option value="cursor">Cursor saved</option>
          </select>
        </label>
      </div>
      <div className="session-list-card">
        {(["codex", "cursor"] as const).map((cli) => {
          const rows = listing.conversations.filter((c) => c.cli === cli);
          if (source === "managed" && !rows.length) return null;
          if (source !== "managed" && source !== cli) return null;
          return (
            <section className="session-group" key={cli}>
              <header>
                <span>
                  {cli.toUpperCase()} ·{" "}
                  {source === "managed" ? "MANAGED SESSIONS" : "SAVED SESSIONS"}
                </span>
                <button
                  className="refresh-sessions"
                  disabled={busy}
                  onClick={refresh}
                >
                  Refresh
                </button>
              </header>
              {rows.map((conversation) => (
                <button
                  className="session-choice"
                  key={conversation.id}
                  disabled={busy}
                  aria-pressed={conversation.id === selectedId}
                  onClick={() => select(conversation.id)}
                >
                  <span className="session-choice-copy">
                    <b>{conversation.title}</b>
                    <small>
                      {conversation.project}
                      {conversation.model && ` · ${conversation.model}`}
                    </small>
                  </span>
                  <span className="session-choice-meta">
                    <time>
                      {conversation.updatedAt
                        ? new Date(conversation.updatedAt).toLocaleTimeString(
                            [],
                            { hour: "numeric", minute: "2-digit" },
                          )
                        : "Unknown"}
                    </time>
                    <small>
                      {conversation.status === "running"
                        ? "Running"
                        : conversation.status === "idle"
                          ? "Waiting"
                          : conversation.status === "unknown"
                            ? "Unknown"
                            : "Disconnected"}
                      {conversation.id === publishedId && " · On stream"}
                    </small>
                  </span>
                </button>
              ))}
              {!rows.length && (
                <p className="session-list-empty">
                  No saved Codex sessions on this page.
                </p>
              )}
            </section>
          );
        })}
        {source === "cursor" && (
          <p className="session-list-empty">
            Existing Cursor sessions cannot be browsed here. Start a managed
            Cursor session instead.
          </p>
        )}
        {listing.note && <p className="session-list-note">{listing.note}</p>}
        {listing.before && (
          <button
            className="load-sessions"
            disabled={busy}
            onClick={() => more(listing.before!)}
          >
            Load more sessions
          </button>
        )}
        {!listing.conversations.length && source === "managed" && (
          <p className="session-list-empty">
            No managed sessions yet. Choose New session to start one.
          </p>
        )}
      </div>
    </section>
  );
}

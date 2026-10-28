import React from "react";
import type { Agent } from "../../shared/types.js";
import type { Conversation } from "../../shared/sessions.js";

export interface SessionListing {
  publishedId?: string;
  conversations: Conversation[];
  before?: string;
  note?: string;
}
// Browsing and selecting are private operations; publication has its own explicit action.
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
    <section className="welcome-card">
      <h2>Session browser</h2>
      <label>
        Source
        <select
          value={source}
          onChange={(e) => changeSource(e.target.value as typeof source)}
        >
          <option value="managed">Managed sessions (Codex & Cursor)</option>
          <option value="codex">Codex saved sessions</option>
          <option value="cursor">Cursor existing sessions — unavailable</option>
        </select>
      </label>
      <label>
        Search title or project
        <input
          type="search"
          value={search}
          onChange={(e) => changeSearch(e.target.value)}
        />
      </label>
      <button disabled={busy} onClick={refresh}>
        Refresh sessions
      </button>
      {listing.note && <p className="qs-hint">{listing.note}</p>}
      {(["codex", "cursor"] as const).map((cli) => (
        <div key={cli}>
          <h3>{cli}</h3>
          {listing.conversations
            .filter((c) => c.cli === cli)
            .map((c) => (
              <button
                className="session-choice"
                key={c.id}
                disabled={busy}
                aria-pressed={c.id === selectedId}
                onClick={() => select(c.id)}
              >
                <b>{c.title}</b>
                <span>
                  {c.project} {c.model && `· ${c.model}`}
                </span>
                <small>
                  {c.updatedAt
                    ? new Date(c.updatedAt).toLocaleString()
                    : "Activity unknown"}{" "}
                  ·{" "}
                  {c.status === "running"
                    ? "Running"
                    : c.status === "idle"
                      ? "Waiting / Idle"
                      : c.status === "unknown"
                        ? "Runtime unknown"
                        : "Disconnected"}
                  {c.id === publishedId && " · On stream"}
                </small>
              </button>
            ))}
        </div>
      ))}
      {!listing.conversations.length && <p>No sessions on this page.</p>}
      {listing.before && (
        <button disabled={busy} onClick={() => more(listing.before!)}>
          Load more sessions
        </button>
      )}
    </section>
  );
}

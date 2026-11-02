import React from "react";
import { CLIS, CLI_LABELS, type Agent } from "../../shared/types.js";
import type { Conversation } from "../../shared/sessions.js";
import {
  MAX_OVERLAY_SESSIONS,
  uniqueConversations,
} from "../../shared/sessions.js";

export type SessionSource = "managed" | "all" | Agent;

export interface SessionListing {
  publishedId?: string;
  publishedIds?: string[];
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
  publishedIds,
  checkedIds = [],
  overlayName,
  selectionDisabled,
  toggleOverlay,
  busy,
  loading = false,
  changeSource,
  changeSearch,
  refresh,
  more,
  select,
}: {
  source: SessionSource;
  search: string;
  listing: SessionListing;
  selectedId?: string;
  publishedId?: string;
  publishedIds?: string[];
  checkedIds?: string[];
  overlayName?: string;
  selectionDisabled?: boolean;
  toggleOverlay?(id: string): void;
  busy: boolean;
  // A list page is loading: only the list's own buttons wait for it.
  loading?: boolean;
  changeSource(source: SessionSource): void;
  changeSearch(search: string): void;
  refresh(): void;
  more(before: string): void;
  select(id: string): void;
}) {
  const conversations = uniqueConversations(listing.conversations);
  const time = (c: Conversation) =>
    c.updatedAt ? new Date(c.updatedAt).getTime() || 0 : 0;
  // "All saved" mixes every CLI into one list, newest first.
  const groups: { key: string; label: string; rows: Conversation[] }[] =
    source === "all"
      ? conversations.length
        ? [
            {
              key: "all",
              label: "ALL · SAVED SESSIONS",
              rows: [...conversations].sort((a, b) => time(b) - time(a)),
            },
          ]
        : []
      : CLIS.filter((cli) => source === "managed" || source === cli)
          .map((cli) => ({
            key: cli,
            label:
              cli.toUpperCase() +
              " · " +
              (source === "managed" ? "MANAGED SESSIONS" : "SAVED SESSIONS"),
            rows: conversations.filter((c) => c.cli === cli),
          }))
          .filter((g) => source !== "managed" || g.rows.length);
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
            <option value="all">All saved</option>
            <option value="codex">Codex saved</option>
            <option value="claude">Claude saved</option>
            <option value="managed">Managed</option>
          </select>
        </label>
      </div>
      {toggleOverlay && (
        <p className="session-selection-target">
          Tick sessions for <b>{overlayName ?? "selected output"}</b> ·{" "}
          {checkedIds.length}/{MAX_OVERLAY_SESSIONS}
        </p>
      )}
      <div className="session-list-card">
        {groups.map(({ key, label, rows }) => {
          return (
            <section className="session-group" key={key}>
              <header>
                <span>{label}</span>
                <button
                  className="refresh-sessions"
                  disabled={busy || loading}
                  onClick={refresh}
                >
                  Refresh
                </button>
              </header>
              {rows.map((conversation) => (
                <div className="session-choice-row" key={conversation.id}>
                  {toggleOverlay && (
                    <label
                      className="session-overlay-check"
                      title={
                        checkedIds.length >= MAX_OVERLAY_SESSIONS &&
                        !checkedIds.includes(conversation.id)
                          ? `${MAX_OVERLAY_SESSIONS} selected. Untick one to add another.`
                          : "Show on " + (overlayName ?? "selected overlay")
                      }
                    >
                      <input
                        type="checkbox"
                        aria-label={
                          "Select " +
                          conversation.title +
                          " (" +
                          conversation.id.slice(-8) +
                          ")" +
                          " for " +
                          (overlayName ?? "overlay")
                        }
                        checked={checkedIds.includes(conversation.id)}
                        disabled={
                          busy ||
                          selectionDisabled ||
                          (checkedIds.length >= MAX_OVERLAY_SESSIONS &&
                            !checkedIds.includes(conversation.id))
                        }
                        onChange={() => toggleOverlay(conversation.id)}
                      />
                    </label>
                  )}
                  <button
                    className="session-choice"
                    key={conversation.id}
                    disabled={busy}
                    aria-pressed={conversation.id === selectedId}
                    onClick={() => select(conversation.id)}
                    title={conversation.title + " · " + conversation.id}
                  >
                    <span className="session-choice-copy">
                      <b>{conversation.title}</b>
                      <small>
                        {source === "all" &&
                          `${CLI_LABELS[conversation.cli]} · `}
                        {conversation.project}
                        {conversation.model && ` · ${conversation.model}`}
                      </small>
                      <small className="session-identity">
                        {conversation.id.slice(-8)}
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
                      {(() => {
                        const status =
                          conversation.status === "running"
                            ? "Running"
                            : conversation.status === "idle"
                              ? "Waiting"
                              : conversation.status === "unknown"
                                ? ""
                                : "Disconnected";
                        const onStream =
                          conversation.id === publishedId ||
                          publishedIds?.includes(conversation.id);
                        const text = [status, onStream && "On stream"]
                          .filter(Boolean)
                          .join(" · ");
                        return text ? <small>{text}</small> : null;
                      })()}
                    </span>
                  </button>
                </div>
              ))}
              {!rows.length && (
                <p className="session-list-empty">No saved sessions loaded.</p>
              )}
            </section>
          );
        })}
        {source === "cursor" && (
          <p className="session-list-empty">
            {CLI_LABELS[source]} history isn't browsable here. Start a managed{" "}
            {CLI_LABELS[source]} session.
          </p>
        )}
        {listing.note && <p className="session-list-note">{listing.note}</p>}
        {listing.before && (
          <button
            className="load-sessions"
            disabled={busy || loading}
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

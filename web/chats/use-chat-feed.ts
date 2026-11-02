import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatPlatform } from "../../shared/settings.js";
import type { FeedEntry, FeedView } from "../../server/chat-feed.js";

export type { FeedEntry, FeedView };

const KEEP = 300;
const keyOf = (e: FeedEntry) => `${e.platform}:${e.id}`;
// Polls the cursor-based feed. Reading is public, so the OBS page needs no host token.
// The server answers `reset` after a restart or a settings change; the page then
// replaces its list instead of appending, so hidden words and stale cursors never linger.
export function useChatFeed({ platforms, prompts, pollMs = 1500 }: { platforms?: ChatPlatform[]; prompts?: boolean; pollMs?: number }) {
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [meta, setMeta] = useState<Pick<FeedView, "settings" | "platforms">>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [offline, setOffline] = useState(false);
  const cursor = useRef<number | undefined>(undefined);
  const rev = useRef<string | undefined>(undefined);
  const busy = useRef(false);
  const current = useRef<AbortController | undefined>(undefined);
  const key = `${platforms?.join(",") ?? ""}|${prompts ? 1 : 0}`;
  const load = useCallback(async () => {
    // One request at a time: an overlapping poll would reuse the same cursor and duplicate rows.
    if (busy.current) return;
    busy.current = true;
    const control = new AbortController();
    current.current = control;
    const query = new URLSearchParams();
    if (platforms?.length) query.set("platforms", platforms.join(","));
    if (prompts) query.set("prompts", "1");
    if (cursor.current !== undefined) query.set("since", String(cursor.current));
    if (rev.current !== undefined) query.set("rev", rev.current);
    try {
      const response = await fetch(`/api/chat-feed?${query}`, { signal: control.signal });
      if (!response.ok) throw new Error("Chat feed unavailable");
      const view = (await response.json()) as FeedView;
      if (control.signal.aborted) return;
      cursor.current = view.cursor;
      rev.current = view.rev;
      setMeta({ settings: view.settings, platforms: view.platforms });
      setSelected(new Set(view.selected));
      setOffline(false);
      setEntries((old) => {
        const base = view.reset ? [] : old;
        const seen = new Set(base.map(keyOf));
        return [...base, ...view.entries.filter((e) => !seen.has(keyOf(e)))].slice(-KEEP);
      });
    } catch {
      if (!control.signal.aborted) setOffline(true);
    } finally {
      if (current.current === control) busy.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    cursor.current = undefined;
    rev.current = undefined;
    setEntries([]);
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      current.current?.abort();
      busy.current = false;
      clearInterval(timer);
    };
  }, [load, pollMs]);
  // Forces a full refetch right away, e.g. after the host changes a feed setting.
  const refresh = useCallback(() => {
    current.current?.abort();
    busy.current = false;
    cursor.current = undefined;
    rev.current = undefined;
    void load();
  }, [load]);
  return { entries, meta, selected, offline, refresh };
}

// Client-side filters shared by the drawer and the filter page.
export interface ChatFilters {
  platforms: Set<ChatPlatform>;
  selectedOnly: boolean;
  search: string;
}
export function useFilteredEntries(entries: FeedEntry[], selected: Set<string>, filters: ChatFilters) {
  return useMemo(() => {
    const term = filters.search.trim().toLowerCase();
    return entries
      .filter(
        (e) =>
          filters.platforms.has(e.platform) &&
          (!filters.selectedOnly || selected.has(e.id)) &&
          (!term || `${e.author} ${e.text}`.toLowerCase().includes(term)),
      )
      .reverse();
  }, [entries, selected, filters.platforms, filters.selectedOnly, filters.search]);
}

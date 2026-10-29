import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { markdownComponents, markdownPlugins } from "../markdown.js";
import type { SessionView, TimelineItem } from "../../shared/sessions.js";
import codexLogo from "../../assets/codex/codex.svg";
import cursorLogo from "../../assets/cursor/Cube/SVG/CUBE_2D_DARK.svg";
import "./welcome.css";
import { mergeTimeline, visibleTimeline } from "../../shared/timeline.js";

// Unchanged history should not reparse Markdown whenever the current answer grows.
const MessageText = React.memo(function MessageText({
  text,
}: {
  text: string;
}) {
  return (
    <ReactMarkdown
      skipHtml
      remarkPlugins={markdownPlugins}
      components={markdownComponents}
    >
      {text}
    </ReactMarkdown>
  );
});

// Stable item IDs deduplicate reconnect snapshots; run IDs define prompt boundaries.
export function Timeline({
  view,
  older,
}: {
  view: SessionView;
  older(before: string): Promise<SessionView>;
}) {
  const [items, setItems] = useState(view.page.items);
  const [before, setBefore] = useState(view.page.before);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showPrevious, setShowPrevious] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const loadedOlder = useRef(false);
  const busyRef = useRef(false);
  const autoState = useRef({ before: view.page.before, hidden: false, showPrevious: false });
  const restore = useRef<
    | { height: number; top: number; anchor?: string; anchorTop?: number }
    | undefined
  >(undefined);
  const latestRun = view.page.latestRun ?? view.page.items.at(-1)?.run;
  const latestPage = useRef(view.page);
  latestPage.current = view.page;
  useEffect(() => {
    setShowPrevious(false);
    if (view.hidePreviousRuns) {
      setItems(latestPage.current.items);
      setBefore(latestPage.current.before);
      loadedOlder.current = false;
      follow.current = true;
    }
  }, [latestRun, view.hidePreviousRuns]);
  useEffect(() => {
    if (view.page.before && !loadedOlder.current) setBefore(view.page.before);
    setItems((current) => {
      const next = mergeTimeline(current, view.page.items);
      // Keep the reader's loaded window when new activity would evict messages they are reading.
      if (next.length > 600 && !follow.current) return current;
      return next.length > 600 ? view.page.items : next;
    });
  }, [view.page.items]);
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    if (restore.current) {
      const anchor = Array.from(
        el.querySelectorAll<HTMLElement>("[data-item-id]"),
      ).find((node) => node.dataset.itemId === restore.current?.anchor);
      if (anchor && restore.current.anchorTop !== undefined)
        el.scrollTop +=
          anchor.getBoundingClientRect().top - restore.current.anchorTop;
      else
        el.scrollTop =
          restore.current.top + el.scrollHeight - restore.current.height;
      restore.current = undefined;
    } else if (follow.current) el.scrollTop = el.scrollHeight;
  }, [items, showPrevious]);
  async function loadOlder() {
    if (!before || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const page = await older(before);
      if (page.conversation.id !== view.conversation.id) return;
      const el = container.current;
      if (el) {
        const anchor = Array.from(
          el.querySelectorAll<HTMLElement>("[data-item-id]"),
        ).find(
          (node) =>
            node.getBoundingClientRect().bottom >=
            el.getBoundingClientRect().top,
        );
        restore.current = {
          height: el.scrollHeight,
          top: el.scrollTop,
          anchor: anchor?.dataset.itemId,
          anchorTop: anchor?.getBoundingClientRect().top,
        };
      }
      follow.current = false;
      loadedOlder.current = true;
      setItems((current) =>
        mergeTimeline(page.page.items, current).slice(0, 480),
      );
      setBefore(page.page.before);
    } catch (e) {
      setError(e instanceof Error ? e.message : "History unavailable");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  // A sentinel at the top loads older history whenever it scrolls into view.
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;
  autoState.current = { before, hidden: view.hidePreviousRuns, showPrevious };
  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      const state = autoState.current;
      if (!state.before || (state.hidden && !state.showPrevious)) return;
      void loadOlderRef.current();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const visible = visibleTimeline(
    items,
    view.visibility,
    view.hidePreviousRuns,
    showPrevious,
    latestRun,
  );
  const c = view.conversation;
  return (
    <section className="session-timeline" aria-label="Conversation">
      <header className="timeline-heading">
        {view.visibility.cliIcon && (
          <img alt="" src={c.cli === "codex" ? codexLogo : cursorLogo} />
        )}
        <div>
          <h2>{c.title}</h2>
          <p>
            {view.visibility.cliName && <span>{c.cli} · </span>}
            {view.visibility.model && (
              <span>{c.model || "Model unknown"} · </span>
            )}
            {c.status === "running"
              ? "Running"
              : c.status === "idle"
                ? "Idle"
                : c.status === "unknown"
                  ? "Unknown · saved history"
                  : "Disconnected"}
            {view.published && " · On stream"}
          </p>
        </div>
      </header>
      {view.hidePreviousRuns && (
        <button
          className="timeline-history-choice"
          onClick={() => setShowPrevious((v) => !v)}
        >
          {showPrevious
            ? "Show latest run"
            : "Show earlier runs (history kept)"}
        </button>
      )}
      <div
        ref={container}
        className="timeline-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div ref={sentinel} aria-hidden="true" className="timeline-sentinel" />
        <button
          onClick={() => {
            follow.current = true;
            loadedOlder.current = false;
            setItems(view.page.items);
            setBefore(view.page.before);
          }}
        >
          Latest messages
        </button>
        {before && (!view.hidePreviousRuns || showPrevious) && (
          <button disabled={busy} onClick={() => void loadOlder()}>
            {busy ? "Loading…" : "Load older"}
          </button>
        )}
        {error && <p role="alert">{error}</p>}
        {!visible.length && (
          <p className="timeline-empty">No visible activity yet.</p>
        )}
        {visible.map((item, index) => (
          <React.Fragment key={item.id}>
            {(index === 0 || visible[index - 1].run !== item.run) && (
              <div className="run-boundary">Run {item.run.slice(0, 8)}</div>
            )}
            <article
              data-item-id={item.id}
              className={`timeline-item kind-${item.kind}`}
            >
              <small>{item.kind === "prompt" ? "You" : item.kind}</small>
              <MessageText text={item.text} />
            </article>
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}

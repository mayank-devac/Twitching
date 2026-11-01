import React, { useMemo } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

// External links open in a new tab. `node` is react-markdown's hast node; it is
// stripped so it never lands on the DOM as node="[object Object]".
export function MarkdownLink({
  children,
  node: _node,
  ...props
}: React.ComponentProps<"a"> & ExtraProps) {
  return (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

// Both public renderers use the same safe Markdown rules and scrollable tables.
const markdownPlugins = [remarkGfm];
const markdownComponents: Components = {
  img: () => null,
  a: MarkdownLink,
  table: ({ children, node: _node, ...props }) => (
    <div className="markdown-table-scroll" role="region" aria-label="Response table" tabIndex={0}>
      <table {...props}>{children}</table>
    </div>
  ),
};

// The only Markdown entry point: raw HTML is always skipped and the safe rules always
// apply; `components` may add or replace renderers on top of them. Memoised so a
// parent re-render only re-parses Markdown whose text changed — pass a stable
// `components` object to keep that.
export const SafeMarkdown = React.memo(function SafeMarkdown({
  text,
  components,
}: {
  text: string;
  components?: Components;
}) {
  const merged = useMemo(
    () => (components ? { ...markdownComponents, ...components } : markdownComponents),
    [components],
  );
  return (
    <ReactMarkdown skipHtml remarkPlugins={markdownPlugins} components={merged}>
      {text}
    </ReactMarkdown>
  );
});

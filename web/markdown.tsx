import React from "react";
import type { Components, ExtraProps } from "react-markdown";
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
export const markdownPlugins = [remarkGfm];
export const markdownComponents: Components = {
  img: () => null,
  a: MarkdownLink,
  table: ({ children, node: _node, ...props }) => (
    <div className="markdown-table-scroll" role="region" aria-label="Response table" tabIndex={0}>
      <table {...props}>{children}</table>
    </div>
  ),
};

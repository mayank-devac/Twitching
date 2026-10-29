import React from "react";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Both public renderers use the same safe Markdown rules and scrollable tables.
export const markdownPlugins = [remarkGfm];
export const markdownComponents: Components = {
  img: () => null,
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  table: ({ children, node: _node, ...props }) => (
    <div className="markdown-table-scroll" role="region" aria-label="Response table" tabIndex={0}>
      <table {...props}>{children}</table>
    </div>
  ),
};

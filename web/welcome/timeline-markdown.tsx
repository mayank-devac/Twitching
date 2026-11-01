import React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { MarkdownLink, markdownComponents, markdownPlugins } from "../markdown.js";
import { MermaidDiagram } from "./Mermaid.js";

// Markdown rules for timeline rows: the shared safe rules, plus
// mermaid diagrams and "Annotation N" tags.
const timelineComponents: Components = {
  ...markdownComponents,
  pre: ({ children, node: _node, ...props }) => {
    const code = React.Children.toArray(children)[0];
    if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(code)) {
      if (/\blanguage-mermaid\b/.test(code.props.className ?? ""))
        return <MermaidDiagram source={String(code.props.children ?? "").trim()} />;
    }
    return <pre {...props}>{children}</pre>;
  },
  a: (props) =>
    props.href?.startsWith("#annotation-") ? (
      <span className="tag tag-annotation">{props.children}</span>
    ) : (
      <MarkdownLink {...props} />
    ),
};

// Codex adds machine directives such as ::created-thread{threadId="…"} on their own line.
// They are instructions for Codex's own UI, not text for the viewer.
const directiveLine = /^[ \t]*::[\w-]+\{[^}\n]*\}[ \t]*$/gm;
const stripDirectives = (text: string) =>
  text.replace(directiveLine, "").replace(/\n{3,}/g, "\n\n").trim();

// Memoised so unchanged history is not reparsed while the current answer grows.
export const TimelineMarkdown = React.memo(function TimelineMarkdown({
  text,
}: {
  text: string;
}) {
  return (
    <ReactMarkdown
      skipHtml
      remarkPlugins={markdownPlugins}
      components={timelineComponents}
    >
      {stripDirectives(text)}
    </ReactMarkdown>
  );
});

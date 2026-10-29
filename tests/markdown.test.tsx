import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { markdownComponents, markdownPlugins } from "../web/markdown.js";

test("agent response renders a safe, readable GFM table", () => {
  const response = [
    "| Session | CLI | Model |",
    "|:---|:---:|---:|",
    "| First | **Codex** | `gpt-6` |",
    "| Second | Cursor | Long model name |",
    "",
    "```md",
    "| Plain | code |",
    "|---|---|",
    "```",
    "<script>alert('unsafe')</script>",
    "![remote image](https://example.com/pixel.png)",
  ].join("\n");
  const html = renderToStaticMarkup(
    <ReactMarkdown skipHtml remarkPlugins={markdownPlugins} components={markdownComponents}>
      {response}
    </ReactMarkdown>,
  );
  assert.match(html, /class="markdown-table-scroll"[^>]*tabindex="0"/);
  assert.match(html, /<table>[\s\S]*<th align="left">Session<\/th>/);
  assert.match(html, /<td align="center"><strong>Codex<\/strong><\/td>/);
  assert.match(html, /<td align="right"><code>gpt-6<\/code><\/td>/);
  assert.match(html, /<pre><code[^>]*>\| Plain \| code \|/);
  assert.equal((html.match(/<table>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<script|<img|pixel\.png/);
});

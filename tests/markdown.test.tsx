import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SafeMarkdown } from "../web/markdown.js";

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
    "",
    "[docs](https://example.com/docs)",
  ].join("\n");
  const html = renderToStaticMarkup(<SafeMarkdown text={response} />);
  assert.match(html, /class="markdown-table-scroll"[^>]*tabindex="0"/);
  // react-markdown 10 (hast-util-to-jsx-runtime) maps the obsolete `align`
  // attribute to an inline text-align style, so column alignment is kept.
  assert.match(html, /<table>[\s\S]*<th style="text-align:left">Session<\/th>/);
  assert.match(html, /<td style="text-align:center"><strong>Codex<\/strong><\/td>/);
  assert.match(html, /<td style="text-align:right"><code>gpt-6<\/code><\/td>/);
  assert.match(html, /<pre><code[^>]*>\| Plain \| code \|/);
  assert.equal((html.match(/<table>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<script|<img|pixel\.png/);
  // Links open externally and never leak react-markdown's hast node as an attribute.
  assert.match(html, /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noreferrer">docs<\/a>/);
  assert.doesNotMatch(html, /node=/);
});

test("component overrides merge onto the safe rules without re-enabling HTML", () => {
  const html = renderToStaticMarkup(
    <SafeMarkdown
      text={"| A |\n|---|\n| [x](#note) |\n\n<b>raw</b> ![i](https://example.com/i.png)"}
      components={{ a: ({ children }) => <span className="tag">{children}</span> }}
    />,
  );
  assert.match(html, /<span class="tag">x<\/span>/);
  // Overrides replace only the named renderer; the table wrapper and image block stay.
  assert.match(html, /class="markdown-table-scroll"/);
  assert.doesNotMatch(html, /<b>|<img/);
});

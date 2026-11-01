import React, { useEffect, useId, useState } from "react";

// Mermaid is large, so it loads (and is configured) once, on first use.
let mermaidReady: Promise<typeof import("mermaid").default> | undefined;
const loadMermaid = () =>
  (mermaidReady ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
    });
    return mermaid;
  }));

// Renders a ```mermaid code block as a diagram. While the source is invalid
// (for example, a reply that is still streaming) the raw code is shown instead.
export function MermaidDiagram({ source }: { source: string }) {
  const id = "mermaid-" + useId().replace(/\W/g, "");
  const [svg, setSvg] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = await loadMermaid();
        const result = await mermaid.render(id, source);
        if (!cancelled) setSvg(result.svg);
      } catch {
        if (!cancelled) setSvg("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, source]);

  if (!svg)
    return (
      <pre>
        <code>{source}</code>
      </pre>
    );
  return (
    <div
      className="mermaid-diagram"
      role="img"
      aria-label="Diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

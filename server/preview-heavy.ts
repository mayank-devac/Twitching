// Direct preview (no Docker browser) cannot render the page first, so it screens the HTML
// instead: obvious never-ending loops are refused, merely big pages get a host warning, and
// a heartbeat script lets the arena panel notice a page that later stops responding.
export class HeavyPageError extends Error {}

export interface PageAssessment {
  // Set when the page looks like it can never finish a script; the preview refuses it.
  block?: string;
  // Set when the page may be slow; the preview still loads and the host sees the text.
  warning?: string;
}

const LARGE_PAGE_BYTES = 400_000;
const MANY_ELEMENTS = 5000;
const HUGE_CANVAS = 8192;
// A loop header that runs forever unless its body leaves it.
const ENDLESS_LOOP = /\b(?:while\s*\(\s*(?:true|1|!0)\s*\)|for\s*\(\s*;\s*;\s*\)|do\s*\{[^]{0,400}?\}\s*while\s*\(\s*(?:true|1|!0)\s*\))/g;
// Signs that the loop can end or yield, looked for right after its header.
const LEAVES_LOOP = /\b(?:break|return|throw|await|yield)\b/;
const HUGE_ITERATIONS = /\b(?:for|while)\b[^{]*?[<>]=?\s*(?:1e[7-9]|1e\d{2}|\d{8,})/;

function inlineScripts(html: string) {
  return [...html.matchAll(/<script\b[^>]*>([^]*?)<\/script>/gi)].map((m) => m[1] ?? "");
}

export function assessPage(html: string): PageAssessment {
  const kb = Math.round(Buffer.byteLength(html) / 1000);
  const warnings: string[] = [];
  for (const script of inlineScripts(html))
    for (const loop of script.matchAll(ENDLESS_LOOP)) {
      const body = script.slice(loop.index, loop.index + 400);
      if (!LEAVES_LOOP.test(body))
        return { block: "The page runs an endless loop that would freeze the preview" };
    }
  if (inlineScripts(html).some((script) => HUGE_ITERATIONS.test(script)))
    warnings.push("runs a very long loop");
  if (Buffer.byteLength(html) > LARGE_PAGE_BYTES) warnings.push(`is large (${kb} KB)`);
  if ((html.match(/<[a-z]/gi)?.length ?? 0) > MANY_ELEMENTS)
    warnings.push("has thousands of elements");
  const canvasSizes = [...html.matchAll(/<canvas\b[^>]*>/gi)].flatMap((tag) =>
    [...tag[0].matchAll(/\b(?:width|height)\s*=\s*["']?(\d+)/gi)].map((size) => Number(size[1])),
  );
  if (canvasSizes.some((size) => size > HUGE_CANVAS)) warnings.push("uses a very large canvas");
  return warnings.length
    ? { warning: `Heavy page: it ${warnings.join(", ")}. The preview may be slow or pause.` }
    : {};
}

// First script in the page: tells the arena panel the page is alive and how long it blocked.
const WATCHDOG = `<script>(function(){var send=function(m){try{parent.postMessage(m,"*")}catch(e){}};` +
  `send({twitching:"hb"});setInterval(function(){send({twitching:"hb"})},500);` +
  `try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){` +
  `if(e.duration>1000)send({twitching:"hb",long:Math.round(e.duration)})})}).observe({entryTypes:["longtask"]})}catch(e){}})();</script>`;

export function withWatchdog(html: string) {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + WATCHDOG + html.slice(head.index + head[0].length);
  const root = /<html\b[^>]*>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + WATCHDOG + html.slice(root.index + root[0].length);
  return WATCHDOG + html;
}

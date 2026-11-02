import { readFile, lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parse, serialize } from "parse5";
import type { Browser, BrowserContext, Page } from "playwright";
import express from "express";
import { z } from "zod";
import type { SessionId, SessionCount } from "../shared/types.js";
import { credentialGuard } from "./redact.js";
import { assessPage, HeavyPageError, withWatchdog } from "./preview-heavy.js";
export const previewPolicy =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; webrtc 'block'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
export function sanitizeHtml(html: string) {
  const doc: any = parse(html);
  const walk = (node: any) => {
    if (node.childNodes)
      node.childNodes = node.childNodes.filter(
        (c: any) =>
          ![
            "iframe",
            "frame",
            "frameset",
            "object",
            "embed",
            "base",
            "link",
          ].includes(c.tagName) &&
          !(
            c.tagName === "meta" &&
            c.attrs?.some((a: any) => a.name === "http-equiv")
          ),
      );
    if (node.attrs)
      node.attrs = node.attrs.filter(
        (a: any) =>
          ![
            "src",
            "href",
            "action",
            "formaction",
            "poster",
            "background",
            "srcset",
            "ping",
            "target",
          ].includes(a.name) ||
          (/^data:(?:image|font|audio|video)\//i.test(a.value) &&
            a.name === "src"),
      );
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  walk(doc);
  return serialize(doc);
}
interface View {
  viewport: { width: number; height: number };
  token: string;
  html: string;
  // Direct views have no isolated browser: the host browser loads `html` itself.
  context?: BrowserContext;
  page?: Page;
  direct?: boolean;
  warning?: string;
  error?: string;
  capture?: Promise<Buffer>;
  image?: Buffer;
  capturedAt: number;
  input: Promise<void>;
}
const inputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click"),
    x: z.number().min(0).max(1920),
    y: z.number().min(0).max(1044),
  }),
  z.object({
    type: z.literal("move"),
    x: z.number().min(0).max(1920),
    y: z.number().min(0).max(1044),
  }),
  z.object({
    type: z.literal("key"),
    key: z
      .string()
      .regex(
        /^(ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Enter|Escape|Space|Backspace|Tab|[a-zA-Z0-9])$/,
      ),
  }),
  z.object({ type: z.literal("wheel"), dy: z.number().min(-1000).max(1000) }),
]);
export function viewportFor(count: SessionCount) {
  if (count !== 1 && count !== 2)
    throw new Error("Preview requires one or two sessions");
  return { width: count === 1 ? 1920 : 960, height: 1044 };
}
export class Previews {
  private browser?: Browser;
  private views = new Map<string, View>();
  constructor(
    private root: string,
    readonly origin: string,
    private visual: string,
    private browserFactory: () => Promise<Browser>,
    private assertSafeHtml: (html: string) => void = credentialGuard([]),
    private viewMode: "jpeg" | "live" = "live",
  ) {}
  // Existing result URLs must stop serving content while publication is hidden.
  publicHidden = () => false;
  // True when the host chose direct preview (native agents without Docker); checked per call so a saved toggle applies at once.
  direct = () => false;
  app() {
    const app = express();
    app.disable("x-powered-by");
    app.use((req, res, next) => {
      if (req.headers.host !== new URL(this.origin).host) {
        res.status(403).end();
        return;
      }
      res.set({
        "Content-Security-Policy": `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${this.origin}; connect-src ${this.origin}; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-DNS-Prefetch-Control": "off",
        "Cache-Control": "no-store",
        "Permissions-Policy":
          "camera=(), microphone=(), geolocation=(), usb=(), payment=()",
      });
      if (this.publicHidden()) { res.status(423).type("html").send("<h1>Back shortly</h1>"); return; }
      next();
    });
    app.get("/page/:agent/:round", (req, res) => {
      const view = this.views.get(`${req.params.agent}:${req.params.round}`);
      if (!view) {
        res.status(404).type("html").send("<h1>Result unavailable</h1>");
        return;
      }
      if (this.viewMode === "live" || view.direct) {
        res.set("Content-Security-Policy", previewPolicy);
        res.type("html").send(view.html);
        return;
      }
      res.type("html").send(this.viewer(view));
    });
    app.get("/break", async (_req, res) => {
      try {
        // A configured GIF is served as an image, never fed into the HTML renderer.
        if (this.visual.toLowerCase().endsWith(".gif")) {
          const info = await lstat(this.visual);
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            (await realpath(this.visual)) !== this.visual
          )
            throw new Error("Unsafe break visual");
          res.type("gif").sendFile(this.visual, (error) => {
            if (error && !res.headersSent) res.status(404).end();
          });
          return;
        }
        if (!this.views.has("break")) {
          let html;
          try {
            html = await readFile(this.visual, "utf8");
          } catch {
            html =
              '<body style="background:#101419;color:#b9ef85;display:grid;place-items:center;height:100vh;font:70px monospace">● ‿ ●</body>';
          }
          this.views.set(
            "break",
            await this.render(sanitizeHtml(html), viewportFor(1)),
          );
        }
        res.type("html").send(this.viewer(this.views.get("break")!));
      } catch {
        res.status(503).type("html").send("<h1>Break visual unavailable</h1>");
      }
    });
    app.get("/frame/:token", async (req, res) => {
      const view = this.find(String(req.params.token));
      if (!view || view.error || view.direct) {
        res.status(410).end();
        return;
      }
      try {
        const frame = await this.capture(view);
        if (this.publicHidden()) { res.status(423).end(); return; }
        res.type("jpeg").send(frame);
      } catch {
        res.status(410).end();
      }
    });
    app.post(
      "/input/:token",
      express.text({ type: "text/plain", limit: "1kb" }),
      async (req, res) => {
        const view = this.find(String(req.params.token));
        if (
          !view ||
          !view.page ||
          view.error ||
          ![undefined, "null", this.origin].includes(req.headers.origin)
        ) {
          res.status(403).end();
          return;
        }
        let parsed;
        try {
          parsed = inputSchema.safeParse(JSON.parse(req.body));
        } catch {
          res.status(400).end();
          return;
        }
        if (!parsed.success) {
          res.status(400).end();
          return;
        }
        const input = parsed.data;
        if (
          (input.type === "click" || input.type === "move") &&
          (input.x > view.viewport.width || input.y > view.viewport.height)
        ) {
          res.status(400).end();
          return;
        }
        const page = view.page;
        view.input = view.input
          .then(async () => {
            if (input.type === "click")
              await page.mouse.click(input.x, input.y);
            else if (input.type === "move")
              await page.mouse.move(input.x, input.y);
            else if (input.type === "wheel")
              await page.mouse.wheel(0, input.dy);
            else await page.keyboard.press(input.key);
          })
          .catch(() => {
            view.error = "Preview stopped responding";
          });
        await view.input;
        res.status(204).end();
      },
    );
    return app;
  }
  private find(token: string) {
    return [...this.views.values()].find((v) => v.token === token);
  }
  private viewer(view: View) {
    // jpeg mode only: OBS runs this trusted viewer, and generated JavaScript
    // stays in the network-isolated preview browser that renders the frames.
    // live mode (the default) instead serves the raw generated page to OBS
    // under previewPolicy; that CSP blocks fetch/frames/workers, but its
    // `webrtc 'block'` directive is not reliably enforced by Chromium/CEF.
    const base = JSON.stringify(this.origin);
    const token = JSON.stringify(view.token);
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;background:#11161d;overflow:hidden}body{display:grid;place-items:center}img{width:100%;height:100%;object-fit:contain}#error{display:none;color:#dbe3ee;font:20px system-ui;padding:30px;text-align:center}</style></head><body tabindex="0"><img alt="Live rendered HTML result"><div id="error">The result preview stopped responding.</div><script>
      const base=${base},token=${token},image=document.querySelector('img');let timer;
      const next=()=>{image.src=base+'/frame/'+token+'?t='+Date.now()};image.onload=()=>{timer=setTimeout(next,180)};image.onerror=()=>{image.style.display='none';document.querySelector('#error').style.display='block'};next();
      const send=data=>fetch(base+'/input/'+token,{method:'POST',mode:'no-cors',credentials:'omit',headers:{'Content-Type':'text/plain'},body:JSON.stringify(data)}).catch(()=>{});
      function position(e){const rect=image.getBoundingClientRect(),scale=Math.min(rect.width/${view.viewport.width},rect.height/${view.viewport.height}),left=rect.left+(rect.width-${view.viewport.width}*scale)/2,top=rect.top+(rect.height-${view.viewport.height}*scale)/2;return{x:Math.max(0,Math.min(${view.viewport.width},(e.clientX-left)/scale)),y:Math.max(0,Math.min(${view.viewport.height},(e.clientY-top)/scale))}};
      image.onclick=e=>{document.body.focus();send({type:'click',...position(e)})};let moved=0;image.onmousemove=e=>{if(Date.now()-moved>60){moved=Date.now();send({type:'move',...position(e)})}};
      onkeydown=e=>{const key=e.key===' '?'Space':e.key;if(/^(ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Enter|Escape|Space|Backspace|Tab|[a-zA-Z0-9])$/.test(key)){e.preventDefault();send({type:'key',key})}};onwheel=e=>{e.preventDefault();send({type:'wheel',dy:Math.max(-1000,Math.min(1000,e.deltaY))})};
    </script></body></html>`;
  }
  async ready() {
    if (this.direct()) return;
    if (!this.browser?.isConnected())
      this.browser = await this.browserFactory();
  }
  private async render(
    html: string,
    viewport: { width: number; height: number },
  ): Promise<View> {
    if (!this.browser) throw new Error("Preview browser is not ready");
    const token = randomBytes(24).toString("hex");
    const url = `${this.origin}/isolated/${token}`;
    const context = await this.browser.newContext({
      acceptDownloads: false,
      viewport,
    });
    const page = await context.newPage();
    const view: View = {
      viewport,
      token,
      html,
      context,
      page,
      capturedAt: 0,
      input: Promise.resolve(),
    };
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => {
      void d.dismiss();
    });
    // Fulfil only the initial document from memory. Even the initial load never reaches the host network.
    let supplied = false;
    await context.route("**/*", (route) => {
      if (!supplied && route.request().url() === url) {
        supplied = true;
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          headers: {
            "Content-Security-Policy": previewPolicy,
            "X-DNS-Prefetch-Control": "off",
          },
          body: html,
        });
      }
      return route.abort();
    });
    try {
      await page.goto(url, { waitUntil: "load", timeout: 8000 });
      await page.waitForTimeout(250);
      const rendered = await page.evaluate(
        () =>
          document.body !== null &&
          Array.from(document.body.querySelectorAll("*")).some((e) => {
            const r = e.getBoundingClientRect();
            return (
              !["SCRIPT", "STYLE"].includes(e.tagName) &&
              r.width > 1 &&
              r.height > 1
            );
          }),
      );
      if (!rendered || errors.length || page.url().split("#")[0] !== url)
        throw new Error("HTML did not load successfully");
      page.on("pageerror", () => {
        view.error = "HTML raised a JavaScript error";
      });
      page.on("crash", () => {
        view.error = "Preview crashed";
      });
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame() && frame.url().split("#")[0] !== url)
          view.error = "Preview attempted navigation";
      });
      await this.capture(view);
      return view;
    } catch (error) {
      await context.close();
      throw error;
    }
  }
  private async capture(view: View) {
    if (view.error || !view.page) throw new Error(view.error ?? "No isolated page");
    const page = view.page;
    if (view.image && Date.now() - view.capturedAt < 150) return view.image;
    if (!view.capture)
      view.capture = page
        .screenshot({ type: "jpeg", quality: 80, timeout: 1800 })
        .then((image) => {
          view.image = image;
          view.capturedAt = Date.now();
          return image;
        })
        .catch(() => {
          view.error = "Preview stopped responding";
          throw new Error(view.error);
        })
        .finally(() => {
          view.capture = undefined;
        });
    return view.capture;
  }
  async validate(agent: SessionId, round: number, count: SessionCount) {
    const file = resolve(this.root, "main", agent, `prompt_${round}.html`);
    const stat = await lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 2_000_000 ||
      (await realpath(file)) !==
        resolve(
          await realpath(this.root),
          "main",
          agent,
          `prompt_${round}.html`,
        )
    )
      throw new Error("Output HTML missing or unsafe");
    const html = await readFile(file, "utf8");
    this.assertSafeHtml(html);
    if (!/<(?:html|body|canvas|div|main|svg|button)\b/i.test(html))
      throw new Error("Output is not HTML");
    let view: View;
    if (this.direct()) {
      // No browser to try the page in, so screen it, then let the host browser load it with a heartbeat.
      const found = assessPage(html);
      if (found.block) throw new HeavyPageError(found.block);
      view = {
        viewport: viewportFor(count),
        token: randomBytes(24).toString("hex"),
        html: withWatchdog(html),
        direct: true,
        warning: found.warning,
        capturedAt: 0,
        input: Promise.resolve(),
      };
    } else view = await this.render(html, viewportFor(count));
    for (const [key, old] of this.views)
      if (key.startsWith(`${agent}:`)) {
        await old.context?.close();
        this.views.delete(key);
      }
    this.views.set(`${agent}:${round}`, view);
    return `${this.origin}/page/${agent}/${round}`;
  }
  // Host-facing note for a direct preview that may be slow; undefined for isolated or light pages.
  warning(agent: SessionId) {
    for (const [key, view] of this.views)
      if (key.startsWith(`${agent}:`)) return view.warning;
    return undefined;
  }
  async restore(agent: SessionId, round: number, count: SessionCount) {
    try {
      return await this.validate(agent, round, count);
    } catch {
      return undefined;
    }
  }
  async close() {
    const views = [...this.views.values()];
    this.views.clear();
    await Promise.allSettled(views.map((view) => view.context?.close()));
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
  }
}

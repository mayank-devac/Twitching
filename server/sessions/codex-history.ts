import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename } from "node:path";
import { z } from "zod";
import type {
  Conversation,
  TimelineItem,
  TimelinePage,
} from "../../shared/sessions.js";
import { commandName } from "../activity.js";
import { CodexAppServerClient } from "../codex-app-server.js";

// Provider rows are read leniently: a wrong-typed field becomes empty rather
// than failing the whole page, matching what the UI can show.
const text = z.string().catch("");
const time = z.number().catch(0);
const list = <T extends z.ZodType>(item: T) => z.array(item).catch([]);
const lenient = <T extends z.ZodRawShape>(shape: T) => {
  const schema = z.object(shape);
  return schema.catch(() => schema.parse({}));
};
const thread = lenient({
  id: text,
  name: text,
  preview: text,
  cwd: text,
  updatedAt: time,
  model: text,
  // Protocol `Thread.reasoningEffort`: latest persisted effort, null when unset.
  reasoningEffort: text,
});
type Thread = z.output<typeof thread>;
const threadPage = lenient({ data: list(thread), nextCursor: text });
const threadRead = lenient({ thread });
const itemPage = lenient({
  nextCursor: text,
  data: list(
    lenient({
      turnId: text,
      startedAtMs: time,
      completedAtMs: time,
      item: lenient({
        type: text,
        id: text,
        text,
        content: list(lenient({ type: text, text })),
        summary: list(text),
        command: text,
        status: text,
        query: text,
      }),
    }),
  ),
});

// This client has no start/resume/turn methods. It reads through the installed CLI API only.
export class CodexHistory {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<CodexAppServerClient>;
  constructor(private clean: (text: string, limit?: number) => string) {}
  private connect() {
    return (this.ready ??= (async () => {
      const child = spawn("codex", ["app-server"], {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CODEX_HOME: process.env.CODEX_HOME,
          TMPDIR: process.env.TMPDIR,
          LANG: process.env.LANG,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      // Raw provider responses never leave this client or enter public transport.
      const client = new CodexAppServerClient(child, {
        maxLine: 4_000_000,
        messages: {
          rejected:
            "Installed Codex does not support this history request. Update the CLI or use a managed session.",
          closed: "Codex history disconnected. Check the installed CLI and retry.",
          pipe: "Codex history pipe closed",
          timeout: () =>
            "Codex history request timed out. Retry after checking the CLI.",
          refused: "Read-only history client",
        },
        onClose: () => {
          if (this.child !== child) return;
          this.child = undefined;
          this.ready = undefined;
        },
      });
      await client.initialize({ name: "twitching_history", version: "0.1.0" });
      return client;
    })().catch((error) => {
      this.child?.kill();
      this.ready = undefined;
      throw error;
    }));
  }
  async list(search: string, cursor?: string) {
    const page = await (await this.connect()).call(
      "thread/list",
      {
        limit: 30,
        cursor,
        searchTerm: search || undefined,
        sortKey: "updated_at",
      },
      threadPage,
    );
    return {
      conversations: page.data.map((v) => this.metadata(v)),
      before: page.nextCursor || undefined,
    };
  }
  private metadata(thread: Thread): Conversation {
    const providerId = thread.id;
    return {
      id: `codex:${providerId}`,
      providerId,
      source: "codex",
      cli: "codex",
      title: this.clean(thread.name || thread.preview || "Codex session", 160),
      project: this.clean(basename(thread.cwd), 180),
      updatedAt: thread.updatedAt * 1000,
      model: thread.model || undefined,
      effort: thread.reasoningEffort || undefined,
      // A separate app-server cannot verify another process's runtime status.
      status: "unknown",
    };
  }
  async read(id: string) {
    const result = await (await this.connect()).call(
      "thread/read",
      { threadId: id, includeTurns: false },
      threadRead,
    );
    if (result.thread.id !== id)
      throw new Error("Codex returned an unexpected session identity");
    return this.metadata(result.thread);
  }
  async page(id: string, cursor?: string, limit = 60): Promise<TimelinePage> {
    const page = await (await this.connect()).call(
      "thread/items/list",
      {
        threadId: id,
        cursor,
        limit: Math.max(1, Math.min(60, limit)),
        sortDirection: "desc",
      },
      itemPage,
    );
    return {
      before: page.nextCursor || undefined,
      latestRun: page.data[0]?.turnId ?? "",
      items: page.data
        .reverse()
        .flatMap((row) => {
          const item = row.item;
          let kind: TimelineItem["kind"],
            text = "",
            placeholder = false;
          switch (item.type) {
            case "userMessage":
              kind = "prompt";
              text = item.content
                .map((c) => (c.type === "text" ? c.text : ""))
                .join("\n");
              break;
            case "agentMessage":
              kind = "message";
              text = item.text;
              break;
            case "plan":
              kind = "summary";
              text = item.text;
              break;
            case "reasoning":
              kind = "summary";
              text = item.summary.join("\n");
              break;
            case "commandExecution":
              kind = "command";
              text = `Command: ${commandName(item.command)} (${item.status || "recorded"})`;
              break;
            case "fileChange":
              kind = "edit";
              text = "Files edited";
              placeholder = true;
              break;
            case "webSearch":
              kind = "web";
              text = item.query.trim()
                ? `Searched the web: ${item.query.trim()}`
                : "Searched the web";
              break;
            case "mcpToolCall":
            case "dynamicToolCall":
            case "collabAgentToolCall":
              kind = "tool";
              text = "Recorded tool activity";
              placeholder = true;
              break;
            default:
              return [];
          }
          // Only explicitly selected text fields are exported; never outputs, raw arguments or private paths.
          return text && item.id
            ? [
                {
                  id: item.id,
                  run: row.turnId,
                  at: row.startedAtMs || row.completedAtMs || 0,
                  kind,
                  text:
                    this.clean(text, 16000) +
                    (text.length > 16000
                      ? "\n\n[Display excerpt; full text remains in the original Codex session.]"
                      : ""),
                  // The text stays for older clients; current ones key off the flag.
                  ...(placeholder && { placeholder: true as const }),
                },
              ]
            : [];
        }),
    };
  }
  close() {
    this.child?.kill();
  }
}

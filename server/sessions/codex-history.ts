import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  Conversation,
  TimelineItem,
  TimelinePage,
} from "../../shared/sessions.js";
import { commandName } from "../activity.js";
import { basename } from "node:path";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === "object" ? (value as RecordValue) : {};
const string = (value: unknown) => (typeof value === "string" ? value : "");
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

// This client has no start/resume/turn methods. It reads through the installed CLI API only.
export class CodexHistory {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private next = 0;
  private pending = new Map<
    number,
    {
      resolve(value: RecordValue): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
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
      const fail = () => {
        if (this.child !== child) return;
        this.child = undefined;
        this.ready = undefined;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(
            new Error(
              "Codex history disconnected. Check the installed CLI and retry.",
            ),
          );
        }
        this.pending.clear();
      };
      child.stderr.resume();
      child.on("error", fail);
      child.on("close", fail);
      // Raw provider responses never leave this client or enter public transport.
      const receive = (line: string) => {
        if (line.length > 4_000_000) {
          child.kill();
          return;
        }
        try {
          const message = record(JSON.parse(line));
          const p =
            typeof message.id === "number"
              ? this.pending.get(message.id)
              : undefined;
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(message.id as number);
            message.error
              ? p.reject(
                  new Error(
                    "Installed Codex does not support this history request. Update the CLI or use a managed session.",
                  ),
                )
              : p.resolve(record(message.result));
          } else if (message.id !== undefined && message.method) {
            child.stdin.write(
              JSON.stringify({
                id: message.id,
                error: { code: -32601, message: "Read-only history client" },
              }) + "\n",
            );
          }
        } catch {
          child.kill();
        }
      };
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          receive(line);
        }
        if (buffer.length > 4_000_000) child.kill();
      });
      await this.call("initialize", {
        clientInfo: { name: "twitching_history", version: "0.1.0" },
      });
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    })().catch((error) => {
      this.child?.kill();
      this.ready = undefined;
      throw error;
    }));
  }
  private call(method: string, params: unknown = {}): Promise<RecordValue> {
    return new Promise((resolve, reject) => {
      const id = this.next++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            "Codex history request timed out. Retry after checking the CLI.",
          ),
        );
        this.child?.kill();
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(
        JSON.stringify({ id, method, params }) + "\n",
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(new Error("Codex history pipe closed"));
          }
        },
      );
    });
  }
  async list(search: string, cursor?: string) {
    await this.connect();
    const page = await this.call("thread/list", {
      limit: 30,
      cursor,
      searchTerm: search || undefined,
      sortKey: "updated_at",
    });
    return {
      conversations: array(page.data).map((v) => this.metadata(record(v))),
      before: string(page.nextCursor) || undefined,
    };
  }
  private metadata(thread: RecordValue): Conversation {
    const providerId = string(thread.id);
    return {
      id: `codex:${providerId}`,
      providerId,
      source: "codex",
      cli: "codex",
      title: this.clean(
        string(thread.name) || string(thread.preview) || "Codex session",
        160,
      ),
      project: this.clean(basename(string(thread.cwd)), 180),
      updatedAt: Number(thread.updatedAt || 0) * 1000,
      model: string(thread.model) || undefined,
      // A separate app-server cannot verify another process's runtime status.
      status: "unknown",
    };
  }
  async read(id: string) {
    await this.connect();
    const result = await this.call("thread/read", {
      threadId: id,
      includeTurns: false,
    });
    if (string(record(result.thread).id) !== id)
      throw new Error("Codex returned an unexpected session identity");
    return this.metadata(record(result.thread));
  }
  async page(id: string, cursor?: string, limit = 60): Promise<TimelinePage> {
    await this.connect();
    const page = await this.call("thread/items/list", {
      threadId: id,
      cursor,
      limit: Math.max(1, Math.min(60, limit)),
      sortDirection: "desc",
    });
    return {
      before: string(page.nextCursor) || undefined,
      latestRun: string(record(array(page.data)[0]).turnId),
      items: array(page.data)
        .reverse()
        .flatMap((entry) => {
          const row = record(entry),
            item = record(row.item);
          let kind: TimelineItem["kind"],
            text = "",
            placeholder = false;
          switch (item.type) {
            case "userMessage":
              kind = "prompt";
              text = array(item.content)
                .map((v) => {
                  const c = record(v);
                  return c.type === "text" ? string(c.text) : "";
                })
                .join("\n");
              break;
            case "agentMessage":
              kind = "message";
              text = string(item.text);
              break;
            case "plan":
              kind = "summary";
              text = string(item.text);
              break;
            case "reasoning":
              kind = "summary";
              text = array(item.summary).map(string).join("\n");
              break;
            case "commandExecution":
              kind = "command";
              text = `Command: ${commandName(string(item.command))} (${string(item.status) || "recorded"})`;
              break;
            case "fileChange":
              kind = "edit";
              text = "Files edited";
              placeholder = true;
              break;
            case "mcpToolCall":
            case "dynamicToolCall":
            case "webSearch":
            case "collabAgentToolCall":
              kind = "tool";
              text = "Recorded tool activity";
              placeholder = true;
              break;
            default:
              return [];
          }
          // Only explicitly selected text fields are exported; never outputs, raw arguments or private paths.
          return text && string(item.id)
            ? [
                {
                  id: string(item.id),
                  run: string(row.turnId),
                  at: Number(row.startedAtMs || row.completedAtMs || 0),
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

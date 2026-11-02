import { lstat, open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { z } from "zod";
import type {
  Conversation,
  TimelineItem,
  TimelinePage,
} from "../../shared/sessions.js";
import { commandName, webActivityText } from "../activity.js";
import { projectRelativeName } from "../../shared/safe-file-name.js";

// Claude Code keeps each session as a JSONL transcript in
// <config>/projects/<cwd-slug>/<session-id>.jsonl. The format is internal to
// Claude Code and may change, so every row is read leniently and anything
// unrecognised is skipped. This reader only ever opens projects/*.jsonl: never
// .credentials.json, settings or any other file in the config directory, and
// never writes. Raw rows (tool inputs/outputs, paths) never leave this class.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 30;
const PROBE_BYTES = 256 * 1024;
// A transcript larger than this is shown from its most recent part only.
const MAX_READ = 32 * 1024 * 1024;

const text = z.string().catch("");
const block = z
  .object({
    type: text,
    text: text.optional(),
    thinking: text.optional(),
    name: text.optional(),
    input: z.unknown().optional(),
  })
  .passthrough()
  .catch({ type: "" });
const row = z
  .object({
    type: text,
    uuid: text,
    timestamp: text,
    cwd: text,
    summary: text,
    isMeta: z.boolean().catch(false),
    isSidechain: z.boolean().catch(false),
    // Assistant rows record the effort the turn ran at (low, medium, high, ...).
    effort: text,
    message: z
      .object({
        model: text,
        content: z.union([z.string(), z.array(block)]).catch(""),
      })
      .partial()
      .catch({}),
  })
  .partial();
type Row = z.output<typeof row>;

function parse(line: string): Row | undefined {
  if (!line.trim()) return undefined;
  try {
    const parsed = row.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
// Command echoes, reminders and injected context are recorded as user rows;
// only what the person typed counts as a prompt.
function promptText(r: Row) {
  if (r.type !== "user" || r.isMeta || r.isSidechain) return "";
  const content = r.message?.content;
  const value =
    typeof content === "string"
      ? content
      : (content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("\n");
  const trimmed = value.trim();
  if (/^<(command-|local-command|system-reminder|bash-|user-memory)/i.test(trimmed))
    return "";
  return trimmed;
}
const at = (r: Row) => Date.parse(r.timestamp ?? "") || 0;
// The file name of a Read inside the session's project folder. Files outside it,
// hidden files and credential-like names return undefined (same rule as the arena).
function readName(path: unknown, cwd: string | undefined) {
  return typeof path === "string" && cwd ? projectRelativeName(path, cwd) : undefined;
}
// A tool name as recorded (Read, Agent, mcp__server__tool); anything that is
// not a plain identifier is shown generically.
function toolName(name: string) {
  return /^[A-Za-z][A-Za-z0-9_-]{0,80}$/.test(name) ? name : "Tool";
}

interface Located {
  path: string;
  mtime: number;
}

export class ClaudeHistory {
  constructor(
    private clean: (text: string, limit?: number) => string,
    private configDir = process.env.CLAUDE_CONFIG_DIR || resolve(homedir(), ".claude"),
  ) {}
  private get projects() {
    return resolve(this.configDir, "projects");
  }
  // Every real transcript file, newest first. Links are never followed.
  private async transcripts(): Promise<Located[]> {
    const dirs = await readdir(this.projects, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const found: Located[] = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const folder = resolve(this.projects, dir.name);
      for (const file of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        if (!SESSION_ID.test(file.name.slice(0, -6))) continue;
        const path = resolve(folder, file.name);
        const info = await lstat(path).catch(() => undefined);
        if (info?.isFile()) found.push({ path, mtime: info.mtimeMs });
      }
    }
    return found.sort((a, b) => b.mtime - a.mtime);
  }
  private async locate(id: string) {
    if (!SESSION_ID.test(id)) throw new Error("Invalid Claude session ID");
    const match = (await this.transcripts()).find(
      (t) => basename(t.path, ".jsonl") === id,
    );
    if (!match) throw new Error("Claude session not found");
    return match;
  }
  // Reads the first and last part of a transcript; complete lines only.
  private async probe(path: string) {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const read = async (position: number, length: number) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        return buffer.subarray(0, bytesRead).toString("utf8");
      };
      const head = (await read(0, Math.min(size, PROBE_BYTES))).split("\n");
      if (size > PROBE_BYTES) head.pop();
      let tail: string[] = [];
      if (size > PROBE_BYTES) {
        tail = (await read(size - PROBE_BYTES, PROBE_BYTES)).split("\n");
        tail.shift();
      }
      return { head: head.flatMap((l) => parse(l) ?? []), tail: tail.flatMap((l) => parse(l) ?? []) };
    } finally {
      await handle.close();
    }
  }
  private async metadata(located: Located): Promise<Conversation> {
    const providerId = basename(located.path, ".jsonl");
    const { head, tail } = await this.probe(located.path);
    const rows = [...head, ...tail];
    const summary = [...rows].reverse().find((r) => r.type === "summary" && r.summary)?.summary;
    const prompt = head.map(promptText).find(Boolean);
    const cwd = rows.find((r) => r.cwd)?.cwd ?? "";
    const latest = [...rows]
      .reverse()
      .find((r) => r.type === "assistant" && r.message?.model && r.message.model !== "<synthetic>");
    const model = latest?.message?.model;
    // Only a short level name is shown; anything else in the field is ignored.
    const effort = /^[a-z]{1,16}$/.test(latest?.effort ?? "") ? latest!.effort : undefined;
    return {
      id: `claude:${providerId}`,
      providerId,
      source: "claude",
      cli: "claude",
      title: this.clean(summary || prompt?.split("\n")[0] || "Claude Code session", 160),
      project: this.clean(basename(cwd), 180),
      updatedAt: Math.round(located.mtime),
      model: model || undefined,
      effort,
      // Another Claude process's runtime state cannot be verified from its file.
      status: "unknown",
    };
  }
  async list(search: string, cursor?: string) {
    const before = cursor ? Number(cursor) : Infinity;
    if (cursor && !Number.isFinite(before)) throw new Error("Invalid history cursor");
    const needle = search.trim().toLowerCase();
    const conversations: Conversation[] = [];
    let last: number | undefined;
    for (const located of await this.transcripts()) {
      if (located.mtime >= before) continue;
      last = located.mtime;
      const conversation = await this.metadata(located).catch(() => undefined);
      if (!conversation) continue;
      if (
        needle &&
        !`${conversation.title} ${conversation.project}`.toLowerCase().includes(needle)
      )
        continue;
      conversations.push(conversation);
      if (conversations.length === PAGE) break;
    }
    return {
      conversations,
      before: conversations.length === PAGE && last !== undefined ? String(last) : undefined,
    };
  }
  async read(id: string) {
    return this.metadata(await this.locate(id));
  }
  async page(id: string, cursor?: string, limit = 60): Promise<TimelinePage> {
    const located = await this.locate(id);
    const handle = await open(located.path, "r");
    let raw: string;
    try {
      const { size } = await handle.stat();
      if (size <= MAX_READ) raw = await readFile(handle, "utf8");
      else {
        const buffer = Buffer.alloc(MAX_READ);
        await handle.read(buffer, 0, MAX_READ, size - MAX_READ);
        raw = buffer.toString("utf8").split("\n").slice(1).join("\n");
      }
    } finally {
      await handle.close();
    }
    const items: TimelineItem[] = [];
    let run = "";
    for (const r of raw.split("\n").flatMap((l) => parse(l) ?? [])) {
      if (r.isSidechain || !r.uuid) continue;
      const prompt = promptText(r);
      if (prompt) {
        run = r.uuid;
        items.push({ id: r.uuid, run, at: at(r), kind: "prompt", text: prompt });
        continue;
      }
      if (r.type !== "assistant" || !Array.isArray(r.message?.content)) continue;
      r.message.content.forEach((b, index) => {
        const id = `${r.uuid}:${index}`;
        const base = { id, run, at: at(r) };
        if (b.type === "text" && b.text) items.push({ ...base, kind: "message", text: b.text });
        else if (b.type === "thinking" && b.thinking)
          items.push({ ...base, kind: "summary", text: b.thinking });
        else if (b.type === "tool_use") {
          const name = b.name ?? "tool";
          const input = (b.input ?? {}) as Record<string, unknown>;
          // Only the executable name of a command is shown, never its arguments or output.
          const web = webActivityText(name, input);
          const file = readName(input.file_path ?? input.notebook_path, r.cwd);
          if (name === "Bash")
            items.push({
              ...base,
              kind: "command",
              text: `Command: ${commandName(String(input.command ?? "shell"))} (recorded)`,
            });
          else if (web) items.push({ ...base, kind: "web", text: web });
          else if (name === "Read" && file)
            items.push({ ...base, kind: "read", text: `Read ${file}` });
          // The name of an edited file rides along as `file`; it is shown only with "Read file names".
          else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name))
            items.push({ ...base, kind: "edit", text: "Files edited", placeholder: true, ...(file && { file }) });
          // Each other tool gets its own row naming the tool (never its input),
          // so a run does not collapse into one "N tools used" row.
          else items.push({ ...base, kind: "tool", text: toolName(name) });
        }
      });
    }
    // Newest last; the cursor is the index of the oldest item already sent.
    const end = cursor ? Number(cursor) : items.length;
    if (!Number.isSafeInteger(end) || end < 0 || end > items.length)
      throw new Error("Invalid history cursor");
    const start = Math.max(0, end - Math.max(1, Math.min(60, limit)));
    return {
      before: start > 0 ? String(start) : undefined,
      latestRun: run,
      items: items.slice(start, end).map((item) => ({
        ...item,
        text:
          this.clean(item.text, 16000) +
          (item.text.length > 16000
            ? "\n\n[Display excerpt; full text remains in the original Claude Code session.]"
            : ""),
      })),
    };
  }
}

import { parseCliEvent, jsonObject, type CliEvent } from "./cli/events.js";
import { claudeProfileViolation } from "./claude-profile.js";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { safeFileName } from "../shared/safe-file-name.js";
import type {
  Activity,
  ActivityKind,
  ActivityLane,
  Agent,
  SessionId,
} from "../shared/types.js";
export class JsonLines {
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  // maxLine bounds memory for peers that never send a newline; an oversized
  // line (complete or still buffered) is dropped and reported as malformed.
  constructor(
    private receive: (event: Record<string, unknown>) => void,
    private malformed: () => void = () => {},
    private maxLine = Infinity,
  ) {}
  push(chunk: Buffer | string) {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.drain();
  }
  end() {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) this.parse(this.buffer);
    this.buffer = "";
  }
  private drain() {
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > this.maxLine) this.malformed();
      else this.parse(line);
    }
    if (this.buffer.length > this.maxLine) {
      this.buffer = "";
      this.malformed();
    }
  }
  private parse(line: string) {
    if (!line.trim()) return;
    try {
      const e: unknown = JSON.parse(line);
      const object = jsonObject(e);
      if (object) this.receive(object);
      else this.malformed();
    } catch {
      this.malformed();
    }
  }
}
// Events validated by parseValidatedCliEvent; receive() trusts these instead of
// running the zod schema a second time on every streamed line.
const validated = new WeakSet<object>();
export function parseValidatedCliEvent(value: unknown) {
  const event = parseCliEvent(value);
  if (event) validated.add(event);
  return event;
}
export class ActivityAdapter {
  successful = false;
  failure?: string;
  private seen = new Set<string>();
  private commandOutputs = new Map<string, string>();
  private cursorBuffer = "";
  private cursorMessage = 0;
  private thinkingBuffer = "";
  private thinkingMessage = 0;
  private claudeBlock = 0;
  private claudeTools = new Map<
    string,
    { name: string; args: Record<string, unknown> }
  >();
  private shown = new Map<string, string>();
  constructor(
    private agent: Agent,
    private round: number,
    private clean: (s: string, limit?: number, streaming?: boolean) => string,
    private emit: (e: Activity) => void,
    private now = Date.now,
    private session: SessionId = agent,
    private general = false,
  ) {}
  private publish(
    kind: ActivityKind,
    text: string,
    key: string,
    append = false,
  ) {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.emit(this.make(kind, this.clean(text, Infinity), key, { append }));
  }
  private make(
    kind: ActivityKind,
    text: string,
    key: string,
    extra: Pick<Activity, "append" | "publicFile" | "lane"> = {},
  ): Activity {
    return {
      id: `${this.round}:${this.session}:${key}`,
      round: this.round,
      agent: this.session,
      at: this.now(),
      kind,
      text,
      ...extra,
    };
  }
  private emitText(
    kind: ActivityKind,
    raw: string,
    key: string,
    done: boolean,
  ) {
    const next = this.clean(raw, Infinity, !done);
    const prev = this.shown.get(key) ?? "";
    if (!next || next === prev) return;
    this.shown.set(key, next);
    this.emit(this.make(kind, next, key));
  }
  // Raw values (replay, tests) are still validated; the runner's events were
  // validated once already by parseValidatedCliEvent.
  receive(value: unknown) {
    const e = value !== null && typeof value === "object" && validated.has(value)
      ? value as CliEvent : parseCliEvent(value);
    if (!e) return;
    // Exhaustive: a new CLI must add its own parser rather than fall through.
    switch (this.agent) {
      case "codex":
        return this.codex(e);
      case "cursor":
        return this.cursor(e);
      case "claude":
        return this.claude(e);
      default: {
        const unknown: never = this.agent;
        throw new Error(`No activity parser for ${String(unknown)}`);
      }
    }
  }
  private codex(e: CliEvent) {
    if (e.type === "turn.completed") {
      this.successful = true;
      this.publish(
        "complete",
        this.general ? "Agent finished" : "Agent finished; checking HTML",
        "turn.completed",
      );
    }
    if (e.type === "error" || e.type === "turn.failed") {
      this.failure = String(e.message ?? errorText(e.error) ?? "CLI error");
      this.publish("error", "CLI reported an error", `error:${this.failure}`);
    }
    const i = e.item;
    if (
      !i ||
      !["item.started", "item.updated", "item.completed"].includes(e.type)
    )
      return;
    const id = String(i.id);
    if (i.type === "agent_message" || i.type === "reasoning") {
      if (e.type !== "item.updated" && e.type !== "item.completed") return;
      // Redact the accumulated item, including credentials split across updates.
      this.emitText(
        i.type === "reasoning" ? "summary" : "message",
        String(i.text ?? ""),
        `${id}:text`,
        e.type === "item.completed",
      );
    } else if (i.type === "command_execution") {
      // Commands may embed file contents or credentials. Show the executable and action, not arguments.
      this.publish(
        "command",
        `${e.type === "item.completed" ? "Finished" : "Running"} command: ${commandName(String(i.command ?? "shell"))}${i.exit_code !== undefined ? ` (exit ${i.exit_code})` : ""}`,
        `${id}:${e.type}`,
      );
      const output = String(i.aggregated_output ?? "");
      if (output && this.commandOutputs.get(id) !== output) {
        this.commandOutputs.set(id, output);
        this.publish(
          "output",
          `Command produced ${output.length} characters of output (contents kept private)`,
          `${id}:output:${output.length}`,
        );
      }
      const command = String(i.command ?? "shell");
      this.track(
        "terminal",
        `${e.type === "item.completed" ? "done" : "running"} ${command}${i.exit_code !== undefined && i.exit_code !== null ? ` (exit ${i.exit_code})` : ""}`,
        `${id}:terminal:${e.type}`,
      );
    } else if (i.type === "file_change") {
      const paths = (i.changes ?? [])
        .map((c) =>
          String(c.path ?? "")
            .split("/")
            .pop(),
        )
        .filter(Boolean)
        .join(", ");
      this.publish(
        "edit",
        `File edit ${i.status ?? ""}: ${paths}`,
        `${id}:${e.type}`,
      );
      this.track("write", paths || "file", `${id}:write:${e.type}`);
    } else if (i.type === "web_search") {
      const query = String(i.query ?? "").trim();
      // The query usually arrives with completion; show it once it is known.
      this.publish(
        "web",
        query ? `Searched the web: ${query}` : "Searching the web",
        `${id}:web:${query ? "query" : "pending"}`,
      );
      this.track("tool", `web search ${i.status ?? ""}`.trim(), `${id}:tool:${e.type}`);
    } else if (["mcp_tool_call", "todo_list"].includes(i.type)) {
      const label = `${i.type.replaceAll("_", " ")} ${i.status ?? ""}`.trim();
      this.publish("tool", label, `${id}:${e.type}`);
      this.track("tool", label, `${id}:tool:${e.type}`);
    }
  }
  private cursor(e: CliEvent) {
    if (e.type === "system" && e.subtype === "init") {
      this.publish(
        "output",
        "Cursor CLI started; waiting for model output",
        "system:init",
      );
    } else if (e.type === "assistant") {
      const text = (e.message && typeof e.message === "object" ? e.message.content ?? [] : [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      // Assemble partial messages before redaction so a credential split across
      // chunks cannot be reconstructed by the public overlay.
      if (e.timestamp_ms !== undefined && e.model_call_id === undefined) {
        const key = `delta:${e.timestamp_ms}:${createHash("sha256").update(text).digest("hex")}`;
        if (!this.seen.has(key)) {
          this.seen.add(key);
          this.cursorBuffer += text;
          this.emitText(
            "message",
            this.cursorBuffer,
            `message:${this.cursorMessage}`,
            false,
          );
        }
      } else this.flushCursor();
    } else if (e.type === "thinking") {
      if (e.subtype === "completed") this.flushThinking();
      else if (e.subtype === "delta" && e.text) {
        this.thinkingBuffer += String(e.text);
        this.emitText(
          "summary",
          this.thinkingBuffer,
          `thinking:${this.thinkingMessage}`,
          false,
        );
      }
    } else if (e.type === "tool_call") {
      this.flushThinking();
      this.flushCursor();
      const tool = Object.keys(e.tool_call ?? {})[0] ?? "tool";
      const detail = e.tool_call?.[tool];
      const args = toolArgs(detail);
      const name = String(args.name ?? tool);
      const lane = classifyTool(name);
      const kind =
        lane === "write" ? "edit" : lane === "terminal" ? "command" : "tool";
      const path = String(args.path ?? "")
        .split("/")
        .pop();
      this.publish(
        kind,
        `${name} ${e.subtype ?? ""}${path ? ` · ${path}` : ""}`,
        `${e.call_id}:${e.subtype}`,
      );
      this.showWrittenHtml(String(e.call_id), name, args);
      this.trackTool(
        String(e.call_id ?? "tool"),
        name,
        args,
        String(e.subtype ?? ""),
      );
      // Read results and command output stay private. HTML writes are shown.
    } else if (e.type === "result") {
      this.flushThinking();
      this.flushCursor();
      this.successful = e.is_error === false && e.subtype === "success";
      if (!this.successful) this.failure = String(e.result ?? "Cursor failed");
      this.publish(
        this.successful ? "complete" : "error",
        this.successful
          ? this.general ? "Agent finished" : "Agent finished; checking HTML"
          : "CLI reported an error",
        "result",
      );
    } else if (e.type === "error") {
      this.failure = String(e.message ?? "Cursor error");
      this.publish("error", "CLI reported an error", "error");
    }
  }
  // Claude Code stream-json: one content block per assistant event, tool
  // results arrive on user events, and a final result event decides success.
  private claude(e: CliEvent) {
    const blocks =
      e.message && typeof e.message === "object" ? e.message.content ?? [] : [];
    if (e.type === "system" && e.subtype === "init") {
      const violation = claudeProfileViolation(e);
      if (violation) {
        this.failure = violation;
        this.publish("error", violation, "system:init");
      } else
        this.publish(
          "output",
          "Claude Code started; waiting for model output",
          "system:init",
        );
    } else if (e.type === "system" && e.subtype === "api_retry") {
      const kind = errorText(e.error) ?? "unknown";
      // Rate limits and overloads are retried by the CLI; only failures that
      // cannot recover by waiting stop the run. The wording feeds failureKind.
      if (kind === "authentication_failed")
        this.failure = "Claude subscription authentication failed";
      else if (kind === "billing_error")
        this.failure = "Claude usage limit reached";
      this.publish(
        this.failure ? "error" : "output",
        `Claude API retry (${kind})`,
        `api_retry:${kind}`,
      );
    } else if (e.type === "assistant") {
      for (const block of blocks) {
        const key = `block:${this.claudeBlock++}`;
        if (block.type === "text" && block.text)
          this.emitText("message", block.text, key, true);
        else if (block.type === "thinking" && block.thinking)
          this.emitText("summary", block.thinking, key, true);
        else if (block.type === "tool_use" && block.id) {
          const name = block.name ?? "tool";
          const args = claudeToolArgs(name, block.input);
          this.claudeTools.set(block.id, { name, args });
          this.claudeToolEvent(block.id, name, args, "started");
          this.showWrittenHtml(block.id, name, args);
        }
      }
    } else if (e.type === "user") {
      for (const block of blocks) {
        if (block.type !== "tool_result" || !block.tool_use_id) continue;
        const tool = this.claudeTools.get(block.tool_use_id) ?? {
          name: "tool",
          args: {},
        };
        // Tool output (file contents, command output) stays private.
        this.claudeToolEvent(
          block.tool_use_id,
          tool.name,
          tool.args,
          block.is_error ? "failed" : "completed",
        );
      }
    } else if (e.type === "result") {
      this.successful = e.subtype === "success" && e.is_error !== true;
      if (!this.successful)
        this.failure = String(
          (typeof e.result === "string" && e.result) ||
            claudeErrorText(e.errors) ||
            e.terminal_reason ||
            e.subtype ||
            "Claude Code failed",
        );
      this.publish(
        this.successful ? "complete" : "error",
        this.successful
          ? this.general ? "Agent finished" : "Agent finished; checking HTML"
          : "CLI reported an error",
        "result",
      );
    }
  }
  private claudeToolEvent(
    id: string,
    name: string,
    args: Record<string, unknown>,
    subtype: string,
  ) {
    const lane = claudeLane(name);
    const web = webActivityText(name, args);
    if (web) {
      // One row per search or fetch; a completed result adds nothing new.
      if (subtype !== "completed")
        this.publish("web", subtype === "failed" ? `${web} (failed)` : web, `${id}:${subtype}`);
      this.trackTool(id, name, args, subtype, lane);
      return;
    }
    const kind =
      lane === "write" ? "edit" : lane === "terminal" ? "command" : "tool";
    const path = String(args.path ?? "").split("/").pop();
    this.publish(kind, `${name} ${subtype}${path ? ` · ${path}` : ""}`, `${id}:${subtype}`);
    this.trackTool(id, name, args, subtype, lane);
  }
  // Public filenames are separate from host-only search strings and raw tool arguments.
  private track(
    lane: ActivityLane,
    text: string,
    key: string,
    publicFile?: string,
  ) {
    const shown = this.clean(text, Infinity).trim();
    if (!shown || this.seen.has(key)) return;
    this.seen.add(key);
    this.emit(this.make("command", shown, key, { publicFile, lane }));
  }
  private trackTool(
    callId: string,
    tool: string,
    args: Record<string, unknown>,
    subtype: string,
    knownLane?: ActivityLane,
  ) {
    const name = String(args.name ?? tool);
    const rawPath = String(
      args.path ?? args.target_file ?? args.file_path ?? args.file ?? "",
    );
    const path = rawPath.split("/").pop();
    const publicFile = this.general ? safeFileName(rawPath) : [
      `prompt_${this.round}.html`,
      `/workspace/prompt_${this.round}.html`,
    ].includes(rawPath)
      ? `prompt_${this.round}.html`
      : undefined;
    const pattern = String(
      args.pattern ?? args.glob ?? args.glob_pattern ?? args.query ?? "",
    );
    const command = String(args.command ?? args.cmd ?? "");
    const lane = knownLane ?? classifyTool(name);
    let text = name;
    if (lane === "terminal") text = `${subtype || "running"} ${command || name}`;
    else if (lane === "write") text = path || name;
    else if (lane === "read") text = path || pattern || name;
    else if (path) text = `${name} ${path}`;
    this.track(
      lane,
      text,
      `${callId}:${lane}:${subtype || "once"}`,
      lane === "read" ? publicFile : undefined,
    );
  }
  private showWrittenHtml(
    callId: string,
    tool: string,
    args: Record<string, unknown>,
  ) {
    const name = String(args.name ?? tool);
    if (!/write|edit|replace/i.test(name) || /read/i.test(name)) return;
    const path = String(args.path ?? "");
    if (!/\.html?$/i.test(path.split("/").pop() ?? "")) return;
    const text = args.fileText ?? args.contents ?? args.new_string;
    if (typeof text !== "string" || !text) return;
    const key = `${callId}:html`;
    const redacted = this.clean(text, Infinity);
    const previous = this.shown.get(key);
    if (
      previous === redacted ||
      (previous && previous.length > redacted.length)
    )
      return;
    this.shown.set(key, redacted);
    this.emit(this.make("edit", redacted, key));
  }
  private flushThinking() {
    if (!this.thinkingBuffer) return;
    this.emitText(
      "summary",
      this.thinkingBuffer,
      `thinking:${this.thinkingMessage}`,
      true,
    );
    this.thinkingMessage++;
    this.thinkingBuffer = "";
  }
  private flushCursor() {
    if (!this.cursorBuffer) return;
    this.emitText(
      "message",
      this.cursorBuffer,
      `message:${this.cursorMessage}`,
      true,
    );
    this.cursorMessage++;
    this.cursorBuffer = "";
  }
}
// One Cursor tool-name classification for both the activity kind and the lane.
// It is the union of two sets that had drifted: shell-like names win, "replace"
// counts as a write, and a name mentioning "read" is never a write.
function classifyTool(name: string): ActivityLane {
  if (/shell|terminal|exec|bash/i.test(name)) return "terminal";
  if (/write|edit|replace|delete/i.test(name) && !/read/i.test(name)) return "write";
  if (/read|grep|glob|search/i.test(name)) return "read";
  return "tool";
}
// Claude Code names its built-in tools exactly; TodoWrite is a plan, not a file write.
function claudeLane(name: string): ActivityLane {
  if (name === "Bash" || name === "BashOutput" || name === "KillShell")
    return "terminal";
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name))
    return "write";
  if (["Read", "Grep", "Glob", "LS", "NotebookRead"].includes(name))
    return "read";
  return "tool";
}
// Public text for a Claude web tool, or undefined for any other tool. A search
// shows its query; a fetch shows host and path only, because query strings and
// fragments often carry tokens. Callers still pass the result through clean().
export function webActivityText(name: string, input: Record<string, unknown>) {
  if (name === "WebSearch") {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    return query ? `Searched the web: ${query}` : "Searched the web";
  }
  if (name === "WebFetch") return `Fetched ${publicUrl(input.url)}`;
  return undefined;
}
function publicUrl(value: unknown) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" && url.protocol !== "http:") return "a web page";
    return url.pathname === "/" ? url.host : `${url.host}${url.pathname}`;
  } catch {
    return "a web page";
  }
}
// Maps Claude tool input onto the argument names the shared tracking and
// HTML-publication helpers already read (path, contents, command, pattern).
function claudeToolArgs(name: string, input: unknown): Record<string, unknown> {
  const raw = jsonObject(input) ?? {};
  const args: Record<string, unknown> = { ...raw, name };
  const path = raw.file_path ?? raw.notebook_path ?? raw.path;
  if (typeof path === "string") args.path = path;
  if (typeof raw.content === "string") args.contents = raw.content;
  return args;
}
function claudeErrorText(errors: unknown[] | undefined) {
  const first = errors?.[0];
  if (typeof first === "string") return first;
  const message = jsonObject(first)?.message;
  return typeof message === "string" ? message : undefined;
}
function errorText(error: CliEvent["error"]) {
  if (typeof error === "string") return error;
  return error?.message;
}
function toolArgs(value: unknown): Record<string, unknown> {
  const detail = jsonObject(value) ?? {};
  let args = jsonObject(detail.args) ?? {};
  const parse = (text: unknown) => {
    if (typeof text !== "string") return {};
    try { return jsonObject(JSON.parse(text)) ?? {}; }
    catch { return {}; }
  };
  args = { ...args, ...parse(detail.arguments) };
  args = { ...args, ...parse(args.arguments) };
  if (typeof detail.name === "string" && detail.name) args = { ...args, name: detail.name };
  return args;
}
export function commandName(command: string) {
  const match = command.match(/(?:^|[;\s])([a-zA-Z][a-zA-Z0-9._-]*)(?=\s|$)/);
  return match?.[1] ?? "shell";
}

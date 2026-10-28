import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type {
  Activity,
  ActivityKind,
  ActivityLane,
  Agent,
} from "../shared/types.js";
export class JsonLines {
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  constructor(
    private receive: (event: any) => void,
    private malformed: () => void = () => {},
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
      this.parse(line);
    }
  }
  private parse(line: string) {
    if (!line.trim()) return;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object") this.receive(e);
    } catch {
      this.malformed();
    }
  }
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
  private shown = new Map<string, string>();
  constructor(
    private agent: Agent,
    private round: number,
    private clean: (s: string, limit?: number, streaming?: boolean) => string,
    private emit: (e: Activity) => void,
    private now = Date.now,
  ) {}
  private publish(
    kind: ActivityKind,
    text: string,
    key: string,
    append = false,
  ) {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.emit({
      id: `${this.round}:${this.agent}:${key}`,
      round: this.round,
      agent: this.agent,
      at: this.now(),
      kind,
      text: this.clean(text, Infinity),
      append,
    });
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
    this.emit({
      id: `${this.round}:${this.agent}:${key}`,
      round: this.round,
      agent: this.agent,
      at: this.now(),
      kind,
      text: next,
    });
  }
  receive(e: any) {
    if (this.agent === "codex") this.codex(e);
    else this.cursor(e);
  }
  private codex(e: any) {
    if (e.type === "turn.completed") {
      this.successful = true;
      this.publish(
        "complete",
        "Agent finished; checking HTML",
        "turn.completed",
      );
    }
    if (e.type === "error" || e.type === "turn.failed") {
      this.failure = String(e.message ?? e.error?.message ?? "CLI error");
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
        .map((c: any) =>
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
    } else if (["mcp_tool_call", "web_search", "todo_list"].includes(i.type)) {
      const label = `${i.type.replaceAll("_", " ")} ${i.status ?? ""}`.trim();
      this.publish("tool", label, `${id}:${e.type}`);
      this.track("tool", label, `${id}:tool:${e.type}`);
    }
  }
  private cursor(e: any) {
    if (e.type === "system" && e.subtype === "init") {
      this.publish(
        "output",
        "Cursor CLI started; waiting for model output",
        "system:init",
      );
    } else if (e.type === "assistant") {
      const text = (e.message?.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text ?? "")
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
      const kind = /write|edit|delete/i.test(name)
        ? "edit"
        : /shell|terminal|exec|bash/i.test(name)
          ? "command"
          : "tool";
      const path = String(args.path ?? "")
        .split("/")
        .pop();
      this.publish(
        kind,
        `${name} ${e.subtype ?? ""}${path ? ` · ${path}` : ""}`,
        `${e.call_id}:${e.subtype}`,
      );
      this.showWrittenHtml(String(e.call_id), name, args);
      this.trackCursorTool(
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
          ? "Agent finished; checking HTML"
          : "CLI reported an error",
        "result",
      );
    } else if (e.type === "error") {
      this.failure = String(e.message ?? "Cursor error");
      this.publish("error", "CLI reported an error", "error");
    }
  }
  private track(lane: ActivityLane, text: string, key: string) {
    const shown = this.clean(text, Infinity).trim();
    if (!shown || this.seen.has(key)) return;
    this.seen.add(key);
    this.emit({
      id: `${this.round}:${this.agent}:${key}`,
      round: this.round,
      agent: this.agent,
      at: this.now(),
      kind: "command",
      text: shown,
      lane,
    });
  }
  private trackCursorTool(
    callId: string,
    tool: string,
    args: Record<string, unknown>,
    subtype: string,
  ) {
    const name = String(args.name ?? tool);
    const path = String(
      args.path ?? args.target_file ?? args.file_path ?? args.file ?? "",
    )
      .split("/")
      .pop();
    const pattern = String(
      args.pattern ?? args.glob ?? args.glob_pattern ?? args.query ?? "",
    );
    const command = String(args.command ?? args.cmd ?? "");
    let lane: ActivityLane = "tool";
    let text = name;
    if (/shell|terminal|exec|bash/i.test(name)) {
      lane = "terminal";
      text = `${subtype || "running"} ${command || name}`;
    } else if (/write|edit|replace|delete/i.test(name) && !/read/i.test(name)) {
      lane = "write";
      text = path || name;
    } else if (/read|grep|glob|search/i.test(name)) {
      lane = "read";
      text = path || pattern || name;
    } else if (path) text = `${name} ${path}`;
    this.track(lane, text, `${callId}:${lane}:${subtype || "once"}`);
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
    if (previous === redacted || (previous && previous.length > redacted.length))
      return;
    this.shown.set(key, redacted);
    this.emit({
      id: `${this.round}:${this.agent}:${key}`,
      round: this.round,
      agent: this.agent,
      at: this.now(),
      kind: "edit",
      text: redacted,
    });
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
function toolArgs(detail: any): Record<string, unknown> {
  let args = detail?.args ?? {};
  if (typeof detail?.arguments === "string") {
    try {
      args = { ...args, ...JSON.parse(detail.arguments) };
    } catch {
      /* The label still shows the tool name when arguments are not JSON. */
    }
  }
  if (typeof args.arguments === "string") {
    try {
      args = { ...args, ...JSON.parse(args.arguments) };
    } catch {
      /* Keep the structured args. */
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
  if (typeof detail?.name === "string" && detail.name)
    args = { ...args, name: detail.name };
  return args;
}
function commandName(command: string) {
  const match = command.match(/(?:^|[;\s])([a-zA-Z][a-zA-Z0-9._-]*)(?=\s|$)/);
  return match?.[1] ?? "shell";
}

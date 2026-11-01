import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { JsonLines } from "./activity.js";

// Caller-facing error texts. Raw provider errors never leave this client.
interface CodexAppServerMessages {
  rejected: string; // the server answered with a JSON-RPC error
  closed: string; // the process exited before answering
  failed?: string; // the process could not start (defaults to closed)
  pipe?: string; // a request could not be written (defaults to closed)
  timeout(method: string): string;
  refused: string; // reply text for server-initiated requests
}
interface CodexAppServerOptions {
  messages: CodexAppServerMessages;
  timeoutMs?: number;
  maxLine?: number;
  onClose?: () => void;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

// Minimal client for `codex app-server` (newline-delimited JSON-RPC over stdio).
// It only issues requests; every server-initiated request is refused.
export class CodexAppServerClient {
  private next = 0;
  private pending = new Map<number, Pending>();
  private closed = false;
  private messages: CodexAppServerMessages;
  private timeoutMs: number;
  constructor(
    private child: ChildProcessWithoutNullStreams,
    options: CodexAppServerOptions,
  ) {
    this.messages = options.messages;
    this.timeoutMs = options.timeoutMs ?? 15000;
    // A malformed or oversized line means the stream can no longer be trusted.
    const lines = new JsonLines(
      (message) => this.receive(message),
      () => child.kill(),
      options.maxLine ?? 4_000_000,
    );
    child.stdout.on("data", (chunk: Buffer) => lines.push(chunk));
    child.stderr.resume();
    const fail = (message: string) => {
      if (this.closed) return;
      this.closed = true;
      this.rejectAll(message);
      options.onClose?.();
    };
    child.on("error", () => fail(this.messages.failed ?? this.messages.closed));
    child.on("close", () => fail(this.messages.closed));
  }
  async initialize(clientInfo: { name: string; version: string }) {
    await this.call("initialize", { clientInfo }, z.unknown());
    this.send({ method: "initialized" });
  }
  call<S extends z.ZodType>(
    method: string,
    params: unknown,
    schema: S,
  ): Promise<z.output<S>> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error(this.messages.closed));
      const id = this.next++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(this.messages.timeout(method)));
        this.child.kill();
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          const parsed = schema.safeParse(value);
          if (parsed.success) resolve(parsed.data);
          else reject(new Error(`Codex returned an unexpected ${method} response`));
        },
        reject,
        timer,
      });
      this.send({ id, method, params }, () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(new Error(this.messages.pipe ?? this.messages.closed));
      });
    });
  }
  private send(message: object, onError?: () => void) {
    this.child.stdin.write(JSON.stringify(message) + "\n", (error) => {
      if (error) onError?.();
    });
  }
  private receive(message: Record<string, unknown>) {
    const id = message.id;
    const request = typeof id === "number" ? this.pending.get(id) : undefined;
    if (request) {
      clearTimeout(request.timer);
      this.pending.delete(id as number);
      if (message.error) request.reject(new Error(this.messages.rejected));
      else request.resolve(message.result);
    } else if (id !== undefined && message.method)
      this.send({ id, error: { code: -32601, message: this.messages.refused } });
  }
  private rejectAll(message: string) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    this.pending.clear();
  }
}

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Activity, Agent } from "../shared/types.js";
import { sandboxPromptPath } from "./sandbox-results.js";

// One replacement hunk keeps the comparison linear even for large HTML files.
export function fileDiff(before: string, after: string, name: string) {
  if (before === after) return "";
  const oldLines = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const newLines = after.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let start = 0;
  while (start < oldLines.length && start < newLines.length &&
    oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const removed = oldEnd - start;
  const added = newEnd - start;
  const showLine = (line: string, sign: string) =>
    `${sign}${line.endsWith("\n") ? line.slice(0, -1) : line}\n${line.endsWith("\n") ? "" : "\\ No newline at end of file\n"}`;
  return `--- ${name}\n+++ ${name}\n@@ -${removed ? start + 1 : start},${removed} +${added ? start + 1 : start},${added} @@\n` +
    oldLines.slice(start, oldEnd).map((line) => showLine(line, "-")).join("") +
    newLines.slice(start, newEnd).map((line) => showLine(line, "+")).join("");
}

export class HtmlDiffs {
  private previous = "";
  private pending = Promise.resolve();
  private sequence = 0;
  private warned = false;
  constructor(
    private dir: string,
    private round: number,
    private agent: Agent,
    private clean: (text: string, limit?: number) => string,
    private emit: (event: Activity) => void,
  ) {}
  private async read() {
    // Never follow CLI-reported paths or inspect private CLI homes.
    const path = await sandboxPromptPath(this.dir, this.round, false);
    if (!path) return "";
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error("Unsafe output file");
      return this.clean(await file.readFile("utf8"), Infinity);
    } finally {
      await file.close();
    }
  }
  async begin() {
    try {
      this.previous = await this.read();
    } catch {
      this.warn();
    }
  }
  capture() {
    this.pending = this.pending.then(async () => {
      try {
        const next = await this.read();
        const text = fileDiff(this.previous, next, `prompt_${this.round}.html`);
        this.previous = next;
        if (!text) return;
        const id = `${this.round}:${this.agent}:diff:${this.sequence++}`;
        this.emit({ id, agent: this.agent, round: this.round, at: Date.now(),
          kind: "edit", text, diff: true });
        this.emit({ id: `${id}:write`, agent: this.agent, round: this.round,
          at: Date.now(), kind: "edit", text, lane: "write", diff: true });
      } catch {
        this.warn();
      }
    });
    return this.pending;
  }
  private warn() {
    if (this.warned) return;
    this.warned = true;
    this.emit({ id: `${this.round}:${this.agent}:diff-unavailable`,
      agent: this.agent, round: this.round, at: Date.now(), kind: "output",
      text: "HTML diff unavailable; agent activity continues" });
  }
}

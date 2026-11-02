import { randomBytes } from "node:crypto";
import type { ChatMessage } from "../shared/types.js";
import type { ChatPlatform } from "../shared/settings.js";
import { isPromptText, type Filter } from "./filter.js";

// Every chat comment the platforms deliver, kept in memory only so a restart
// forgets viewer text. Rounds do not need to be running for a comment to appear.
const LIMIT = 300;

export type BlockedMode = "mask" | "hide";
export interface FeedSettings {
  // Opt-in, default off: while off nothing is stored or served, and turning it off clears the buffer.
  enabled: boolean;
  // Default on: listed words never reach the OBS page or the host panel unmasked.
  hideBlocked: boolean;
  // "mask" bullets the word; "hide" drops the whole comment.
  mode: BlockedMode;
}
export interface FeedEntry {
  id: string;
  platform: ChatPlatform;
  author: string;
  text: string;
  timestamp: number;
  prompt: boolean;
}
export interface FeedStatus {
  platform: ChatPlatform;
  // Credentials for this platform are present in the environment.
  configured: boolean;
  // Connection status reported by the controller, e.g. Connected or Skipped.
  status: string;
}
export interface FeedView {
  entries: FeedEntry[];
  cursor: number;
  // Changes on every server start and every settings change. A client whose rev differs
  // must drop what it has: `reset` is true and `entries` is the full current view.
  rev: string;
  reset: boolean;
  // Ids of feed comments Jev kept for the round being collected, refreshed on every poll.
  selected: string[];
  settings: FeedSettings;
  platforms: FeedStatus[];
}
interface Stored {
  seq: number;
  message: ChatMessage;
}

export class ChatFeed {
  settings: FeedSettings = { enabled: false, hideBlocked: true, mode: "hide" };
  private items: Stored[] = [];
  private seq = 0;
  private epoch = randomBytes(4).toString("hex");
  private changes = 0;
  constructor(
    private filter: Filter,
    // Message ids Jev kept for the round being collected.
    private selectedIds: () => Set<string> = () => new Set(),
  ) {}
  private get rev() {
    return `${this.epoch}.${this.changes}`;
  }
  add(message: ChatMessage) {
    if (!this.settings.enabled) return;
    if (this.items.some((i) => i.message.platform === message.platform && i.message.id === message.id)) return;
    this.items.push({ seq: ++this.seq, message });
    if (this.items.length > LIMIT) this.items.splice(0, this.items.length - LIMIT);
  }
  update(patch: Partial<FeedSettings>) {
    this.settings = { ...this.settings, ...patch };
    this.changes++;
    if (!this.settings.enabled) this.items = [];
  }
  // What a viewer of the feed may see, or undefined when the comment must stay hidden.
  // Author names go through the same rules as the text.
  private visible(message: ChatMessage): { author: string; text: string } | undefined {
    const show = (value: string) => {
      if (!this.settings.hideBlocked || !this.filter.blocked(value)) return value;
      if (this.settings.mode === "hide") return undefined;
      const masked = this.filter.mask(value);
      return masked.clean ? masked.text : undefined;
    };
    const text = show(message.text);
    const author = show(message.author);
    return text === undefined || author === undefined ? undefined : { author, text };
  }
  view(
    platforms: FeedStatus[],
    options: { since?: number; rev?: string; only?: ChatPlatform[]; prompts?: boolean; limit?: number } = {},
  ): FeedView {
    // A different rev (restart or settings change) or a cursor from a previous run means
    // the client's copy is stale, so it gets everything again instead of a delta.
    const reset = options.rev !== this.rev || (options.since ?? 0) > this.seq;
    const since = reset ? undefined : options.since;
    const entries: FeedEntry[] = [];
    const ids = new Set<string>();
    for (const { seq, message } of this.items) {
      if (since !== undefined && seq <= since) continue;
      if (options.only && !options.only.includes(message.platform)) continue;
      const prompt = isPromptText(message.text);
      if (options.prompts && !prompt) continue;
      const shown = this.visible(message);
      if (!shown) continue;
      entries.push({ id: message.id, platform: message.platform, author: shown.author, text: shown.text, timestamp: message.timestamp, prompt });
    }
    const selected = this.selectedIds();
    for (const { message } of this.items) if (selected.has(message.id) && this.visible(message)) ids.add(message.id);
    return {
      entries: entries.slice(-(options.limit ?? 100)),
      cursor: this.seq,
      rev: this.rev,
      reset,
      selected: [...ids],
      settings: this.settings,
      platforms,
    };
  }
  // A host-sent prompt gets a fresh id, because the original id was already marked seen.
  // A comment the feed hides cannot be sent either.
  asPrompt(platform: ChatPlatform, id: string): ChatMessage | undefined {
    const original = this.items.find((i) => i.message.platform === platform && i.message.id === id)?.message;
    if (!original || !this.visible(original)) return undefined;
    const text = isPromptText(original.text) ? original.text : `!prompt ${original.text}`;
    return { ...original, id: `host-${randomBytes(8).toString("hex")}`, text, timestamp: Date.now() };
  }
}

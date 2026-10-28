import { createHash, randomUUID } from "node:crypto";
import type { Candidate, ChatMessage, Task } from "../shared/types.js";
import { Filter, rank } from "./filter.js";
import type { Judge } from "./jev.js";
import { Store } from "./store.js";
export interface CollectionOptions {
  jevCriteria?: string;
  collectionMs: number;
  extensionMs: number;
  safetyThreshold: number;
  relevanceThreshold: number;
  minScore: number;
}
export class Collection {
  window = Date.now();
  openedAt = Date.now();
  deadline: number;
  extended = false;
  prepared?: Task;
  selecting = false;
  pending = 0;
  candidates: Candidate[] = [];
  private latest = new Map<string, string>();
  private revision = 0;
  private closed = false;
  private criteria = "";
  private windowOptions: CollectionOptions;
  constructor(
    private filter: Filter,
    private judge: Judge,
    private store: Store,
    private options: CollectionOptions,
    private changed: () => void,
    private now = Date.now,
  ) {
    this.windowOptions = { ...options };
    // Capture a stable rubric for every candidate in this collection window.
    this.criteria = options.jevCriteria ?? "";
    this.judge.setCriteria?.(this.criteria);
    this.window = this.now();
    this.openedAt = this.now();
    this.deadline = this.now() + options.collectionMs;
  }
  reset() {
    this.windowOptions = { ...this.options };
    // Old evaluations remain stored, but a new rubric gets a different cache key.
    this.criteria = this.options.jevCriteria ?? "";
    this.judge.setCriteria?.(this.criteria);
    this.window++;
    this.openedAt = this.now();
    this.deadline = this.openedAt + this.windowOptions.collectionMs;
    this.extended = false;
    this.prepared = undefined;
    this.candidates = [];
    this.latest.clear();
    this.revision++;
    this.changed();
  }
  close() {
    this.closed = true;
    this.revision++;
  }
  async ingest(message: ChatMessage) {
    if (
      this.closed ||
      this.prepared ||
      message.timestamp < this.openedAt ||
      message.timestamp > this.now() + 30000
    )
      return;
    if (this.store.seen(`${message.platform}:${message.id}`)) return;
    const filtered = this.filter.check(message);
    if ("error" in filtered) {
      this.store.decision(this.window, {
        rejectedMessage: message.id,
        reason: filtered.error,
      });
      return;
    }
    const viewer = `${message.platform}:${message.authorId}`;
    const earlier = this.candidates.find(
      (c) => `${c.message.platform}:${c.message.authorId}` === viewer,
    );
    if (earlier) {
      this.store.candidateStatus(earlier.id, "replaced");
      this.candidates = this.candidates.filter((c) => c.id !== earlier.id);
      this.revision++;
      this.changed();
    }
    const ticket = randomUUID();
    this.latest.set(viewer, ticket);
    if (
      this.candidates.some((c) => c.normalized === filtered.normalized) ||
      this.pending >= 100
    ) {
      this.store.decision(this.window, {
        rejectedMessage: message.id,
        reason: "Duplicate or evaluation queue full",
      });
      return;
    }
    const window = this.window;
    this.pending++;
    try {
      const cacheKey = createHash("sha256")
        .update(`rubric-v2:jev-latest:${this.criteria}:${filtered.normalized}`)
        .digest("hex");
      const evaluation =
        this.store.cache(cacheKey) ??
        (await this.judge.evaluate(filtered.text));
      this.store.cachePut(cacheKey, evaluation);
      if (
        this.closed ||
        window !== this.window ||
        this.prepared ||
        this.latest.get(viewer) !== ticket
      )
        return;
      if (
        evaluation.safety < this.options.safetyThreshold ||
        evaluation.relevance < this.options.relevanceThreshold
      ) {
        this.store.decision(window, {
          rejectedMessage: message.id,
          reason: "Jev safety or HTML relevance threshold failed",
        });
        return;
      }
      const candidate: Candidate = {
        id: `c_${ticket.replaceAll("-", "")}`,
        window,
        message,
        ...filtered,
        evaluation,
        score: rank(evaluation, message),
      };
      // Base suitability is required even for members and gifters.
      if (
        rank(evaluation, {
          ...message,
          membership: { verified: false, member: false, gift: false },
        }) < this.options.minScore
      ) {
        this.store.candidate(candidate, "low_score");
        return;
      }
      if (this.candidates.some((c) => c.normalized === candidate.normalized)) {
        this.store.candidate(candidate, "duplicate");
        return;
      }
      this.candidates.push(candidate);
      this.candidates.sort(
        (a, b) =>
          b.score - a.score || a.message.timestamp - b.message.timestamp,
      );
      for (const displaced of this.candidates.splice(30))
        this.store.candidate(displaced, "displaced");
      if (this.candidates.includes(candidate)) this.store.candidate(candidate);
      // New audience activity re-arms an idle window; the show waits for chat instead of inventing a task.
      if (!Number.isFinite(this.deadline))
        this.deadline = this.now() + this.windowOptions.collectionMs;
      this.revision++;
      this.changed();
    } catch {
      this.store.decision(window, {
        rejectedMessage: message.id,
        reason: "Jev unavailable; not admitted",
      });
    } finally {
      this.pending--;
    }
  }
  reject(id: string) {
    if (this.prepared?.candidateId === id) {
      this.prepared = undefined;
      this.deadline = this.now();
    }
    const candidate = this.candidates.find((c) => c.id === id);
    if (candidate)
      this.latest.set(
        `${candidate.message.platform}:${candidate.message.authorId}`,
        randomUUID(),
      );
    this.candidates = this.candidates.filter((c) => c.id !== id);
    this.store.candidateStatus(id, "host_rejected");
    this.revision++;
    this.changed();
  }
  async tick() {
    if (
      this.closed ||
      this.prepared ||
      this.selecting ||
      this.now() < this.deadline
    )
      return;
    this.selecting = true;
    const window = this.window;
    const snapshot = this.candidates.slice();
    let choice = "WAIT";
    try {
      choice = await this.judge.choose(snapshot);
    } catch {
      this.store.decision(window, {
        error: "Jev selection failed",
        action: "WAIT",
      });
    }
    if (this.closed || window !== this.window || this.prepared) {
      this.selecting = false;
      return;
    }
    this.store.decision(window, {
      choice,
      candidateIds: snapshot.map((c) => c.id),
      extended: this.extended,
    });
    const chosen = this.candidates.find((c) => c.id === choice);
    if (chosen) {
      this.prepared = {
        text: chosen.text,
        author: chosen.message.author,
        platform: chosen.message.platform,
        candidateId: chosen.id,
      };
      this.store.candidateStatus(chosen.id, "selected");
    } else if (!this.extended) {
      this.extended = true;
      this.deadline = this.now() + this.windowOptions.extensionMs;
    } else {
      // No audience prompt after the extension. Ask Jev for a surprise task to
      // keep the show going; if that fails, wait for new chat activity.
      try {
        const text = await this.judge.surprise();
        if (this.closed || window !== this.window || this.prepared) {
          this.selecting = false;
          return;
        }
        this.prepared = {
          text,
          author: "Jev surprise",
          platform: "fallback",
        };
        this.store.decision(window, { surprise: this.prepared });
      } catch {
        if (this.closed || window !== this.window) {
          this.selecting = false;
          return;
        }
        this.deadline = Number.POSITIVE_INFINITY;
        this.store.decision(window, {
          action: "collecting",
          reason: "No audience prompt and no surprise task; waiting for chat",
        });
      }
    }
    this.selecting = false;
    this.changed();
  }
}

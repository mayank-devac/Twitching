import { EventEmitter } from "node:events";
import { z } from "zod";
import type { Store } from "./store.js";
import type { ShowState } from "../shared/types.js";
import { elapsed, type Presentation } from "../shared/presentation.js";

export const presentationAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("hide") }).strict(),
  z.object({ action: z.literal("show") }).strict(),
  z.object({ action: z.literal("goal"), text: z.string().trim().max(160), show: z.boolean() }).strict(),
  z.object({ action: z.enum(["start", "pause", "reset"])}).strict(),
]);
type Action = z.infer<typeof presentationAction>;

// One durable owner keeps privacy separate from sessions, breaks and OBS scenes.
export class PresentationControls extends EventEmitter {
  private value: Presentation;
  constructor(private store: Store, private clean: (text: string, limit?: number) => string, private now = Date.now) {
    super();
    const saved = store.presentation();
    // A restarted server restores its last checkpoint paused; downtime is not timed.
    this.value = { hidden: false, goal: "", showGoal: true, elapsedMs: 0, ...saved, runningSince: undefined, serverNow: now() };
    this.checkpoint();
  }
  get() { return { ...this.value, serverNow: this.now() }; }
  act(input: Action) {
    const next = { ...this.value };
    const at = this.now();
    if (input.action === "hide") next.hidden = true;
    if (input.action === "show") next.hidden = false;
    if (input.action === "goal") { next.goal = this.clean(input.text.replace(/[\r\n\t]/g, " "), 160); next.showGoal = input.show; }
    if (input.action === "start" && next.runningSince === undefined) next.runningSince = at;
    if (input.action === "pause") { next.elapsedMs = elapsed(next, at); next.runningSince = undefined; }
    // Reset preserves running/paused mode and starts a new duration only on this explicit action.
    if (input.action === "reset") { next.elapsedMs = 0; if (next.runningSince !== undefined) next.runningSince = at; }
    this.store.savePresentation({ ...next, elapsedMs: elapsed(next, at), runningSince: undefined, serverNow: at });
    this.value = next;
    this.emit("state");
    return this.get();
  }
  checkpoint() {
    this.store.savePresentation({ ...this.get(), elapsedMs: elapsed(this.value, this.now()), runningSince: undefined });
  }
  publicSnapshot(base: ShowState): ShowState {
    const presentation = this.get();
    if (!presentation.hidden) return { ...base, presentation };
    // Construct an allowlist, rather than clearing known fields and risking future leaks.
    return { status: "paused", mode: base.mode, reason: "Back shortly", candidates: [], candidateCount: 0, events: [], connections: {}, checks: [], rehearsalComplete: false,
      presentation: { ...presentation, goal: "", showGoal: false, elapsedMs: 0, runningSince: undefined } };
  }
}

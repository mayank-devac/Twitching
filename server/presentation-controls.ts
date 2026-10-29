import { EventEmitter } from "node:events";
import { z } from "zod";
import type { Store } from "./store.js";
import type { ShowState } from "../shared/types.js";
import { elapsed, type Presentation, type SavedPresentation, type OutputPresentation, type PresentationSelection } from "../shared/presentation.js";

const outputId = z.string().regex(/^(default|[a-f0-9-]{36})$/);
export const presentationAction = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["hide", "show", "hide-all", "show-all"]), overlay: outputId.optional() }).strict(),
  z.object({ action: z.literal("goal"), text: z.string().trim().max(160), show: z.boolean(), overlay: outputId.optional(), source: z.enum(["own", "shared"]).optional() }).strict(),
  z.object({ action: z.enum(["start", "pause", "reset"]), overlay: outputId.optional(), source: z.enum(["own", "shared"]).optional() }).strict(),
  z.object({ action: z.literal("goal-source"), overlay: outputId, source: z.enum(["own", "shared"]) }).strict(),
]);
type Action = z.infer<typeof presentationAction>;
const empty = (): Presentation => ({ hidden: false, goal: "", showGoal: true, elapsedMs: 0, serverNow: 0 });
export class PresentationConflict extends Error {}

// Shared time and independent output records live in the existing atomic SQLite row.
export class PresentationControls extends EventEmitter {
  private value: SavedPresentation;
  constructor(private store: Store, private clean: (text: string, limit?: number) => string, private now = Date.now) {
    super();
    const saved = store.presentation();
    const outputs: Record<string, OutputPresentation> = Object.fromEntries(Object.entries(saved?.outputs ?? {}).map(([id, output]) => [id, { ...output, runningSince: undefined }]));
    // Existing outputs retain the former shared goal; newly created outputs start independent.
    if (!saved?.outputs) for (const id of ["default", ...(store.overlays()?.overlays.map((output) => output.id) ?? [])]) {
      outputs[id] ??= { ...empty(), source: "shared" };
    }
    this.value = { ...empty(), ...saved, outputs, revision: saved?.revision ?? 0, runningSince: undefined, serverNow: now() };
    this.checkpoint();
  }
  private assertOutput(id: string) {
    if (id !== "default" && !this.store.overlays()?.overlays.some((output) => output.id === id))
      throw new PresentationConflict("Overlay no longer exists. Reload Multiple overlays.");
  }
  private own(id: string): OutputPresentation {
    this.assertOutput(id);
    return this.value.outputs[id] ?? { ...empty(), source: "own" };
  }
  private clock(value: Presentation): Presentation {
    return { hidden: value.hidden, goal: value.goal, showGoal: value.showGoal, elapsedMs: value.elapsedMs, runningSince: value.runningSince, serverNow: this.now() };
  }
  get(overlay?: string): Presentation {
    if (!overlay) return this.clock(this.value);
    const own = this.own(overlay);
    const active = own.source === "shared" ? this.value : own;
    return { ...this.clock(active), hidden: this.value.hidden || own.hidden };
  }
  selection(id: string): PresentationSelection {
    const own = this.own(id);
    return { revision: this.value.revision, source: own.source, globalHidden: this.value.hidden, own: this.clock(own), value: this.get(id) };
  }
  selections() {
    return Object.fromEntries(["default", ...(this.store.overlays()?.overlays.map((output) => output.id) ?? [])].map((id) => [id, this.selection(id)]));
  }
  hasRunningClock() {
    return this.value.runningSince !== undefined || Object.entries(this.value.outputs).some(([id, output]) => output.runningSince !== undefined && (id === "default" || this.store.overlays()?.overlays.some((item) => item.id === id)));
  }
  act(input: Action) {
    if (input.overlay) this.assertOutput(input.overlay);
    const next = structuredClone(this.value);
    const at = this.now();
    const own = input.overlay ? (next.outputs[input.overlay] ??= { ...empty(), source: "own" }) : undefined;
    if (own && input.action !== "goal-source" && "source" in input && input.source && input.source !== own.source)
      throw new PresentationConflict("Goal source changed in another tab. Review this output's controls before saving.");
    const active = own?.source === "own" ? own : next;
    // Local Hide never changes publication assignments or another output's privacy.
    if (input.action === "hide") (own ?? next).hidden = true;
    if (input.action === "show") (own ?? next).hidden = false;
    if (input.action === "hide-all") next.hidden = true;
    if (input.action === "show-all") next.hidden = false;
    if (input.action === "goal-source" && own) own.source = input.source;
    if (input.action === "goal") {
      active.goal = this.clean(input.text.replace(/[\r\n\t]/g, " "), 160);
      active.showGoal = input.show;
    }
    if (input.action === "start" && active.runningSince === undefined) active.runningSince = at;
    if (input.action === "pause") { active.elapsedMs = elapsed(active, at); active.runningSince = undefined; }
    if (input.action === "reset") { active.elapsedMs = 0; if (active.runningSince !== undefined) active.runningSince = at; }
    next.revision++;
    this.persist(next, at);
    this.value = next;
    this.emit("state");
    return input.overlay ? this.selection(input.overlay) : this.get();
  }
  private persist(value: SavedPresentation, at: number) {
    const checkpoint = (clock: Presentation) => ({ ...clock, elapsedMs: elapsed(clock, at), runningSince: undefined, serverNow: at });
    const outputs = Object.fromEntries(Object.entries(value.outputs)
      .filter(([id]) => id === "default" || this.store.overlays()?.overlays.some((output) => output.id === id))
      .map(([id, output]) => [id, { ...checkpoint(output), source: output.source }]));
    this.store.savePresentation({ ...checkpoint(value), revision: value.revision, outputs });
  }
  checkpoint() { this.persist(this.value, this.now()); }
  publicSnapshot(base: ShowState, overlay = "default"): ShowState {
    let presentation: Presentation;
    try { presentation = this.get(overlay); }
    catch (error) {
      if (!(error instanceof PresentationConflict)) throw error;
      // A deleted output may still have an open browser source; leave it neutral.
      presentation = { ...empty(), hidden: true, serverNow: this.now() };
    }
    if (!presentation.hidden) return { ...base, presentation };
    // Only the effective goal/clock reaches an output; private maps never enter public payloads.
    return { status: "paused", mode: base.mode, reason: "Back shortly", candidates: [], candidateCount: 0, events: [], connections: {}, checks: [], rehearsalComplete: false,
      presentation: { ...presentation, goal: "", showGoal: false, elapsedMs: 0, runningSince: undefined } };
  }
}

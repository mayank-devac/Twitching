import type { ShowState } from "../shared/types.js";

// A manual timer never owns quota recovery, automatic resume or broadcast shutdown.
export class ManualBreakControls {
  transitioning = false;
  constructor(
    private show: {
      state(): ShowState;
      now(): number;
      busy(): boolean;
      roundOpen(): boolean;
      stopWork(): Promise<void>;
      persist(): void;
    },
  ) {}
  async request(durationMs: number, immediate: boolean) {
    const state = this.show.state();
    if (
      this.transitioning ||
      state.status === "stopped" ||
      state.breakKind === "quota" ||
      this.show.busy()
    )
      throw new Error(
        "Wait until the show is ready; quota breaks cannot be replaced",
      );
    if (
      !Number.isInteger(durationMs) ||
      durationMs < 10_000 ||
      durationMs > 3_600_000
    )
      throw new Error("Choose a break between 10 seconds and 60 minutes");
    if (state.manualBreak)
      throw new Error("A manual break is already scheduled");
    this.transitioning = true;
    try {
      if (immediate) {
        await this.show.stopWork();
        const latest = this.show.state();
        if (latest.breakKind === "quota" || latest.status === "stopped")
          throw new Error("Show changed while stopping; break was not started");
      }
      state.manualBreak = { durationMs };
      if (!this.show.roundOpen()) this.begin();
      else
        state.reason =
          "Manual break scheduled after this round and its results";
      this.show.persist();
    } finally {
      this.transitioning = false;
    }
  }
  // The absolute server deadline survives browser reloads; expiry always pauses the show.
  begin() {
    const state = this.show.state();
    const manual = state.manualBreak!;
    manual.deadline = this.show.now() + manual.durationMs;
    state.status = "break";
    state.breakKind = "manual";
    state.breakUntil = manual.deadline;
    state.reason =
      "Timed break. The show will pause when the timer ends; Resume checks quota.";
  }
}

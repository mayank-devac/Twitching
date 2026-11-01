import { createHash } from "node:crypto";
import type { QuickPreferences, SettingsDocument } from "../shared/settings.js";
import { publicActivity, historyView } from "./settings-view.js";
import { ManualBreakControls } from "./manual-break.js";
import { EventEmitter } from "node:events";
import type {
  Activity,
  Agent,
  SessionId,
  SessionConfig,
  ChatMessage,
  ShowState,
  Task,
} from "../shared/types.js";
import {
  configuredSessions,
  sessionLabel,
  sessionCount,
  type SessionCount,
} from "../shared/types.js";
import { Collection } from "./collection.js";
import { Filter } from "./filter.js";
import type { Judge } from "./jev.js";
import type { PairRunner, RunHandle } from "./runner.js";
import { Store } from "./store.js";
export interface ControllerOptions {
  jevCriteria?: string;
  mode: "live" | "rehearsal";
  runnerMode?: "docker" | "native";
  sessions?: SessionConfig[];
  singleAgent?: Agent;
  codexModel: string;
  codexEffort?: string;
  cursorModel: string;
  collectionMs: number;
  extensionMs: number;
  resultMs: number;
  reconnectLimitMs: number;
  quotaGraceMs: number;
  quotaPollMs: number;
  safetyThreshold: number;
  relevanceThreshold: number;
  minScore: number;
  playlist?: string[];
}
export type StopChoice =
  "chat-now" | "chat-after" | "stream-now" | "stream-after";
export type ChatPlatforms = {
  youtube?: boolean;
  twitch?: boolean;
  kick?: boolean;
};
export interface Integrations {
  start(): Promise<void>;
  startChats(platforms: ChatPlatforms): Promise<void>;
  stop(): void;
  preflight(): Promise<string[]>;
  stopBroadcast(): Promise<void>;
}
export class Controller extends EventEmitter {
  state: ShowState;
  collection: Collection;
  private handles?: Record<SessionId, RunHandle>;
  private busy = false;
  private launching = false;
  private lastQuota = 0;
  private checkingQuota = false;
  private ending = false;
  private switchingToSession = false;
  private arenaCleanupFailed = false;
  // The session owner prevents stale arena controls from restarting a different mode.
  arenaEnabled: () => boolean = () => true;

  get sessionReady() {
    return !this.arenaCleanupFailed && !this.switchingToSession && !this.busy && !this.ending &&
      !this.launching && !this.handles && !this.breaks.transitioning &&
      ["paused", "stopped"].includes(this.state.status) &&
      !Object.values(this.state.round?.attempts ?? {}).some((a) =>
        ["running", "validating"].includes(a.status));
  }

  // Pause scheduling first; only explicit cancellation may interrupt an active run.
  async leaveArena(choice?: "wait" | "cancel") {
    const active = !!(this.handles || this.launching || this.busy ||
      Object.values(this.state.round?.attempts ?? {}).some((a) =>
        ["running", "validating"].includes(a.status)));
    if (active && !choice && !this.switchingToSession)
      return "choice" as const;
    this.switchingToSession = true;
    this.pause("Switching to coding sessions; no new arena rounds will start");
    if (this.ending || this.breaks.transitioning || this.busy)
      return "waiting" as const;
    if (active && choice !== "cancel") return "waiting" as const;
    try {
      const stopped = await this.stop("Prompt arena stopped for coding sessions", false);
      if (!stopped) throw new Error("Arena cleanup failed. Retry switching before starting a session.");
      if (this.handles || Object.values(this.state.round?.attempts ?? {}).some((a) =>
        ["running", "validating"].includes(a.status))) return "waiting" as const;
      this.switchingToSession = false;
      return "ready" as const;
    } catch (error) {
      this.switchingToSession = false;
      throw error;
    }
  }
  private generation = 0;
  private launchSettled?: Promise<void>;
  private resumeAfterBreak = true;
  private playlistCursor = 0;
  private playlistReleased = false;
  private pendingStop?: "chat" | "stream";
  private pendingPlatforms: ChatPlatforms = {};
  // Cancellation remains owned by the controller; the helper owns only manual timing.
  private breaks = new ManualBreakControls({
    state: () => this.state,
    now: () => this.now(),
    busy: () => this.busy || this.ending,
    roundOpen: () => this.roundStillOpen(),
    persist: () => this.persist(),
    stopWork: async () => {
      this.pause("Stopping active work for a manual break");
      if (this.launchSettled) await this.launchSettled;
      if (this.handles)
        await Promise.all(
          Object.values(this.handles).map((h) => h.stop("cancelled")),
        );
      await this.runner.recover();
    },
  });
  private quick?: {
    get(): SettingsDocument;
    apply(value: QuickPreferences): void;
  };
  // One owner supplies durable preferences; the runner changes only at safe boundaries.
  configureQuick(quick: {
    get(): SettingsDocument;
    apply(value: QuickPreferences): void;
  }) {
    this.quick = quick;
    this.settingsChanged();
  }
  assertSettingsChange(value: QuickPreferences) {
    if (
      value.stream.mode !== this.state.mode &&
      (this.breaks.transitioning ||
        this.busy ||
        this.launching ||
        this.handles ||
        !["paused", "stopped"].includes(this.state.status))
    )
      throw new Error(
        "Pause and finish active work before changing rehearsal/live mode",
      );
  }
  settingsChanged() {
    const doc = this.quick?.get();
    if (!doc) return;
    // Collection reads pending timings/rubrics on reset, never halfway through a window.
    this.options.jevCriteria = doc.value.jevCriteria;
    this.options.collectionMs = doc.value.stream.collectionMs;
    this.options.extensionMs = doc.value.stream.extensionMs;
    this.options.resultMs = doc.value.stream.resultMs;
    if (this.state.mode !== doc.value.stream.mode) {
      this.integrations.stop();
      this.state.mode = doc.value.stream.mode;
      this.options.mode = doc.value.stream.mode;
    }
    this.persist();
  }
  private applyQuick() {
    const value = this.quick?.get().value;
    if (!value) return;
    this.options.sessions = structuredClone(value.sessions);
    this.quick!.apply(value);
  }
  // Compare the exact frozen prompt and window; a launched/replaced prompt cannot be edited.
  private preparedVersion() {
    return createHash("sha256")
      .update(
        JSON.stringify([this.collection.window, this.collection.prepared]),
      )
      .digest("hex");
  }
  editPrepared(version: string, text: string) {
    if (
      this.busy ||
      this.launching ||
      !this.collection.prepared ||
      version !== this.preparedVersion()
    )
      throw new Error(
        "This prepared prompt changed or launched. Reload before editing.",
      );
    const value = text.trim();
    if (
      value.length < 10 ||
      value.length > 600 ||
      /[\u0000-\u0008]/.test(value) ||
      this.clean(value, Infinity) !== value
    )
      throw new Error(
        "Use 10–600 characters without private paths, credentials or control characters",
      );
    this.collection.prepared = {
      text: value,
      author: "Host edited",
      platform: "fallback",
    };
    this.syncCollection();
  }
  // Manual expiry pauses; Resume runs the normal quota/rehearsal checks.
  manualBreak(durationMs: number | null, immediate: boolean) {
    return this.breaks.request(durationMs, immediate);
  }
  async stopStream() {
    if (this.state.mode !== "live")
      throw new Error("Rehearsal does not control a public broadcast");
    await this.stop("Host requested Stop stream", false);
    // Report OBS failure to the caller instead of treating a paused controller as success.
    try {
      await this.integrations.stopBroadcast();
    } catch {
      this.state.reason =
        "Coding stopped, but OBS broadcast shutdown was not confirmed. Open OBS and stop streaming, or retry Stop stream.";
      this.persist();
      throw new Error(this.state.reason);
    }
  }
  constructor(
    private store: Store,
    filter: Filter,
    judge: Judge,
    private runner: PairRunner,
    private preview: {
      validate(
        agent: SessionId,
        round: number,
        count: SessionCount,
      ): Promise<string>;
    },
    private integrations: Integrations,
    private options: ControllerOptions,
    private clean: (s: string, limit?: number) => string,
    private now = Date.now,
  ) {
    super();
    const saved = store.state();
    this.state = {
      status: "paused",
      mode: options.mode,
      reason: saved
        ? "Controller restarted. Show is paused."
        : "Ready for a private rehearsal.",
      // A restart preserves timed or host-ended manual breaks without starting coding work.
      ...(saved?.breakKind === "manual" && saved.manualBreak
        ? {
            status: "break" as const,
            breakKind: "manual" as const,
            manualBreak: saved.manualBreak,
            breakUntil: saved.manualBreak.deadline,
          }
        : {}),
      round: saved?.round,
      candidates: [],
      candidateCount: 0,
      events: saved?.events ?? [],
      connections: {},
      checks: [],
      rehearsalComplete: saved?.rehearsalComplete ?? false,
      rehearsalRunnerMode: saved?.rehearsalRunnerMode,
      playlistTotal: this.usingPlaylist()
        ? this.options.playlist!.length
        : undefined,
      playlistIndex: this.usingPlaylist() ? 0 : undefined,
      awaitingHostChoice: false,
    };
    if (this.state.round)
      for (const attempt of Object.values(this.state.round.attempts))
        if (["running", "validating"].includes(attempt.status)) {
          attempt.status = "cancelled";
          attempt.endedAt = this.now();
          attempt.error = "Interrupted by controller restart";
        }
    this.collection = new Collection(
      filter,
      judge,
      store,
      options,
      () => this.syncCollection(),
      this.now,
    );
    this.persist();
  }
  async recover() {
    try {
      await this.runner.recover();
      this.state.reason = "Paused. Runner recovery completed.";
    } catch {
      this.state.reason =
        "Paused. Runner recovery could not confirm stopped processes; fix the runner before starting.";
    }
    this.persist();
  }
  private usingPlaylist() {
    return !this.playlistReleased && (this.options.playlist?.length ?? 0) > 0;
  }
  private roundStillOpen() {
    return !!(
      this.handles ||
      this.launching ||
      this.state.status === "running" ||
      (this.state.status === "results" &&
        (this.state.resultUntil ?? 0) > this.now())
    );
  }
  private selectedPlatforms(platforms: ChatPlatforms) {
    const selected = {
      youtube: !!platforms.youtube,
      twitch: !!platforms.twitch,
      kick: !!platforms.kick,
    };
    if (!selected.youtube && !selected.twitch && !selected.kick)
      throw new Error("Pick YouTube, Twitch, or Kick before switching to chat");
    return selected;
  }
  private armPlaylist() {
    const list = this.options.playlist ?? [];
    if (this.playlistCursor >= list.length) return false;
    this.collection.prepared = {
      text: list[this.playlistCursor],
      author: "Prompt list",
      platform: "fallback",
    };
    this.state.playlistIndex = this.playlistCursor + 1;
    this.state.playlistTotal = list.length;
    this.playlistCursor += 1;
    this.syncCollection();
    return true;
  }
  snapshot() {
    const value = this.view();
    value.events = publicActivity(
      value.events,
      this.quick?.get().value.visibility ?? {},
    );
    return value;
  }
  // Read-only pages share the same public-text redactor as live snapshots.
  safeHistory(page: import("../shared/settings.js").HistoryPage) {
    return historyView(page, this.clean);
  }
  hostSnapshot() {
    return this.view();
  }
  private view() {
    const value = structuredClone(this.state);
    const doc = this.quick?.get();
    if (doc)
      value.quickSettings = {
        revision: doc.revision,
        visibility: doc.value.visibility,
        media: doc.value.media,
      };
    if (this.collection?.prepared)
      value.preparedVersion = this.preparedVersion();
    // A saved result keeps its own configuration, even after startup choices change.
    const sessions = value.round?.sessions ?? configuredSessions(this.options);
    value.sessions = sessions;
    value.agents = sessions.map((s) => s.id);
    value.models = Object.fromEntries(
      sessions.map((s) => [s.id, sessionLabel(s)]),
    );
    if (value.round) {
      value.round.task.text = this.clean(value.round.task.text, 600);
      value.round.task.author = this.clean(value.round.task.author, 80);
    }
    if (value.prepared) {
      value.prepared.text = this.clean(value.prepared.text, 600);
      value.prepared.author = this.clean(value.prepared.author, 80);
    }
    value.candidates = value.candidates.map((c) => ({
      ...c,
      text: this.clean(c.text, 600),
      message: {
        ...c.message,
        text: this.clean(c.message.text, 600),
        author: this.clean(c.message.author, 80),
      },
    }));
    value.reason = this.clean(value.reason);
    return value;
  }
  private persist() {
    if (this.state.round) this.store.round(this.state.round);
    this.store.save(this.state);
    this.emit("state", this.snapshot());
  }
  private syncCollection() {
    this.state.candidates = this.collection.candidates;
    this.state.candidateCount = this.collection.candidates.length;
    this.state.prepared = this.collection.prepared;
    this.state.collectionDeadline = this.collection.prepared
      ? undefined
      : Number.isFinite(this.collection.deadline)
        ? this.collection.deadline
        : undefined;
    this.persist();
  }
  ingest(message: ChatMessage) {
    if (!["stopped", "break"].includes(this.state.status))
      return this.collection.ingest(message);
    return Promise.resolve();
  }
  connection(platform: string, status: string, fatal = false) {
    this.state.connections[platform] = status;
    if (fatal && this.state.status !== "stopped")
      this.pause(`${platform}: ${status}`);
    else this.persist();
  }
  setReconnecting(active: boolean) {
    if (active) {
      if (this.state.status === "stopped") return;
      this.state.obsReconnectDeadline =
        this.now() + this.options.reconnectLimitMs;
      this.state.reason = `Broadcast is reconnecting; the stream ends if it exceeds ${Math.round(this.options.reconnectLimitMs / 60000)} minutes.`;
    } else this.state.obsReconnectDeadline = undefined;
    this.persist();
  }
  async start() {
    if (this.switchingToSession || !this.arenaEnabled())
      throw new Error("Open Prompt arena before starting arena rounds");
    // Only manual breaks can be ended by the host; quota recovery remains mandatory.
    if (
      this.breaks.transitioning ||
      (this.state.status === "break" && this.state.breakKind !== "manual")
    )
      throw new Error("Wait for the break transition or timer to finish");
    if (this.busy || this.launching || this.handles)
      throw new Error("Current round is still running");
    // Viewer prompts become code; with no container boundary that code would
    // run as the host user, so public chat rounds require the Docker runner.
    if (
      this.state.mode === "live" &&
      !this.usingPlaylist() &&
      this.options.runnerMode === "native"
    )
      throw new Error(
        "Live chat rounds need the Docker runner; native mode is for private rehearsal and sessions.",
      );
    if (
      this.state.mode === "live" &&
      !this.usingPlaylist() &&
      (!this.state.rehearsalComplete ||
        (this.state.rehearsalRunnerMode ?? "docker") !==
          (this.options.runnerMode ?? "docker"))
    )
      throw new Error(
        "Complete and confirm a private OBS rehearsal with this runner mode before live mode",
      );
    // Leaving a manual break goes through the full normal startup checks.
    if (this.state.status === "break" && this.state.breakKind === "manual") {
      this.state.manualBreak = undefined;
      this.state.breakKind = undefined;
      this.state.breakUntil = undefined;
      this.state.status = "paused";
    }
    const generation = this.generation;
    this.busy = true;
    this.state.checks = [];
    this.state.reason =
      "Checking CLI accounts, models, previews and chat connections…";
    this.persist();
    try {
      this.applyQuick();
      await this.runner.recover();
      const checks = await this.runner.preflight();
      checks.push(...(await this.integrations.preflight()));
      if (generation !== this.generation) return;
      await this.integrations.start();
      if (generation !== this.generation) {
        this.integrations.stop();
        return;
      }
      this.state.checks = checks;
      this.state.status =
        this.state.resultUntil && this.state.resultUntil > this.now()
          ? "results"
          : "collecting";
      this.state.reason = this.usingPlaylist()
        ? `Prompt list ready · ${this.options.playlist!.length} tasks`
        : "Audience collection is open";
      if (!this.collection.prepared && !this.collection.candidates.length)
        this.collection.reset();
      if (
        this.usingPlaylist() &&
        this.playlistCursor >= this.options.playlist!.length
      )
        this.playlistCursor = 0;
      if (this.usingPlaylist() && !this.collection.prepared) this.armPlaylist();
      this.lastQuota = 0;
      await this.checkQuota();
    } catch (error) {
      this.integrations.stop();
      this.state.status = "paused";
      this.state.reason =
        error instanceof Error ? error.message : "Startup check failed";
    } finally {
      this.busy = false;
      this.persist();
    }
  }
  pause(reason = "Host paused new rounds") {
    this.generation++;
    if (this.state.status === "break") {
      this.resumeAfterBreak = false;
      this.state.reason = `${reason}. ${this.state.breakKind === "manual" ? "Manual" : "Quota"} break continues.`;
      this.persist();
      return;
    }
    this.state.status = "paused";
    this.state.reason = reason;
    this.persist();
  }
  async resume() {
    if (this.switchingToSession || !this.arenaEnabled())
      throw new Error("Open Prompt arena before resuming arena rounds");
    if (this.breaks.transitioning)
      throw new Error("Work is stopping for a break");
    if (this.state.status === "break") {
      if (this.state.breakKind === "manual") return this.start();
      throw new Error("A quota break is active; wait for quota recovery");
    }
    if (this.handles || this.launching) {
      this.state.status = "running";
      this.state.reason = "Current round running; next rounds enabled";
      this.persist();
    } else await this.start();
  }
  // Session controls can clear a leftover arena break without starting a new arena round.
  endManualBreak() {
    if (this.breaks.transitioning || this.state.status !== "break" || this.state.breakKind !== "manual")
      throw new Error("Only an active manual break can be ended here");
    this.state.manualBreak = undefined;
    this.state.breakKind = undefined;
    this.state.breakUntil = undefined;
    this.state.status = "paused";
    this.state.reason = "Manual break ended. Start the prompt arena when ready.";
    this.persist();
  }
  reject(id: string) {
    this.collection.reject(id);
  }
  confirmRehearsal() {
    if (
      this.options.mode !== "rehearsal" ||
      !this.state.round ||
      Object.values(this.state.round.attempts).some(
        (a) => a.status !== "complete",
      )
    )
      throw new Error("Finish a successful private round first");
    this.state.rehearsalComplete = true;
    this.state.rehearsalRunnerMode = this.options.runnerMode ?? "docker";
    this.state.reason = "Private OBS rehearsal confirmed by host";
    this.persist();
  }
  prepareRehearsal(text?: string) {
    if (this.state.mode !== "rehearsal" || this.handles || this.launching)
      throw new Error("A house task is available only before a private round");
    const value = (text ?? "").trim();
    if (value.length < 10)
      throw new Error("Write a rehearsal task of at least 10 characters");
    this.collection.prepared = {
      text: value,
      author: "Private rehearsal",
      platform: "fallback",
    };
    this.syncCollection();
  }
  private activity(event: Activity) {
    event = { ...event, text: this.clean(event.text, Infinity) };
    const index = this.state.events.findIndex((e) => e.id === event.id);
    if (index >= 0) {
      if (this.state.events[index].text === event.text) return;
      this.state.events[index] = event;
      this.store.replaceEvent(event);
      this.emit("activity", event);
      this.persist();
      return;
    }
    if (this.store.event(event)) {
      this.state.events.push(event);
      this.state.events = this.state.events.slice(-160);
      this.emit("activity", event);
      this.persist();
    }
  }
  async tick() {
    if (this.busy || this.ending || this.breaks.transitioning || this.switchingToSession || !this.arenaEnabled()) return;
    this.busy = true;
    try {
      if (!["stopped", "break"].includes(this.state.status))
        await this.collection.tick();
      if (
        this.state.status === "collecting" &&
        !this.collection.prepared &&
        this.state.collectionDeadline === undefined &&
        this.collection.candidates.length === 0
      )
        this.state.reason = this.usingPlaylist()
          ? `Prompt list ${this.state.playlistIndex ?? 0} of ${this.state.playlistTotal ?? 0}`
          : "No suitable audience prompt yet; the show waits for chat activity";
      if (
        this.state.obsReconnectDeadline &&
        this.now() >= this.state.obsReconnectDeadline &&
        this.state.status !== "stopped"
      ) {
        await this.stop(
          `Broadcast did not reconnect within ${Math.round(this.options.reconnectLimitMs / 60000)} minutes; ending the stream`,
        );
        return;
      }
      if (this.state.status === "break" && this.state.breakKind === "manual") {
        if (this.now() >= (this.state.manualBreak?.deadline ?? Infinity)) {
          this.state.manualBreak = undefined;
          this.state.breakKind = undefined;
          this.state.breakUntil = undefined;
          // Expiry leaves the break before pause(), which deliberately preserves active breaks.
          this.state.status = "paused";
          this.pause(
            "Timed break finished. Resume to recheck quota and continue.",
          );
        }
        return;
      }
      // Scheduled breaks start only after both sessions and their results finish.
      if (
        this.state.manualBreak &&
        !this.handles &&
        !this.launching &&
        !this.roundStillOpen() &&
        this.state.status !== "break"
      ) {
        this.breaks.begin();
        return;
      }
      if (this.state.status === "break") {
        if (this.now() >= this.state.breakUntil!) {
          let recovered = false;
          try {
            const quota = await this.runner.quota();
            this.state.quota = quota;
            recovered = quota.remainingPercent > 0;
          } catch {
            this.state.reason = "Quota could not be verified after break";
          }
          if (recovered) {
            this.recoveredQuota();
            return;
          }
          await this.stop("Codex quota did not recover within ten minutes");
          return;
        }
        if (this.now() - this.lastQuota >= this.options.quotaPollMs)
          await this.checkQuota();
      } else if (!["paused", "stopped"].includes(this.state.status)) {
        if (this.now() - this.lastQuota >= this.options.quotaPollMs)
          await this.checkQuota();
        if (
          this.state.status === "collecting" &&
          this.collection.prepared &&
          !this.handles
        ) {
          if (this.pendingStop === "stream")
            await this.stop("Host ended the show after this round.");
          else if (this.pendingStop === "chat")
            await this.switchToChat(this.pendingPlatforms);
          else await this.launch(this.collection.prepared);
        } else if (
          this.state.status === "results" &&
          this.now() >= (this.state.resultUntil ?? Infinity)
        ) {
          if (this.state.awaitingHostChoice) {
            /* Host must pick live chat or end the stream. */
          } else if (this.pendingStop === "stream")
            await this.stop("Host ended the show after this round.");
          else if (this.pendingStop === "chat")
            await this.switchToChat(this.pendingPlatforms);
          else if (this.usingPlaylist()) {
            if (this.armPlaylist() && this.collection.prepared)
              await this.launch(this.collection.prepared);
            else this.askHostChoice();
          } else if (this.state.mode === "rehearsal") {
            this.pause(
              "Private round finished. Check OBS, then confirm the rehearsal.",
            );
          } else if (this.collection.prepared)
            await this.launch(this.collection.prepared);
          else {
            this.state.status = "collecting";
            this.state.reason = "Waiting for the next suitable prompt";
          }
        }
      }
    } catch {
      this.pause(
        "Runner cancellation or controller check failed. No new round will start.",
      );
    } finally {
      this.busy = false;
      this.persist();
    }
  }
  private async launch(task: Task) {
    this.launching = true;
    const generation = this.generation;
    let settled!: () => void;
    this.launchSettled = new Promise<void>((resolve) => {
      settled = resolve;
    });
    try {
      this.applyQuick();
      // Recover any leftovers before every launch, not only at application startup.
      await this.runner.recover();
      if (
        generation !== this.generation ||
        !["collecting", "results"].includes(this.state.status)
      )
        return;
      const sessions = configuredSessions(this.options);
      const id = this.store.roundId();
      const at = this.now();
      this.state.round = {
        id,
        task,
        launchedAt: at,
        sessions: structuredClone(sessions),
        attempts: Object.fromEntries(
          sessions.map((session) => [
            session.id,
            {
              cli: session.cli,
              model: session.model,
              effort: session.effort,
              status: "running",
              startedAt: at,
            },
          ]),
        ),
      };
      this.state.events = [];
      this.state.status = "running";
      const launching =
        sessions.length === 1
          ? "A fresh session is launching"
          : "Both fresh sessions are launching";
      this.state.reason = this.usingPlaylist()
        ? `Prompt list ${this.state.playlistIndex ?? 0} of ${this.state.playlistTotal ?? 0}. ${launching}`
        : launching;
      this.state.resultUntil = undefined;
      this.collection.reset();
      this.persist();
      const handles = await this.runner.launch(id, task, at, (e) =>
        this.activity(e),
      );
      this.handles = handles;
      for (const agent of Object.keys(handles)) {
        const handle = handles[agent];
        if (handle) void this.finished(agent, id, handle);
      }
      if (generation !== this.generation)
        await Promise.all(
          Object.values(handles).map((h) => h.stop("cancelled")),
        );
    } catch (error) {
      if (this.state.round)
        for (const a of Object.values(this.state.round.attempts))
          if (a.status === "running") {
            a.status = "error";
            a.endedAt = this.now();
            a.error = "Runner launch failed";
          }
      this.pause(
        error instanceof Error ? error.message : "Runner launch failed",
      );
    } finally {
      this.launching = false;
      settled();
      this.launchSettled = undefined;
      this.persist();
    }
  }
  private async finished(agent: SessionId, id: number, handle: RunHandle) {
    const outcome = await handle.done;
    if (this.state.round?.id !== id) return;
    const attempt = this.state.round.attempts[agent];
    attempt.endedAt = this.now();
    attempt.status = outcome.status;
    attempt.error = outcome.error;
    if (outcome.status === "complete") {
      attempt.status = "validating";
      this.persist();
      try {
        attempt.preview = await this.preview.validate(
          agent,
          id,
          sessionCount(
            this.state.round.sessions ??
              Object.values(this.state.round.attempts).filter(
                (a) => a.status !== "idle",
              ),
          ),
        );
        attempt.status = "complete";
      } catch {
        attempt.status = "error";
        attempt.error = "HTML missing, empty, or failed to load safely";
      }
    }
    if (outcome.failure === "auth")
      this.pause(
        `${agent} subscription login failed. Authenticate before resuming.`,
      );
    else if (outcome.failure === "usage") {
      this.pause(`${agent} usage limit reached.`);
      if (attempt.cli === "codex") await this.checkQuota();
      for (const [other, h] of Object.entries(this.handles ?? {}))
        if (other !== agent)
          await h
            .stop("cancelled")
            .catch(() =>
              this.pause("Could not confirm the other agent stopped"),
            );
    } else if (outcome.failure === "other")
      this.pause(
        "CLI or runner cleanup failed. Check the host before resuming.",
      );
    if (
      Object.values(this.state.round.attempts).every(
        (a) => !["running", "validating"].includes(a.status),
      )
    ) {
      this.handles = undefined;
      this.state.resultUntil = this.now() + this.options.resultMs;
      if (this.state.status === "running") {
        this.state.status = "results";
        this.state.reason = "Results stay visible before the next round";
      }
    }
    this.persist();
  }
  private async checkQuota() {
    if (!configuredSessions(this.options).some((s) => s.cli === "codex"))
      return;
    if (this.checkingQuota) return;
    this.checkingQuota = true;
    this.lastQuota = this.now();
    try {
      const quota = await this.runner.quota();
      this.state.quota = quota;
      if (quota.remainingPercent <= 0 && this.state.status !== "stopped") {
        if (this.state.status !== "break") {
          this.generation++;
          this.resumeAfterBreak = true;
          this.state.status = "break";
          this.state.breakKind = "quota";
          this.state.manualBreak = undefined;
          this.state.breakUntil = this.now() + this.options.quotaGraceMs;
          this.state.reason =
            "Codex five-hour quota exhausted. Music break; waiting up to ten minutes.";
        }
      } else if (quota.remainingPercent > 0 && this.state.status === "break") {
        this.recoveredQuota();
      }
    } catch {
      if (this.state.status !== "break")
        this.pause("Could not verify Codex five-hour quota. Show paused.");
    } finally {
      this.checkingQuota = false;
    }
    this.persist();
  }
  private recoveredQuota() {
    this.state.breakUntil = undefined;
    this.state.breakKind = undefined;
    this.state.status = !this.resumeAfterBreak
      ? "paused"
      : this.handles
        ? "running"
        : this.state.resultUntil && this.state.resultUntil > this.now()
          ? "results"
          : "collecting";
    this.state.reason = this.resumeAfterBreak
      ? "Quota recovered. The show is continuing."
      : "Quota recovered; host pause remains active.";
  }
  async skip() {
    this.generation++;
    if (this.handles)
      await Promise.all(
        Object.values(this.handles).map((h) => h.stop("cancelled")),
      );
    this.state.reason = "Round skipped; waiting for active runners to stop";
    this.persist();
  }
  async hostChoice(choice: StopChoice, platforms: ChatPlatforms = {}) {
    if (this.state.status === "stopped" || this.ending)
      throw new Error("The show has already ended");
    this.state.awaitingHostChoice = false;
    if (choice === "stream-now") return this.stop("Host ended the show");
    if (choice === "chat-now") return this.switchToChat(platforms, true);
    if (choice === "stream-after") {
      if (!this.roundStillOpen())
        return this.stop("Host ended the show after this round.");
      this.pendingStop = "stream";
      this.state.reason = "This round will finish, then the stream ends.";
      this.persist();
      return;
    }
    if (choice === "chat-after") {
      this.pendingPlatforms = this.selectedPlatforms(platforms);
      if (!this.roundStillOpen())
        return this.switchToChat(this.pendingPlatforms);
      this.pendingStop = "chat";
      this.state.reason =
        "This round will finish, then live chat collection starts.";
      this.persist();
    }
  }
  private askHostChoice() {
    this.state.awaitingHostChoice = true;
    this.state.status = "results";
    this.state.reason =
      "Prompt list finished. Choose live chat or end the stream.";
    this.persist();
  }
  private async switchToChat(platforms: ChatPlatforms, cancel = false) {
    const selected = this.selectedPlatforms(platforms);
    this.generation++;
    this.playlistReleased = true;
    this.pendingStop = undefined;
    this.pendingPlatforms = {};
    this.state.awaitingHostChoice = false;
    this.state.playlistIndex = undefined;
    this.state.playlistTotal = undefined;
    if (cancel && this.launchSettled) await this.launchSettled;
    if (cancel && this.handles)
      await Promise.all(
        Object.values(this.handles).map((h) => h.stop("cancelled")),
      );
    this.handles = undefined;
    this.collection.reset();
    this.state.status = "collecting";
    this.state.resultUntil = undefined;
    this.state.reason = "Prompt list stopped. Connecting live chat…";
    this.persist();
    try {
      await this.integrations.startChats(selected);
      this.collection.reset();
      this.state.status = "collecting";
      this.state.reason = "Audience collection is open";
    } catch (error) {
      this.pause(
        error instanceof Error
          ? error.message
          : "Could not start the selected chat platforms",
      );
    }
    this.persist();
  }
  async stop(reason = "Host ended the show", stopBroadcast = true) {
    if (this.ending) return false;
    this.ending = true;
    this.generation++;
    this.state.status = "stopped";
    this.state.reason = reason;
    this.state.breakUntil = undefined;
    this.state.obsReconnectDeadline = undefined;
    this.state.awaitingHostChoice = false;
    this.pendingStop = undefined;
    this.state.manualBreak = undefined;
    this.state.breakKind = undefined;
    this.integrations.stop();
    this.persist();
    try {
      if (this.launchSettled) await this.launchSettled;
      if (this.handles)
        await Promise.all(
          Object.values(this.handles).map((h) => h.stop("cancelled")),
        );
      await this.runner.recover();
      if (stopBroadcast && this.state.mode === "live")
        await this.integrations.stopBroadcast();
      this.arenaCleanupFailed = false;
      return true;
    } catch {
      this.arenaCleanupFailed = true;
      this.state.reason = `${reason}. Could not confirm runner or OBS shutdown; check the host.`;
      return false;
    } finally {
      this.ending = false;
      this.persist();
    }
  }
}

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
import { configuredSessions, sessionLabel } from "../shared/types.js";
import { Collection } from "./collection.js";
import { Filter } from "./filter.js";
import type { Judge } from "./jev.js";
import type { PairRunner, RunHandle } from "./runner.js";
import { Store } from "./store.js";
export interface ControllerOptions {
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
  private generation = 0;
  private launchSettled?: Promise<void>;
  private resumeAfterBreak = true;
  private playlistCursor = 0;
  private playlistReleased = false;
  private pendingStop?: "chat" | "stream";
  private pendingPlatforms: ChatPlatforms = {};
  constructor(
    private store: Store,
    filter: Filter,
    judge: Judge,
    private runner: PairRunner,
    private preview: {
      validate(
        agent: SessionId,
        round: number,
        sessionCount?: number,
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
    value.events = value.events.filter((event) => !event.lane);
    return value;
  }
  hostSnapshot() {
    return this.view();
  }
  private view() {
    const value = structuredClone(this.state);
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
    if (this.busy || this.launching || this.handles)
      throw new Error("Current round is still running");
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
    const generation = this.generation;
    this.busy = true;
    this.state.checks = [];
    this.state.reason =
      "Checking CLI accounts, models, previews and chat connections…";
    this.persist();
    try {
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
      this.state.reason = `${reason}. Quota break continues.`;
      this.persist();
      return;
    }
    this.state.status = "paused";
    this.state.reason = reason;
    this.persist();
  }
  async resume() {
    if (this.state.status === "break") throw new Error("Quota break is active");
    if (this.handles || this.launching) {
      this.state.status = "running";
      this.state.reason = "Current round running; next rounds enabled";
      this.persist();
    } else await this.start();
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
    if (this.busy || this.ending) return;
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
      // Recover any leftovers before every launch, not only at application startup.
      await this.runner.recover();
      if (
        generation !== this.generation ||
        !["collecting", "results"].includes(this.state.status)
      )
        return;
      const id = this.store.roundId();
      const at = this.now();
      this.state.round = {
        id,
        task,
        launchedAt: at,
        sessions: structuredClone(configuredSessions(this.options)),
        attempts: Object.fromEntries(
          configuredSessions(this.options).map((session) => [
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
        configuredSessions(this.options).length === 1
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
          this.state.round.sessions?.length,
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
    if (this.ending) return;
    this.ending = true;
    this.generation++;
    this.state.status = "stopped";
    this.state.reason = reason;
    this.state.breakUntil = undefined;
    this.state.obsReconnectDeadline = undefined;
    this.state.awaitingHostChoice = false;
    this.pendingStop = undefined;
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
    } catch {
      this.state.reason = `${reason}. Could not confirm runner or OBS shutdown; check the host.`;
    } finally {
      this.ending = false;
      this.persist();
    }
  }
}

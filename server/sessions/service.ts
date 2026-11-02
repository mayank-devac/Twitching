import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  Agent,
  Activity,
  RunnerMode,
  SessionConfig,
  ShowState,
} from "../../shared/types.js";
import type {
  ConnectorCapabilities,
  Conversation,
  Experience,
  SessionView,
  TimelineItem,
} from "../../shared/sessions.js";
import {
  projectActivity,
  publicSessionView,
  sessionLanePolicy,
  visibilityFor,
  visiblePage,
} from "../../shared/visibility.js";
import type { QuickSettings } from "../quick-settings.js";
import type { Store } from "../store.js";
import { CliRunner, type CapabilityChecks, type RunHandle } from "../runner.js";
import type { Docker } from "../docker.js";
import { CodexHistory } from "./codex-history.js";
import { ClaudeHistory } from "./claude-history.js";
import { Overlays } from "./overlays.js";
import { uniqueConversations } from "../../shared/sessions.js";

export const connectors: Record<Agent, ConnectorCapabilities> = {
  codex: {
    listing: true,
    history: true,
    liveEvents: false,
    runtimeStatus: false,
    note: "Read-only saved history via the installed Codex app-server. Published history refreshes every 5 seconds; unsaved/live output may be missing. No attachment to another CLI process; runtime status is unknown. Older CLIs/history stores may not support item pagination.",
  },
  cursor: {
    listing: false,
    history: false,
    liveEvents: false,
    runtimeStatus: false,
    note: "Cursor documents interactive session selection/resume and JSON output for managed runs, but no verified passive history/live attachment API. Start a managed Cursor session here; existing Cursor processes cannot be observed.",
  },
  claude: {
    listing: true,
    history: true,
    liveEvents: false,
    runtimeStatus: false,
    note: "Read-only saved history from your Claude Code transcripts (~/.claude/projects, or CLAUDE_CONFIG_DIR). The transcript format is internal to Claude Code and may change; unreadable rows are skipped. No attachment to another CLI process; runtime status is unknown. Managed arena runs are not saved there.",
  },
};

// One service owns selection/publication, separate from arena rounds and external CLI lifetimes.
export class Sessions extends EventEmitter {
  experience: Experience;
  readonly overlays: Overlays;
  private history: CodexHistory;
  private claudeHistory: ClaudeHistory;
  private active = new Map<
    string,
    { handle?: RunHandle; settled: Promise<void> }
  >();
  private closing = false;
  private switchingMode = false;
  private modeRequest?: Promise<{ status: "choice" | "waiting" | "ready" }>;
  private rehearsals = new Set<string>();
  // Per-conversation native consent, kept in memory only. It never touches
  // process.env, so approving one session cannot approve arena or others.
  private nativeApprovals = new Set<string>();
  // Capability probes are fixed per host, so prompts and model loads share them
  // instead of starting fresh probe containers for every new CliRunner.
  private capabilities: Record<RunnerMode, CapabilityChecks> = { docker: new Map(), native: new Map() };
  // HTTP supplies the host-confirmed checklist without coupling it to provider connectors.
  requirePresentationRehearsal: (context: string, output?: import("../../shared/sessions.js").OverlayDefinition) => void = () => {};
  get mode() { return this.preferences.get().value.stream.mode; }
  private publicationMode?: "live" | "rehearsal";
  readonly recoveryRunners: Set<RunnerMode>;
  constructor(
    private store: Store,
    private preferences: QuickSettings,
    private hosts: Record<RunnerMode, Docker>,
    private clean: (
      text: string,
      limit?: number,
      streaming?: boolean,
    ) => string,
    experience: Experience,
    private liveReady: () => Promise<boolean>,
    private arenaIdle: () => boolean,
    private renderResult?: (agent: string, round: number) => Promise<string>,
    private leaveArena?: (choice?: "wait" | "cancel") => Promise<"choice" | "waiting" | "ready">,
  ) {
    super();
    this.experience = experience;
    this.history = new CodexHistory(clean);
    this.claudeHistory = new ClaudeHistory(clean);
    this.recoveryRunners = store.disconnectConversations();
    this.publicationMode = preferences.get().value.stream.mode;
    this.overlays = new Overlays(store, {
      name: (text) => this.clean(text, 80),
      view: (id, before) => this.view(id, before, 20),
      publicView: (view) => this.safePublic(view),
      running: () =>
        [...this.active.keys()].flatMap((id) => {
          const conversation = this.store.conversation(id);
          return conversation?.status === "running" ? [conversation] : [];
        }),
      eligible: (id) => {
        if (preferences.get().value.stream.mode === "rehearsal") return true;
        if (!this.rehearsals.has(id)) return false;
        try { this.requirePresentationRehearsal(id); return true; } catch { return false; }
      },
      approve: async (ids, output) => {
        if (!this.arenaIdle())
          throw new Error("Stop the prompt arena before publishing sessions");
        if (preferences.get().value.stream.mode === "live") {
          for (const id of ids) this.requirePresentationRehearsal(id, output);
          if (ids.some((id) => !this.rehearsals.has(id)))
            throw new Error(
              "Confirm a private rehearsal for every selected session before publishing live",
            );
          let ready = false;
          try {
            ready = await this.liveReady();
          } catch {
            /* OBS errors stay private. */
          }
          if (!ready)
            throw new Error(
              "Start the OBS broadcast manually first. Opening OBS does not start streaming.",
            );
        }
      },
    });
    this.overlays.on("state", () => {
      if (this.overlays.hasPublished()) this.experience = "session";
      this.emit("state");
    });
  }

  async readiness() {
    const exec = promisify(execFile);
    const probes = [
      { name: "Codex", program: "codex", args: ["--version"] },
      { name: "Cursor", program: "cursor-agent", args: ["--version"] },
      { name: "Claude Code", program: "claude", args: ["--version"] },
      {
        name: "Docker",
        program: "docker",
        args: ["info", "--format", "{{.ServerVersion}}"],
      },
    ];
    const result = await Promise.allSettled(
      probes.map((probe) =>
        exec(probe.program, probe.args, { timeout: 3000, maxBuffer: 4096 }),
      ),
    );
    return {
      connectors,
      tools: result.map((r, i) => ({
        name: probes[i]!.name,
        available: r.status === "fulfilled",
        message:
          r.status === "fulfilled"
            ? this.clean(r.value.stdout.trim(), 120)
            : "Unavailable. Install/start it and check PATH.",
      })),
      login:
        "Loading models checks the selected runner's saved login without starting a model. Missing login is reported inline.",
      obs: "Open OBS only launches the app. Publishing in live mode checks that OBS is already broadcasting.",
    };
  }
  async list(source: "managed" | "all" | Agent, search = "", before?: string) {
    const publishedIds = this.overlays.host().publishedSessionIds;
    const main = this.overlays.snapshot();
    const publication = {
      publishedId:
        main.frames.length === 1 ? main.frames[0]!.conversation.id : undefined,
      publishedIds,
    };
    // "all" merges every saved-history connector, newest first, so one overlay can mix harnesses.
    if (source === "all") {
      let cursors: Record<string, string | null> = {};
      try {
        cursors = before ? JSON.parse(before) : {};
      } catch {
        cursors = {};
      }
      const saved = ["codex", "claude"] as const;
      const pages = await Promise.all(
        saved.map(async (cli) => {
          if (cursors[cli] === null) return undefined;
          const history = cli === "codex" ? this.history : this.claudeHistory;
          return history.list(search, cursors[cli] ?? undefined);
        }),
      );
      const next: Record<string, string | null> = {};
      saved.forEach((cli, i) => (next[cli] = pages[i]?.before ?? null));
      return {
        conversations: uniqueConversations(
          pages
            .flatMap((page) => page?.conversations ?? [])
            .sort((a, b) => b.updatedAt - a.updatedAt),
        ),
        before: Object.values(next).some(Boolean)
          ? JSON.stringify(next)
          : undefined,
        ...publication,
      };
    }
    // CLIs without a history connector list nothing and explain why.
    if (source === "cursor")
      return {
        conversations: [],
        note: connectors[source].note,
        ...publication,
      };
    if (source === "codex" || source === "claude") {
      const page = await (source === "codex" ? this.history : this.claudeHistory)
        .list(search, before);
      return {
        ...page,
        conversations: uniqueConversations(page.conversations),
        note: connectors[source].note,
        ...publication,
      };
    }
    return {
      ...this.store.conversations(search, before ? Number(before) : undefined),
      ...publication,
    };
  }
  async get(id: string): Promise<Conversation> {
    if (id.startsWith("codex:")) return this.history.read(id.slice(6));
    if (id.startsWith("claude:")) return this.claudeHistory.read(id.slice(7));
    const c = this.store.conversation(id);
    if (!c) throw new Error("Session not found");
    return c;
  }
  async models(cli: Agent, runner: RunnerMode) {
    // preferencesSchema keeps at least one session.
    const defaults = this.preferences.get().value.sessions[0]!;
    return new CliRunner(
      this.hosts[runner],
      {
        sessions: [{ ...defaults, cli }],
        codexModel: "unused",
        cursorModel: "unused",
        experience: "session",
      },
      this.clean,
      this.capabilities[runner],
    ).discover(cli);
  }
  async create(
    cli: Agent,
    runner: RunnerMode,
    nativeConsent?: string,
  ) {
    if (this.closing) throw new Error("The server is shutting down");
    if (!this.arenaIdle())
      throw new Error("Stop the prompt arena before starting a coding session");
    if (runner === "native" && nativeConsent !== "NATIVE")
      throw new Error(
        "Choose Yes to explicitly allow managed agents to run on this computer without Docker isolation",
      );
    const config = this.preferences
      .get()
      .value.sessions.find((s) => s.cli === cli);
    if (!config) throw new Error("Choose and save this CLI/model first");
    const c: Conversation = {
      id: `managed:${randomUUID()}`,
      source: "managed",
      cli,
      title: "New coding session",
      project: "Isolated managed workspace",
      updatedAt: Date.now(),
      model: config.model,
      effort: config.effort,
      // The conversation's own runner applies; an arena slot's runner is not copied.
      config: structuredClone({ ...config, runner: undefined }),
      runner,
      status: "idle",
    };
    this.store.saveConversation(c);
    if (runner === "native") this.nativeApprovals.add(c.id);
    this.experience = "session";
    this.emit("state");
    return c;
  }
  private visibility(c: Conversation) {
    const doc = this.preferences.get().value;
    return visibilityFor(
      doc.visibility,
      c.id,
      () =>
        c.config?.id ??
        doc.sessions.find((s) => s.cli === c.cli)?.id ??
        doc.sessions[0]!.id, // preferencesSchema keeps at least one session
    );
  }
  private async rawPage(c: Conversation, before?: string, limit = 60) {
    if (
      c.source === "managed" &&
      before &&
      (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)))
    )
      throw new Error("Invalid history cursor");
    if (c.source === "claude")
      return this.claudeHistory.page(c.providerId!, before, limit);
    return c.source === "codex"
      ? this.history.page(c.providerId!, before, limit)
      : this.store.conversationPage(
          c.id,
          before ? Number(before) : undefined,
          limit,
        );
  }
  async view(id: string, before?: string, limit = 60): Promise<SessionView> {
    const c = await this.get(id),
      page = await this.rawPage(c, before, limit),
      visibility = this.visibility(c);
    return {
      conversation: c,
      page: visiblePage(page, visibility),
      visibility,
      hidePreviousRuns: !!visibility.hidePreviousRuns,
      published: this.overlays.isPublished(id),
    };
  }
  private safePublic(view: SessionView): SessionView {
    return publicSessionView(view, this.visibility(view.conversation));
  }
  async publish(id: string) {
    return this.overlays.publishSingle(id);
  }
  stopPublication() {
    this.overlays.stop();
  }
  async confirmRehearsal(id: string) {
    if (
      this.preferences.get().value.stream.mode !== "rehearsal" ||
      !this.overlays.isPublished(id)
    )
      throw new Error(
        "Publish this session to a private rehearsal overlay and inspect it first",
      );
    if (this.active.has(id))
      throw new Error(
        "Wait for the current managed prompt to finish before confirming rehearsal",
      );
    const view = await this.view(id);
    if (!view.page.items.length)
      throw new Error("Preview available conversation activity first");
    if (
      view.conversation.source === "managed" &&
      this.store.conversationPage(id).items.at(-1)?.kind !== "complete"
    )
      throw new Error(
        "Complete a successful private prompt before confirming rehearsal",
      );
    this.rehearsals.add(id);
    this.overlays.schedule();
  }
  obsDisconnected() {
    if (this.preferences.get().value.stream.mode === "live")
      this.overlays.stopAll();
  }
  publicHistory(id: string, before?: string, overlay = "default") {
    return this.overlays.history(overlay, id, before);
  }
  settingsChanged() {
    const mode = this.preferences.get().value.stream.mode;
    if (this.publicationMode !== mode) {
      this.publicationMode = mode;
      this.overlays.stopAll();
    } else this.overlays.schedule();
  }
  snapshot(base: ShowState, overlayId = "default"): ShowState {
    if (this.experience === "arena" && overlayId === "default")
      return { ...base, experience: "arena" };
    const overlay = this.overlays.snapshot(overlayId);
    return {
      status: "paused",
      mode: this.preferences.get().value.stream.mode,
      experience: this.experience,
      reason: overlay.published
        ? overlay.frames.length === 1
          ? "Selected session on stream"
          : "Selected sessions on stream"
        : "No session on stream",
      candidates: [],
      candidateCount: 0,
      events: [],
      connections: {},
      checks: [],
      rehearsalComplete: base.rehearsalComplete,
      sharedOverlay: overlay,
      sharedSession:
        overlay.frames.length === 1 ? overlay.frames[0] : undefined,
    };
  }
  // Keep mode ownership on the server; navigating a tab alone never starts work.
  sessionMode(choice?: "wait" | "cancel") {
    if (this.modeRequest) return this.modeRequest;
    const pending = this.switchSessionMode(choice).finally(() => { this.modeRequest = undefined; });
    this.modeRequest = pending;
    return pending;
  }
  private async switchSessionMode(choice?: "wait" | "cancel") {
    if (this.experience === "session" && !this.switchingMode && this.arenaIdle())
      return { status: "ready" as const };
    if (this.switchingMode && !choice)
      return { status: "waiting" as const };
    this.switchingMode = true;
    let status: "choice" | "waiting" | "ready";
    try {
      status = this.leaveArena ? await this.leaveArena(choice) : this.arenaIdle() ? "ready" : "choice";
    } catch (error) {
      this.switchingMode = false;
      throw error;
    }
    this.switchingMode = status === "waiting";
    if (status === "ready") {
      this.experience = "session";
      this.emit("state");
    }
    return { status };
  }
  arena() {
    if (this.switchingMode) throw new Error("Wait for the arena handover to finish");
    if (this.active.size)
      throw new Error(
        "Wait for managed prompts to finish before opening the prompt arena",
      );
    this.overlays.stopAll();
    this.experience = "arena";
    this.emit("state");
  }
  async run(id: string, text: string, nativeConsent?: string) {
    if (this.closing) throw new Error("The server is shutting down");
    if (!this.arenaIdle()) throw new Error("Stop the prompt arena first");
    const c = await this.get(id);
    // Another tab may have changed modes while the conversation was being loaded.
    if (this.experience === "arena" || this.switchingMode || !this.arenaIdle())
      throw new Error("Switch to coding sessions before sending a prompt");
    if (c.source !== "managed")
      throw new Error(
        "External sessions are read-only. Start a managed session to send prompts.",
      );
    // The launcher approval still covers sessions; otherwise each
    // conversation needs its own consent (again after a server restart).
    if (
      c.runner === "native" &&
      process.env.ARENA_NATIVE_APPROVED !== "1" &&
      !this.nativeApprovals.has(id)
    ) {
      if (nativeConsent !== "NATIVE")
        throw new Error(
          "Choose Yes to approve native runs for this session before sending a prompt",
        );
      this.nativeApprovals.add(id);
    }
    if (this.active.has(id))
      throw new Error("This session already has a prompt running");
    // A new session's default model must never silently change an older session's next prompt.
    const config = {
      ...c.config!,
      ...this.preferences.get().value.managedModels?.[id],
      // Conversations saved before this rule may still carry an arena slot's runner.
      runner: undefined,
    };
    const run = randomUUID(),
      round = this.store.runId();
    const now = Date.now();
    // Bounded recent context is supplied to a fresh CLI process; files stay in this session's workspace.
    const context = this.store
      .conversationPage(id)
      .items.filter((i) => ["prompt", "message"].includes(i.kind))
      .map((i) => `${i.kind}: ${i.text}`)
      .join("\n")
      .slice(-24000);
    // Host text and composed labels are redacted here; activity text passes
    // redacted=true because the runner already redacted its accumulated text.
    const add = (item: TimelineItem, redacted = false) => {
      this.store.conversationItem(id, {
        ...item,
        text: redacted ? item.text : this.clean(item.text, Infinity),
      });
    };
    add({ id: `${run}:prompt`, run, kind: "prompt", text, at: now });
    c.title =
      c.title === "New coding session" ? this.clean(text, 100) : c.title;
    c.model = config.model;
    c.effort = config.effort;
    c.config = config;
    c.updatedAt = now;
    c.status = "idle";
    c.pendingRun = true;
    c.result = undefined;
    this.store.saveConversation(c);
    let finish!: () => void;
    const active: { handle?: RunHandle; settled: Promise<void> } = {
      settled: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    this.active.set(id, active);
    if (this.overlays.hasPublished()) this.overlays.schedule();
    this.experience = "session";
    this.emit("state");
    const execute = async () => {
      try {
        const runner = new CliRunner(
          this.hosts[c.runner!],
          {
            sessions: [config],
            codexModel: config.model,
            cursorModel: config.model,
            claudeModel: config.model,
            experience: "session",
            workspaceKey: `conversation-${id.slice(8)}`,
            nativeApproved: c.runner === "native" && this.nativeApprovals.has(id),
          },
          this.clean,
          this.capabilities[c.runner!],
        );
        const handles = await runner.launch(
          round,
          {
            text: context
              ? `Recent conversation (may be incomplete):\n${context}\n\nCurrent request:\n${text}`
              : text,
            platform: "fallback",
            author: "Host",
          },
          now,
          (event: Activity) => {
            // Lanes are filtered before storage: host-only lanes and read contents never reach the timeline.
            const row = projectActivity(event, sessionLanePolicy);
            if (!row) return;
            add({
              id: `${run}:${event.id}`,
              run,
              at: event.at,
              kind: row.kind,
              text: row.text,
            }, !row.labelled);
            c.updatedAt = Date.now();
            // Items are stored per event; the conversation row (a full JSON
            // rewrite) is saved only on status transitions, and the finally
            // block below saves the final updatedAt. schedule() coalesces
            // overlay refreshes into one per 250 ms.
            if (c.status !== "running") {
              c.status = "running";
              this.store.saveConversation(c);
            }
            if (this.overlays.hasPublished()) this.overlays.schedule();
          },
        );
        const handle = handles[config.id];
        // launch() returns a handle for every session it was given.
        if (!handle) throw new Error(`Runner returned no handle for ${config.id}`);
        active.handle = handle;
        if (this.closing) await handle.stop("cancelled");
        const outcome = await handle.done;
        c.result = outcome.hasResult ? { round, agent: config.id } : undefined;
        c.status = "idle";
        add({
          id: `${run}:result`,
          run,
          at: Date.now(),
          kind: outcome.status === "complete" ? "complete" : "error",
          text:
            outcome.status === "complete"
              ? "Prompt completed"
              : (outcome.error ?? outcome.status),
        });
      } catch (error) {
        c.status = "disconnected";
        add({
          id: `${run}:result`,
          run,
          at: Date.now(),
          kind: "error",
          text: this.clean(
            error instanceof Error ? error.message : "Session launch failed",
            600,
          ),
        });
      } finally {
        c.updatedAt = Date.now();
        c.pendingRun = false;
        this.store.saveConversation(c);
        this.active.delete(id);
        finish();
        if (this.overlays.hasPublished()) this.overlays.schedule();
        this.emit("state");
      }
    };
    // execute() handles run failures itself; this only catches persistence or
    // overlay errors in its finally block, which would otherwise crash the process.
    void execute().catch((error) => {
      console.error(`Session ${id} bookkeeping failed: ${this.clean(error instanceof Error ? error.message : String(error), 300)}`);
      c.status = "disconnected";
      c.pendingRun = false;
      try { this.store.saveConversation(c); } catch {}
      this.active.delete(id);
      finish();
      this.emit("state");
    });
    return { run };
  }
  async close() {
    this.closing = true;
    this.overlays.close();
    this.history.close();
    for (const active of this.active.values()) {
      if (active.handle) await active.handle.stop("cancelled");
      else await active.settled;
    }
    await Promise.all([...this.active.values()].map((a) => a.settled));
  }
  async result(id: string) {
    const c = await this.get(id);
    if (!c.result || !this.renderResult)
      throw new Error(
        "No supported HTML result for the latest prompt. Conversation is still available.",
      );
    try {
      return { url: await this.renderResult(c.result.agent, c.result.round) };
    } catch {
      throw new Error(
        "Optional HTML could not be displayed safely. Conversation and successful CLI completion are kept.",
      );
    }
  }
}

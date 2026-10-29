import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  Agent,
  Activity,
  SessionConfig,
  ShowState,
} from "../../shared/types.js";
import type {
  ConnectorCapabilities,
  Conversation,
  Experience,
  SessionView,
  TimelineItem,
  TimelinePage,
} from "../../shared/sessions.js";
import { defaultVisibility } from "../../shared/settings.js";
import type { QuickSettings } from "../quick-settings.js";
import type { Store } from "../store.js";
import { CliRunner, type RunHandle } from "../runner.js";
import type { Docker } from "../docker.js";
import { CodexHistory } from "./codex-history.js";
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
};

// One service owns selection/publication, separate from arena rounds and external CLI lifetimes.
export class Sessions extends EventEmitter {
  experience: Experience;
  readonly overlays: Overlays;
  private history: CodexHistory;
  private active = new Map<
    string,
    { handle?: RunHandle; settled: Promise<void> }
  >();
  private closing = false;
  private rehearsals = new Set<string>();
  // HTTP supplies the host-confirmed checklist without coupling it to provider connectors.
  requirePresentationRehearsal: (context: string) => void = () => {};
  get mode() { return this.preferences.get().value.stream.mode; }
  private publicationMode?: "live" | "rehearsal";
  readonly recoveryRunners: Set<"docker" | "native">;
  constructor(
    private store: Store,
    private preferences: QuickSettings,
    private hosts: Record<"docker" | "native", Docker>,
    private clean: (
      text: string,
      limit?: number,
      streaming?: boolean,
    ) => string,
    experience: Experience,
    private liveReady: () => Promise<boolean>,
    private arenaIdle: () => boolean,
    private renderResult?: (agent: string, round: number) => Promise<string>,
  ) {
    super();
    this.experience = experience;
    this.history = new CodexHistory(clean);
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
      approve: async (ids) => {
        if (!this.arenaIdle())
          throw new Error("Stop the prompt arena before publishing sessions");
        if (preferences.get().value.stream.mode === "live") {
          for (const id of ids) this.requirePresentationRehearsal(id);
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
    const result = await Promise.allSettled([
      exec("codex", ["--version"], { timeout: 3000, maxBuffer: 4096 }),
      exec("cursor-agent", ["--version"], { timeout: 3000, maxBuffer: 4096 }),
      exec("docker", ["info", "--format", "{{.ServerVersion}}"], {
        timeout: 3000,
        maxBuffer: 4096,
      }),
    ]);
    return {
      connectors,
      tools: result.map((r, i) => ({
        name: ["Codex", "Cursor", "Docker"][i],
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
  async list(source: "managed" | Agent, search = "", before?: string) {
    const publishedIds = this.overlays.host().publishedSessionIds;
    const main = this.overlays.snapshot();
    const publication = {
      publishedId:
        main.frames.length === 1 ? main.frames[0].conversation.id : undefined,
      publishedIds,
    };
    if (source === "cursor")
      return {
        conversations: [],
        note: connectors.cursor.note,
        ...publication,
      };
    if (source === "codex") {
      const page = await this.history.list(search, before);
      return {
        ...page,
        conversations: uniqueConversations(page.conversations),
        note: connectors.codex.note,
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
    const c = this.store.conversation(id);
    if (!c) throw new Error("Session not found");
    return c;
  }
  async models(cli: Agent, runner: "docker" | "native") {
    const defaults = this.preferences.get().value.sessions[0];
    return new CliRunner(
      this.hosts[runner],
      {
        sessions: [{ ...defaults, cli }],
        codexModel: "unused",
        cursorModel: "unused",
        experience: "session",
      },
      this.clean,
    ).discover(cli);
  }
  async create(
    cli: Agent,
    runner: "docker" | "native",
    nativeConsent?: string,
  ) {
    if (this.closing) throw new Error("The server is shutting down");
    if (!this.arenaIdle())
      throw new Error("Stop the prompt arena before starting a coding session");
    if (runner === "native" && nativeConsent !== "NATIVE")
      throw new Error(
        "Type NATIVE to explicitly allow managed agents to run on this computer without Docker isolation",
      );
    const config = this.preferences
      .get()
      .value.sessions.find((s) => s.cli === cli);
    if (!config) throw new Error("Choose and save this CLI/model first");
    // Native approval is an explicit local UI choice, just like the legacy startup policy.
    if (runner === "native") process.env.ARENA_NATIVE_APPROVED = "1";
    const c: Conversation = {
      id: `managed:${randomUUID()}`,
      source: "managed",
      cli,
      title: "New coding session",
      project: "Isolated managed workspace",
      updatedAt: Date.now(),
      model: config.model,
      config: structuredClone(config),
      runner,
      status: "idle",
    };
    this.store.saveConversation(c);
    this.experience = "session";
    this.emit("state");
    return c;
  }
  private visibility(c: Conversation) {
    const doc = this.preferences.get().value;
    return (
      doc.visibility[c.id] ??
      doc.visibility[
        c.config?.id ??
          doc.sessions.find((s) => s.cli === c.cli)?.id ??
          doc.sessions[0].id
      ] ??
      defaultVisibility
    );
  }
  private filtered(c: Conversation, page: TimelinePage): TimelinePage {
    const visibility = this.visibility(c);
    return {
      ...page,
      latestRun: page.latestRun ?? page.items.at(-1)?.run,
      items: page.items.filter(
        (i) => i.kind === "prompt" || visibility[i.kind],
      ),
    };
  }
  private async rawPage(c: Conversation, before?: string, limit = 60) {
    if (
      c.source === "managed" &&
      before &&
      (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)))
    )
      throw new Error("Invalid history cursor");
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
      page: this.filtered(c, page),
      visibility,
      hidePreviousRuns: !!visibility.hidePreviousRuns,
      published: this.overlays.isPublished(id),
    };
  }
  private safePublic(view: SessionView): SessionView {
    view = {
      ...view,
      visibility: this.visibility(view.conversation),
      page: this.filtered(view.conversation, view.page),
      hidePreviousRuns: !!this.visibility(view.conversation).hidePreviousRuns,
    };
    const {
      config: _config,
      providerId: _provider,
      pendingRun: _pending,
      ...c
    } = view.conversation;
    return {
      ...view,
      conversation: {
        ...c,
        project: "",
        model: view.visibility.model ? c.model : undefined,
      },
      published: true,
    };
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
  arena() {
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
    if (c.source !== "managed")
      throw new Error(
        "External sessions are read-only. Start a managed session to send prompts.",
      );
    if (c.runner === "native" && process.env.ARENA_NATIVE_APPROVED !== "1") {
      if (nativeConsent !== "NATIVE")
        throw new Error(
          "Type NATIVE to approve this server's native runs before sending a prompt",
        );
      process.env.ARENA_NATIVE_APPROVED = "1";
    }
    if (this.active.has(id))
      throw new Error("This session already has a prompt running");
    // A new session's default model must never silently change an older session's next prompt.
    const config = {
      ...c.config!,
      ...this.preferences.get().value.managedModels?.[id],
    };
    const run = randomUUID(),
      round = this.store.roundId();
    const now = Date.now();
    // Bounded recent context is supplied to a fresh CLI process; files stay in this session's workspace.
    const context = this.store
      .conversationPage(id)
      .items.filter((i) => ["prompt", "message"].includes(i.kind))
      .map((i) => `${i.kind}: ${i.text}`)
      .join("\n")
      .slice(-24000);
    const add = (item: TimelineItem) => {
      this.store.conversationItem(id, {
        ...item,
        text: this.clean(item.text, Infinity),
      });
    };
    add({ id: `${run}:prompt`, run, kind: "prompt", text, at: now });
    c.title =
      c.title === "New coding session" ? this.clean(text, 100) : c.title;
    c.model = config.model;
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
            experience: "session",
            workspaceKey: `conversation-${id.slice(8)}`,
          },
          this.clean,
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
            // Host-only command lanes remain private unless explicitly selected; read contents are never published.
            if (event.lane && !(event.lane === "read" && event.publicFile))
              return;
            add({
              id: `${run}:${event.id}`,
              run,
              at: event.at,
              kind: event.lane === "read" ? "read" : event.kind,
              text:
                event.lane === "read"
                  ? `Read ${event.publicFile}`
                  : event.kind === "complete"
                    ? "Agent finished"
                    : event.text,
            });
            c.status = "running";
            c.updatedAt = Date.now();
            this.store.saveConversation(c);
            if (this.overlays.hasPublished()) this.overlays.schedule();
          },
        );
        active.handle = handles[config.id];
        if (this.closing) await active.handle.stop("cancelled");
        const outcome = await active.handle.done;
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
    void execute();
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

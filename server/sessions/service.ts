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
  private published?: string;
  private publicPage?: SessionView;
  private history: CodexHistory;
  private active = new Map<
    string,
    { handle?: RunHandle; settled: Promise<void> }
  >();
  private refreshing = false;
  private refreshAgain = false;
  private closing = false;
  private rehearsals = new Set<string>();
  private publicationMode?: "live" | "rehearsal";
  private updateTimer?: ReturnType<typeof setTimeout>;
  readonly recoveryRunners: Set<"docker" | "native">;
  private publicationVersion = 0;
  private timer: ReturnType<typeof setInterval>;
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
    // Poll persisted history, never resume a thread or subscribe to another agent's stdin.
    this.timer = setInterval(() => {
      if (this.published?.startsWith("codex:") && !this.refreshing)
        void this.refreshPublished();
    }, 5000);
    this.timer.unref();
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
    if (source === "cursor")
      return {
        conversations: [],
        note: connectors.cursor.note,
        publishedId: this.published,
      };
    if (source === "codex")
      return {
        ...(await this.history.list(search, before)),
        note: connectors.codex.note,
        publishedId: this.published,
      };
    return {
      ...this.store.conversations(search, before ? Number(before) : undefined),
      publishedId: this.published,
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
  private async rawPage(c: Conversation, before?: string) {
    if (
      c.source === "managed" &&
      before &&
      (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)))
    )
      throw new Error("Invalid history cursor");
    return c.source === "codex"
      ? this.history.page(c.providerId!, before)
      : this.store.conversationPage(c.id, before ? Number(before) : undefined);
  }
  async view(id: string, before?: string): Promise<SessionView> {
    const c = await this.get(id),
      page = await this.rawPage(c, before),
      visibility = this.visibility(c);
    return {
      conversation: c,
      page: this.filtered(c, page),
      visibility,
      hidePreviousRuns: !!visibility.hidePreviousRuns,
      published: this.published === id,
    };
  }
  private safePublic(view: SessionView): SessionView {
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
    if (!this.arenaIdle())
      throw new Error("Stop the prompt arena before publishing a session");
    const version = ++this.publicationVersion;
    const mode = this.preferences.get().value.stream.mode;
    if (mode === "live") {
      if (!this.rehearsals.has(id))
        throw new Error(
          "Preview this session in rehearsal mode and confirm the private rehearsal before publishing live",
        );
      let ready = false;
      try {
        ready = await this.liveReady();
      } catch {
        /* OBS errors remain private. */
      }
      if (!ready)
        throw new Error(
          "Start the OBS broadcast manually first. Opening OBS does not start streaming.",
        );
    }
    const view = await this.view(id);
    if (mode !== this.preferences.get().value.stream.mode)
      throw new Error(
        "Stream mode changed while preparing publication; preview and retry",
      );
    if (version !== this.publicationVersion)
      throw new Error("Publication changed in another tab; preview and retry");
    this.published = id;
    this.publicationMode = mode;
    this.publicPage = { ...view, published: true };
    this.experience = "session";
    this.emit("state");
  }
  stopPublication() {
    ++this.publicationVersion;
    this.published = undefined;
    this.publicPage = undefined;
    this.emit("state");
  }
  confirmRehearsal(id: string) {
    if (
      this.preferences.get().value.stream.mode !== "rehearsal" ||
      this.published !== id ||
      !this.publicPage?.page.items.length
    )
      throw new Error(
        "Publish this session to the private rehearsal overlay and inspect it first",
      );
    if (this.active.has(id))
      throw new Error(
        "Wait for the current managed prompt to finish before confirming rehearsal",
      );
    if (
      this.publicPage.conversation.source === "managed" &&
      this.store.conversationPage(id).items.at(-1)?.kind !== "complete"
    )
      throw new Error(
        "Complete a successful private prompt before confirming rehearsal",
      );
    this.rehearsals.add(id);
  }
  obsDisconnected() {
    if (this.preferences.get().value.stream.mode === "live")
      this.stopPublication();
  }
  async publicHistory(id: string, before?: string) {
    const version = this.publicationVersion;
    if (!this.published || id !== this.published)
      throw new Error("This session is not on stream");
    const page = await this.view(id, before);
    if (version !== this.publicationVersion || id !== this.published)
      throw new Error("Publication changed");
    return this.safePublic(page);
  }
  private async refreshPublished() {
    if (!this.published) return;
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    const id = this.published,
      version = this.publicationVersion;
    try {
      const view = await this.view(id);
      if (version === this.publicationVersion) {
        this.publicPage = { ...view, published: true };
        this.emit("state");
      }
    } catch {
      if (this.publicPage && version === this.publicationVersion) {
        this.publicPage.conversation.status = "disconnected";
        this.emit("state");
      }
    } finally {
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refreshPublished();
      }
    }
  }
  private scheduleRefresh() {
    this.updateTimer ??= setTimeout(() => {
      this.updateTimer = undefined;
      void this.refreshPublished();
    }, 250);
  }
  settingsChanged() {
    if (
      this.published &&
      this.publicationMode !== this.preferences.get().value.stream.mode
    )
      this.stopPublication();
    else void this.refreshPublished();
  }
  snapshot(base: ShowState): ShowState {
    if (this.experience === "arena") return { ...base, experience: "arena" };
    // No private preview, arena task or inactive session enters the public snapshot.
    return {
      status: "paused",
      mode: this.preferences.get().value.stream.mode,
      experience: this.experience,
      reason: this.published
        ? "Selected session on stream"
        : "No session on stream",
      candidates: [],
      candidateCount: 0,
      events: [],
      connections: {},
      checks: [],
      rehearsalComplete: base.rehearsalComplete,
      sharedSession: this.publicPage
        ? this.safePublic({
            ...this.publicPage,
            visibility: this.visibility(this.publicPage.conversation),
            hidePreviousRuns: !!this.visibility(this.publicPage.conversation)
              .hidePreviousRuns,
            page: this.filtered(
              this.publicPage.conversation,
              this.publicPage.page,
            ),
          })
        : undefined,
    };
  }
  arena() {
    if (this.active.size)
      throw new Error(
        "Wait for managed prompts to finish before opening the prompt arena",
      );
    this.stopPublication();
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
    if (this.published === id) this.scheduleRefresh();
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
            if (this.published === id) this.scheduleRefresh();
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
        if (this.published === id) await this.refreshPublished();
        this.emit("state");
      }
    };
    void execute();
    return { run };
  }
  async close() {
    this.closing = true;
    clearTimeout(this.updateTimer);
    clearInterval(this.timer);
    this.history.close();
    this.stopPublication();
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

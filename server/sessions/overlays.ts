import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import {
  MAX_OVERLAYS,
  MAX_OVERLAY_SESSIONS,
  type Conversation,
  type OverlayDefinition,
  type OverlayDocument,
  type OverlayHostDocument,
  type OverlaySelection,
  type OverlayView,
  type SessionView,
} from "../../shared/sessions.js";

interface OverlaySources {
  name(text: string): string;
  view(id: string, before?: string): Promise<SessionView>;
  publicView(view: SessionView): SessionView;
  running(): Conversation[];
  eligible(id: string): boolean;
  approve(ids: string[]): Promise<void>;
}

// A named output owns its assignment and URL; processes and private previews have separate owners.
export class Overlays extends EventEmitter {
  private document: OverlayDocument;
  private pages = new Map<string, SessionView>();
  private reads = new Map<string, Promise<SessionView>>();
  private failures = new Set<string>();
  private epoch = 0;
  private editing = false;
  private closed = false;
  private refreshing = false;
  private refreshAgain = false;
  private update?: ReturnType<typeof setTimeout>;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private store: Store,
    private sources: OverlaySources,
  ) {
    super();
    const saved = store.overlays();
    this.document = saved ?? {
      revision: 0,
      overlays: [
        {
          id: "default",
          name: "Main overlay",
          selection: "selected",
          sessionIds: [],
          published: false,
        },
      ],
    };
    // Restart restores assignments, but the streamer must explicitly publish again.
    if (this.document.overlays.some((overlay) => overlay.published)) {
      this.document.overlays = this.document.overlays.map((overlay) => ({
        ...overlay,
        published: false,
      }));
      this.document.revision++;
      store.saveOverlays(this.document);
    }
    this.timer = setInterval(() => {
      void this.refresh();
    }, 5000);
    this.timer.unref();
  }
  private definition(id: string) {
    const definition = this.document.overlays.find(
      (overlay) => overlay.id === id,
    );
    if (!definition)
      throw new Error("Overlay no longer exists. Reload overlays.");
    return definition;
  }
  private selection(definition: OverlayDefinition) {
    if (definition.selection !== "follow-running")
      return {
        ids: definition.sessionIds,
        omitted: Math.max(
          0,
          (definition.capturedTotal ?? 0) - definition.sessionIds.length,
        ),
      };
    const running = this.sources.running();
    const eligible = running.filter((conversation) =>
      this.sources.eligible(conversation.id),
    );
    const ids = eligible
      .slice(0, MAX_OVERLAY_SESSIONS)
      .map((conversation) => conversation.id);
    return { ids, omitted: running.length - ids.length };
  }
  host(): OverlayHostDocument {
    return {
      revision: this.document.revision,
      overlays: this.document.overlays.map((overlay) => ({
        ...structuredClone(overlay),
        sessionIds: [...this.selection(overlay).ids],
      })),
      running: this.sources.running(),
      publishedSessionIds: [
        ...new Set(
          this.document.overlays
            .filter((overlay) => overlay.published)
            .flatMap((overlay) => this.selection(overlay).ids),
        ),
      ],
    };
  }
  isPublished(sessionId: string, overlayId?: string) {
    return this.document.overlays.some(
      (overlay) =>
        overlay.published &&
        (!overlayId || overlay.id === overlayId) &&
        this.selection(overlay).ids.includes(sessionId),
    );
  }
  hasPublished() {
    return this.document.overlays.some((overlay) => overlay.published);
  }
  private commit(overlays: OverlayDefinition[]) {
    this.document = { revision: this.document.revision + 1, overlays };
    this.store.saveOverlays(this.document);
    this.prune();
    this.emit("state");
  }
  private check(revision: number) {
    if (this.closed) throw new Error("The server is shutting down.");
    if (revision !== this.document.revision)
      throw new Error(
        "Overlays changed in another tab. Reload before applying.",
      );
    if (this.editing)
      throw new Error(
        "Another overlay change is still being prepared. Retry shortly.",
      );
  }
  create(revision: number, name: string) {
    this.check(revision);
    if (this.document.overlays.length >= MAX_OVERLAYS)
      throw new Error(
        "A maximum of " + MAX_OVERLAYS + " overlays is supported.",
      );
    const overlay: OverlayDefinition = {
      id: randomUUID(),
      name: this.sources.name(name),
      selection: "selected",
      sessionIds: [],
      published: false,
    };
    this.commit([...this.document.overlays, overlay]);
    return { ...this.host(), createdId: overlay.id };
  }
  remove(revision: number, id: string) {
    this.check(revision);
    if (id === "default")
      throw new Error("The main overlay cannot be deleted.");
    this.definition(id);
    this.epoch++;
    this.commit(this.document.overlays.filter((overlay) => overlay.id !== id));
    return this.host();
  }
  async save(
    revision: number,
    input: Pick<
      OverlayDefinition,
      "id" | "name" | "selection" | "sessionIds" | "published"
    >,
    captureRunning = false,
  ) {
    this.check(revision);
    const old = this.definition(input.id);
    const unique = [...new Set(input.sessionIds)];
    if (unique.length > MAX_OVERLAY_SESSIONS)
      throw new Error("Choose no more than eight sessions in one overlay.");
    let ids = unique,
      capturedAt: number | undefined,
      capturedTotal: number | undefined;
    if (
      input.selection === "running-snapshot" &&
      old.selection === "running-snapshot" &&
      !captureRunning
    ) {
      ids = [...old.sessionIds];
      capturedAt = old.capturedAt;
      capturedTotal = old.capturedTotal;
    } else if (input.selection !== "selected") {
      const running = this.sources.running();
      capturedAt = Date.now();
      capturedTotal = running.length;
      ids = running
        .filter(
          (conversation) =>
            input.selection === "running-snapshot" ||
            this.sources.eligible(conversation.id),
        )
        .slice(0, MAX_OVERLAY_SESSIONS)
        .map((conversation) => conversation.id);
    }
    const next: OverlayDefinition = {
      ...input,
      name: this.sources.name(input.name),
      sessionIds: ids,
      capturedAt,
      capturedTotal,
    };
    if (input.selection === "selected" && input.published && !ids.length)
      throw new Error(
        "Tick at least one session before publishing this overlay.",
      );
    const epoch = this.epoch;
    this.editing = true;
    try {
      let prepared: (SessionView | undefined)[] | undefined;
      if (next.published) await this.sources.approve(ids);
      // Validate only changed assignments; renames and stopping do not probe a provider.
      if (
        next.published ||
        JSON.stringify(ids) !== JSON.stringify(old.sessionIds)
      ) {
        prepared = await this.read(ids);
        if (prepared.some((view) => !view))
          throw new Error(
            "A selected session is unavailable. Nothing changed; refresh the session list.",
          );
      }
      if (epoch !== this.epoch || revision !== this.document.revision)
        throw new Error(
          "Publication changed while preparing this overlay. Reload and retry.",
        );
      prepared?.forEach((view, index) => {
        if (view) this.pages.set(ids[index], view);
      });
      this.commit(
        this.document.overlays.map((overlay) =>
          overlay.id === next.id ? next : overlay,
        ),
      );
      if (next.published) this.schedule();
      return this.host();
    } finally {
      this.editing = false;
    }
  }
  async publishSingle(id: string) {
    const main = this.definition("default");
    return this.save(this.document.revision, {
      ...main,
      selection: "selected",
      sessionIds: [id],
      published: true,
    });
  }
  stop(id = "default") {
    this.epoch++;
    const overlay = this.definition(id);
    if (overlay.published)
      this.commit(
        this.document.overlays.map((value) =>
          value.id === id ? { ...value, published: false } : value,
        ),
      );
    else this.emit("state");
  }
  stopAll() {
    this.epoch++;
    if (this.hasPublished())
      this.commit(
        this.document.overlays.map((overlay) => ({
          ...overlay,
          published: false,
        })),
      );
  }
  snapshot(id = "default"): OverlayView {
    const definition = this.document.overlays.find(
      (overlay) => overlay.id === id,
    );
    if (!definition?.published)
      return {
        id,
        name: "Overlay",
        revision: this.document.revision,
        published: false,
        frames: [],
        omittedRunning: 0,
      };
    const selection = this.selection(definition);
    return {
      id,
      name: definition.name,
      revision: this.document.revision,
      published: true,
      frames: selection.ids.flatMap((sessionId) => {
        const page = this.pages.get(sessionId);
        return page
          ? [
              this.sources.publicView(
                this.failures.has(sessionId)
                  ? {
                      ...page,
                      conversation: {
                        ...page.conversation,
                        status: "disconnected",
                      },
                    }
                  : page,
              ),
            ]
          : [];
      }),
      omittedRunning: selection.omitted,
      error: selection.ids.some((sessionId) => this.failures.has(sessionId))
        ? "Some sessions disconnected; keeping available history."
        : undefined,
    };
  }
  async history(overlayId: string, sessionId: string, before?: string) {
    const revision = this.document.revision,
      epoch = this.epoch;
    if (!this.isPublished(sessionId, overlayId))
      throw new Error("This session is not on this overlay.");
    const page = await this.sources.view(sessionId, before);
    if (
      revision !== this.document.revision ||
      epoch !== this.epoch ||
      !this.isPublished(sessionId, overlayId)
    )
      throw new Error("Overlay selection changed. Reload history.");
    return this.sources.publicView(page);
  }
  private async read(ids: string[]) {
    const values: (SessionView | undefined)[] = [];
    const epoch = this.epoch;
    // Four concurrent history reads bound provider work, independent of how many outputs reuse a session.
    for (let offset = 0; offset < ids.length; offset += 4) {
      if (this.closed || epoch !== this.epoch) break;
      const part = ids.slice(offset, offset + 4);
      const results = await Promise.allSettled(
        part.map((id) => {
          let request = this.reads.get(id);
          if (!request) {
            request = this.sources.view(id).finally(() => {
              if (this.reads.get(id) === request) this.reads.delete(id);
            });
            this.reads.set(id, request);
          }
          return request;
        }),
      );
      results.forEach((result, index) => {
        const id = part[index];
        if (result.status === "fulfilled") {
          this.pages.set(id, result.value);
          this.failures.delete(id);
          values.push(result.value);
        } else {
          this.failures.add(id);
          values.push(undefined);
        }
      });
    }
    return values;
  }
  schedule() {
    if (this.closed) return;
    this.update ??= setTimeout(() => {
      this.update = undefined;
      void this.refresh();
    }, 250);
  }
  private prune() {
    const selected = new Set(
      this.document.overlays
        .filter((overlay) => overlay.published)
        .flatMap((overlay) => this.selection(overlay).ids),
    );
    for (const id of this.pages.keys())
      if (!selected.has(id)) this.pages.delete(id);
    for (const id of this.failures)
      if (!selected.has(id)) this.failures.delete(id);
  }
  async refresh() {
    if (this.closed || !this.hasPublished()) return;
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    const epoch = this.epoch;
    try {
      const ids = [
        ...new Set(
          this.document.overlays
            .filter((overlay) => overlay.published)
            .flatMap((overlay) => this.selection(overlay).ids),
        ),
      ];
      await this.read(ids);
      if (epoch === this.epoch) {
        this.prune();
        this.emit("state");
      }
    } finally {
      this.prune();
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.schedule();
      }
    }
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.update);
    this.stopAll();
  }
}

import { legacyCli, legacyModel } from "../shared/types.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Activity,
  Candidate,
  Evaluation,
  Round,
  ShowState,
} from "../shared/types.js";
function migrateRound(round: Round): Round {
  // IDs remain unchanged because they are also the original output directories.
  round.sessions ??= Object.entries(round.attempts).flatMap(([id, attempt]) => {
    const cli = legacyCli(id);
    return cli && attempt.status !== "idle" ? [{ id, cli, model: attempt.model }] : [];
  });
  for (const session of round.sessions) {
    if (session.cli === "codex" && !session.effort)
      Object.assign(session, legacyModel(session.model));
    const attempt = round.attempts[session.id];
    if (!attempt) continue;
    attempt.cli ??= session.cli;
    if (session.cli === "codex" && !attempt.effort)
      Object.assign(attempt, legacyModel(attempt.model));
  }
  return round;
}
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS presentation (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS last_setup (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS overlay_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_items (seq INTEGER PRIMARY KEY AUTOINCREMENT, conversation TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(conversation,id));
      CREATE INDEX IF NOT EXISTS conversation_page ON conversation_items(conversation,seq);
      CREATE TABLE IF NOT EXISTS media_assets (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quick_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, window INTEGER NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evaluations (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, window INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, round INTEGER NOT NULL, at INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS containers (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS gifts (viewer TEXT PRIMARY KEY, at INTEGER NOT NULL, evidence TEXT NOT NULL);`);
  }
  // Session-scoped keyset pages retain old prompts without loading a whole transcript.
  presentation(): (import("../shared/presentation.js").Presentation & Partial<Pick<import("../shared/presentation.js").SavedPresentation, "outputs" | "revision">>) | undefined {
    const row = this.db.prepare("SELECT value FROM presentation WHERE id=1").get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  savePresentation(value: import("../shared/presentation.js").SavedPresentation) {
    this.db.prepare("INSERT OR REPLACE INTO presentation VALUES (1,?)").run(JSON.stringify(value));
  }
  lastSetup(): import("../shared/settings.js").LastSetup | undefined {
    const row = this.db.prepare("SELECT value FROM last_setup WHERE id=1").get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  saveLastSetup(value: import("../shared/settings.js").LastSetup) {
    this.db.prepare("INSERT OR REPLACE INTO last_setup VALUES (1,?)").run(JSON.stringify(value));
  }
  overlays(): import("../shared/sessions.js").OverlayDocument | undefined {
    const row = this.db.prepare("SELECT value FROM overlay_settings WHERE id=1").get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  saveOverlays(document: import("../shared/sessions.js").OverlayDocument) {
    this.db.prepare("INSERT OR REPLACE INTO overlay_settings VALUES (1,?)").run(JSON.stringify(document));
  }
  conversation(id: string): import("../shared/sessions.js").Conversation | undefined {
    const row = this.db.prepare("SELECT value FROM conversations WHERE id=?").get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  saveConversation(value: import("../shared/sessions.js").Conversation) {
    this.db.prepare("INSERT INTO conversations VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(value.id, JSON.stringify(value));
  }
  conversations(search = "", before = Number.MAX_SAFE_INTEGER) {
    const rows = this.db.prepare("SELECT rowid,value FROM conversations WHERE rowid<? ORDER BY rowid DESC LIMIT 31").all(before) as { rowid: number; value: string }[];
    return { conversations: rows.slice(0, 30).map((r) => JSON.parse(r.value) as import("../shared/sessions.js").Conversation)
      .filter((c) => `${c.title} ${c.project} ${c.cli}`.toLowerCase().includes(search.toLowerCase())),
      before: rows.length > 30 ? String(rows[29].rowid) : undefined };
  }
  conversationItem(conversation: string, item: import("../shared/sessions.js").TimelineItem) {
    // Long messages become stable page-sized fragments instead of losing their tail.
    const write = this.db.prepare("INSERT INTO conversation_items(conversation,id,value) VALUES (?,?,?) ON CONFLICT(conversation,id) DO UPDATE SET value=excluded.value");
    const prefix = `${item.id}:fragment:`;
    let offset = 0, part = 0;
    do {
      let end = Math.min(offset + 16000, item.text.length);
      if (end < item.text.length && /[\uD800-\uDBFF]/.test(item.text[end - 1])) end--;
      const id = part === 0 ? item.id : `${prefix}${part}`;
      write.run(conversation, id, JSON.stringify({ ...item, id, text: item.text.slice(offset, end) }));
      offset = end; part++;
    } while (offset < item.text.length);
    const old = this.db.prepare("SELECT id FROM conversation_items WHERE conversation=? AND id>=? AND id<?").all(conversation, prefix, `${prefix}\uffff`) as { id: string }[];
    for (const row of old) if (Number(row.id.slice(prefix.length)) >= part)
      this.db.prepare("DELETE FROM conversation_items WHERE conversation=? AND id=?").run(conversation, row.id);
  }
  conversationPage(conversation: string, before = Number.MAX_SAFE_INTEGER, limit = 60): import("../shared/sessions.js").TimelinePage {
    const size = Math.max(1, Math.min(60, limit));
    const rows = this.db.prepare("SELECT seq,value FROM conversation_items WHERE conversation=? AND seq<? ORDER BY seq DESC LIMIT ?")
      .all(conversation, before, size + 1) as { seq: number; value: string }[];
    return { items: rows.slice(0,size).reverse().map((r) => JSON.parse(r.value)), before: rows.length > size ? String(rows[size - 1].seq) : undefined };
  }
  disconnectConversations() {
    const runners = new Set<"docker" | "native">();
    // A previous process being alive is never inferred from a saved status badge.
    for (const row of this.db.prepare("SELECT value FROM conversations").all() as {value: string}[]) {
      const c = JSON.parse(row.value) as import("../shared/sessions.js").Conversation;
      if (c.status === "running" || c.pendingRun) {
        if (c.runner) runners.add(c.runner);
        this.saveConversation({...c, status: "disconnected", pendingRun: false});
      }
    }
    return runners;
  }
  // Upload names are display labels only; file access always uses an opaque asset ID.
  mediaName(id: string): string | undefined {
    return (
      this.db.prepare("SELECT name FROM media_assets WHERE id=?").get(id) as
        { name: string } | undefined
    )?.name;
  }
  saveMediaName(id: string, name: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO media_assets VALUES (?,?)")
      .run(id, name);
  }
  // Host preferences are separate from show recovery and never contain credentials.
  quickSettings():
    import("../shared/settings.js").SettingsDocument | undefined {
    const row = this.db
      .prepare("SELECT value FROM quick_settings WHERE id=1")
      .get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  saveQuickSettings(
    document: import("../shared/settings.js").SettingsDocument,
  ) {
    this.db
      .prepare("INSERT OR REPLACE INTO quick_settings VALUES (1,?)")
      .run(JSON.stringify(document));
  }
  // Keyset pagination reads at most 21 rows, including the next-page marker.
  history(
    before = Number.MAX_SAFE_INTEGER,
  ): import("../shared/settings.js").HistoryPage {
    const rows = this.db
      .prepare(
        "SELECT id,value FROM rounds WHERE id<? AND value!='{}' ORDER BY id DESC LIMIT 21",
      )
      .all(before) as { id: number; value: string }[];
    return {
      rounds: rows.slice(0, 20).map((r) => migrateRound(JSON.parse(r.value))),
      before: rows.length > 20 ? rows[19].id : undefined,
    };
  }
  state(): ShowState | undefined {
    const row = this.db
      .prepare("SELECT value FROM state WHERE id=1")
      .get() as any;
    if (!row) return undefined;
    const state: ShowState = JSON.parse(row.value);
    if (state.round) migrateRound(state.round);
    return state;
  }
  save(state: ShowState) {
    this.db
      .prepare("INSERT OR REPLACE INTO state VALUES (1,?)")
      .run(JSON.stringify(state));
  }
  roundId() {
    return Number(
      this.db.prepare("INSERT INTO rounds(value) VALUES ('{}')").run()
        .lastInsertRowid,
    );
  }
  round(round: Round) {
    this.db
      .prepare("UPDATE rounds SET value=? WHERE id=?")
      .run(JSON.stringify(round), round.id);
  }
  candidate(candidate: Candidate, status = "eligible") {
    this.db
      .prepare("INSERT OR REPLACE INTO candidates VALUES (?,?,?,?)")
      .run(candidate.id, candidate.window, status, JSON.stringify(candidate));
  }
  candidateStatus(id: string, status: string) {
    this.db
      .prepare("UPDATE candidates SET status=? WHERE id=?")
      .run(status, id);
  }
  cache(key: string): Evaluation | undefined {
    const row = this.db
      .prepare("SELECT value FROM evaluations WHERE key=?")
      .get(key) as any;
    return row && JSON.parse(row.value);
  }
  cachePut(key: string, value: Evaluation) {
    this.db
      .prepare("INSERT OR REPLACE INTO evaluations VALUES (?,?)")
      .run(key, JSON.stringify(value));
  }
  decision(window: number, value: unknown) {
    this.db
      .prepare("INSERT INTO decisions(at,window,value) VALUES (?,?,?)")
      .run(Date.now(), window, JSON.stringify(value));
  }
  event(event: Activity) {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO events VALUES (?,?,?,?)")
        .run(event.id, event.round, event.at, JSON.stringify(event)).changes > 0
    );
  }
  replaceEvent(event: Activity) {
    this.db
      .prepare("UPDATE events SET at=?, value=? WHERE id=?")
      .run(event.at, JSON.stringify(event), event.id);
  }
  recent(round?: number): Activity[] {
    return (
      this.db
        .prepare(
          "SELECT value FROM events WHERE (? IS NULL OR round=?) ORDER BY at DESC LIMIT 160",
        )
        .all(round ?? null, round ?? null) as any[]
    )
      .reverse()
      .map((r) => JSON.parse(r.value));
  }
  seen(id: string) {
    const added =
      this.db
        .prepare("INSERT OR IGNORE INTO messages VALUES (?,?)")
        .run(id, Date.now()).changes > 0;
    return !added;
  }
  gift(viewer: string, evidence: string, at = Date.now()) {
    this.db
      .prepare("INSERT OR REPLACE INTO gifts VALUES (?,?,?)")
      .run(viewer, at, evidence);
  }
  giftEvidence(viewer: string, since: number): string | undefined {
    return (
      this.db
        .prepare("SELECT evidence FROM gifts WHERE viewer=? AND at>=?")
        .get(viewer, since) as any
    )?.evidence;
  }
  container(name: string) {
    this.db.prepare("INSERT OR IGNORE INTO containers VALUES (?)").run(name);
  }
  containers(): string[] {
    return (this.db.prepare("SELECT name FROM containers").all() as any[]).map(
      (r) => r.name,
    );
  }
  forgetContainer(name: string) {
    this.db.prepare("DELETE FROM containers WHERE name=?").run(name);
  }
  close() {
    try {
      this.db.close();
    } catch (error) {
      if (
        !/not open/i.test(
          error instanceof Error ? error.message : String(error),
        )
      )
        throw error;
    }
  }
}

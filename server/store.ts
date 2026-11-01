import { legacyCli, legacyModel } from "../shared/types.js";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { z } from "zod";
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
// Single-document settings live in one key -> JSON table. These are the
// tables they used to occupy (one row each, id=1); the constructor copies any
// legacy row across once and keeps the old table as a read-only backup.
const legacyDocuments = {
  presentation: "presentation",
  last_setup: "last_setup",
  overlays: "overlay_settings",
  quick_settings: "quick_settings",
  state: "state",
} as const;
type DocumentKey = keyof typeof legacyDocuments;
// Read-back checks cover only the fields readers dereference. Objects stay
// loose so unknown or newer fields survive a round trip; an invalid document
// is treated as missing, which is the same default callers use today.
const looseRecord = z.record(z.string(), z.looseObject({}));
const documentSchemas = {
  presentation: z.looseObject({
    revision: z.number().optional(),
    outputs: looseRecord.optional(),
  }),
  last_setup: z.looseObject({ savedAt: z.number() }),
  overlays: z.looseObject({
    revision: z.number(),
    overlays: z.array(z.looseObject({ id: z.string() })),
  }),
  quick_settings: z.looseObject({ revision: z.number(), value: z.unknown() }),
  state: z.looseObject({
    round: z.looseObject({ id: z.number(), attempts: looseRecord }).optional(),
    events: z.array(z.looseObject({ id: z.string() })).optional(),
  }),
} satisfies Record<DocumentKey, z.ZodType>;
export class Store {
  db: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_items (seq INTEGER PRIMARY KEY AUTOINCREMENT, conversation TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(conversation,id));
      CREATE INDEX IF NOT EXISTS conversation_page ON conversation_items(conversation,seq);
      CREATE TABLE IF NOT EXISTS media_assets (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, window INTEGER NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evaluations (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, window INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, round INTEGER NOT NULL, at INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS containers (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS gifts (viewer TEXT PRIMARY KEY, at INTEGER NOT NULL, evidence TEXT NOT NULL);`);
    this.migrateDocuments();
  }
  private migrateDocuments() {
    const existing = new Set(
      (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
        .map((row) => row.name),
    );
    this.transaction(() => {
      for (const [key, table] of Object.entries(legacyDocuments)) {
        if (!existing.has(table)) continue;
        // A document already in the new table is newer than the legacy copy.
        // The legacy table is left in place (never written again), so a failed upgrade
        // or an older build still finds its data; INSERT OR IGNORE makes reruns no-ops.
        this.db.prepare(`INSERT OR IGNORE INTO documents(key,value) SELECT ?, value FROM ${table} WHERE id=1`).run(key);
      }
    });
  }
  // Each SQL string is compiled once per connection and reused.
  private sql(text: string) {
    let statement = this.statements.get(text);
    if (!statement) {
      statement = this.db.prepare(text);
      this.statements.set(text, statement);
    }
    return statement;
  }
  // Runs fn atomically; nested calls join the outer transaction.
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private doc<T>(key: DocumentKey): T | undefined {
    const row = this.sql("SELECT value FROM documents WHERE key=?").get(key) as { value: string } | undefined;
    if (!row) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(row.value);
    } catch {
      return undefined;
    }
    return documentSchemas[key].safeParse(value).success ? (value as T) : undefined;
  }
  private saveDoc(key: DocumentKey, serialized: string) {
    this.sql("INSERT INTO documents(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, serialized);
  }
  // Session-scoped keyset pages retain old prompts without loading a whole transcript.
  presentation() {
    return this.doc<import("../shared/presentation.js").Presentation & Partial<Pick<import("../shared/presentation.js").SavedPresentation, "outputs" | "revision">>>("presentation");
  }
  savePresentation(value: import("../shared/presentation.js").SavedPresentation) {
    this.saveDoc("presentation", JSON.stringify(value));
  }
  lastSetup() {
    return this.doc<import("../shared/settings.js").LastSetup>("last_setup");
  }
  saveLastSetup(value: import("../shared/settings.js").LastSetup) {
    this.saveDoc("last_setup", JSON.stringify(value));
  }
  overlays() {
    return this.doc<import("../shared/sessions.js").OverlayDocument>("overlays");
  }
  saveOverlays(document: import("../shared/sessions.js").OverlayDocument) {
    this.saveDoc("overlays", JSON.stringify(document));
  }
  conversation(id: string): import("../shared/sessions.js").Conversation | undefined {
    const row = this.sql("SELECT value FROM conversations WHERE id=?").get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  saveConversation(value: import("../shared/sessions.js").Conversation) {
    this.sql("INSERT INTO conversations VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(value.id, JSON.stringify(value));
  }
  conversations(search = "", before = Number.MAX_SAFE_INTEGER) {
    // Search before LIMIT so every page holds up to 30 matches, not matches among 30 rows.
    // Wildcards in the query are escaped so "%" and "_" match literally.
    const pattern = `%${search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.sql(`SELECT rowid,value FROM conversations WHERE rowid<?
      AND lower(ifnull(json_extract(value,'$.title'),'')||' '||ifnull(json_extract(value,'$.project'),'')||' '||ifnull(json_extract(value,'$.cli'),'')) LIKE ? ESCAPE '\\'
      ORDER BY rowid DESC LIMIT 31`).all(before, pattern) as { rowid: number; value: string }[];
    return { conversations: rows.slice(0, 30).map((r) => JSON.parse(r.value) as import("../shared/sessions.js").Conversation),
      before: rows.length > 30 ? String(rows[29].rowid) : undefined };
  }
  conversationItem(conversation: string, item: import("../shared/sessions.js").TimelineItem) {
    // Long messages become stable page-sized fragments instead of losing their tail.
    // Fragments and stale-tail cleanup commit together so a page never mixes versions.
    this.transaction(() => {
      const write = this.sql("INSERT INTO conversation_items(conversation,id,value) VALUES (?,?,?) ON CONFLICT(conversation,id) DO UPDATE SET value=excluded.value");
      const prefix = `${item.id}:fragment:`;
      let offset = 0, part = 0;
      do {
        let end = Math.min(offset + 16000, item.text.length);
        if (end < item.text.length && /[\uD800-\uDBFF]/.test(item.text[end - 1])) end--;
        const id = part === 0 ? item.id : `${prefix}${part}`;
        write.run(conversation, id, JSON.stringify({ ...item, id, text: item.text.slice(offset, end) }));
        offset = end; part++;
      } while (offset < item.text.length);
      const old = this.sql("SELECT id FROM conversation_items WHERE conversation=? AND id>=? AND id<?").all(conversation, prefix, `${prefix}\uffff`) as { id: string }[];
      for (const row of old) if (Number(row.id.slice(prefix.length)) >= part)
        this.sql("DELETE FROM conversation_items WHERE conversation=? AND id=?").run(conversation, row.id);
    });
  }
  conversationPage(conversation: string, before = Number.MAX_SAFE_INTEGER, limit = 60): import("../shared/sessions.js").TimelinePage {
    const size = Math.max(1, Math.min(60, limit));
    const rows = this.sql("SELECT seq,value FROM conversation_items WHERE conversation=? AND seq<? ORDER BY seq DESC LIMIT ?")
      .all(conversation, before, size + 1) as { seq: number; value: string }[];
    return { items: rows.slice(0,size).reverse().map((r) => JSON.parse(r.value)), before: rows.length > size ? String(rows[size - 1].seq) : undefined };
  }
  disconnectConversations() {
    const runners = new Set<"docker" | "native">();
    // A previous process being alive is never inferred from a saved status badge.
    this.transaction(() => {
      for (const row of this.sql("SELECT value FROM conversations").all() as {value: string}[]) {
        const c = JSON.parse(row.value) as import("../shared/sessions.js").Conversation;
        if (c.status === "running" || c.pendingRun) {
          if (c.runner) runners.add(c.runner);
          this.saveConversation({...c, status: "disconnected", pendingRun: false});
        }
      }
    });
    return runners;
  }
  // Upload names are display labels only; file access always uses an opaque asset ID.
  mediaName(id: string): string | undefined {
    return (this.sql("SELECT name FROM media_assets WHERE id=?").get(id) as { name: string } | undefined)?.name;
  }
  saveMediaName(id: string, name: string) {
    this.sql("INSERT OR REPLACE INTO media_assets VALUES (?,?)").run(id, name);
  }
  // Host preferences are separate from show recovery and never contain credentials.
  quickSettings() {
    return this.doc<import("../shared/settings.js").SettingsDocument>("quick_settings");
  }
  saveQuickSettings(document: import("../shared/settings.js").SettingsDocument) {
    this.saveDoc("quick_settings", JSON.stringify(document));
  }
  // Keyset pagination reads at most 21 rows, including the next-page marker.
  history(before = Number.MAX_SAFE_INTEGER): import("../shared/settings.js").HistoryPage {
    const rows = this.sql("SELECT id,value FROM rounds WHERE id<? AND value!='{}' ORDER BY id DESC LIMIT 21")
      .all(before) as { id: number; value: string }[];
    return {
      rounds: rows.slice(0, 20).map((r) => migrateRound(JSON.parse(r.value))),
      before: rows.length > 20 ? rows[19].id : undefined,
    };
  }
  state(): ShowState | undefined {
    const state = this.doc<ShowState>("state");
    if (state?.round) migrateRound(state.round);
    return state;
  }
  // Callers that already serialized the state pass it to avoid a second stringify.
  // The current round's history row and the state document commit together.
  save(state: ShowState, serialized = JSON.stringify(state)) {
    this.transaction(() => {
      if (state.round) this.round(state.round);
      this.saveDoc("state", serialized);
    });
  }
  roundId() {
    return Number(this.sql("INSERT INTO rounds(value) VALUES ('{}')").run().lastInsertRowid);
  }
  round(round: Round) {
    this.sql("UPDATE rounds SET value=? WHERE id=?").run(JSON.stringify(round), round.id);
  }
  // Managed session runs need an ID that never collides with an arena round
  // (both name per-run output folders), but no history row. Inserting and
  // deleting in one transaction advances the AUTOINCREMENT sequence, which
  // SQLite never reuses, without leaving a placeholder behind.
  runId() {
    return this.transaction(() => {
      const id = this.roundId();
      this.sql("DELETE FROM rounds WHERE id=?").run(id);
      return id;
    });
  }
  // Retention for append-only tables, chosen conservatively:
  // - messages only de-duplicate chat and webhook redeliveries, which arrive
  //   within minutes or hours, so a week is ample;
  // - decisions and events are host-side audit trails kept for 30 days, and
  //   the current round's events are never removed, whatever their age
  //   (saved sessions keep their own transcript in conversation_items);
  // - evaluations are a judge cache with no timestamp, so the newest 5000
  //   (insert order) are kept and older entries are simply re-judged;
  // - '{}' rounds rows are placeholders from older managed runs or a crash
  //   between allocating and saving a round; history already hides them, and
  //   AUTOINCREMENT keeps their IDs from being reused.
  // Rounds, candidates, conversations and gifts are not pruned here.
  prune(now = Date.now()) {
    const day = 24 * 60 * 60 * 1000;
    const current = this.doc<ShowState>("state")?.round?.id ?? null;
    return this.transaction(() => ({
      messages: Number(this.sql("DELETE FROM messages WHERE at<?").run(now - 7 * day).changes),
      decisions: Number(this.sql("DELETE FROM decisions WHERE at<?").run(now - 30 * day).changes),
      events: Number(this.sql("DELETE FROM events WHERE at<? AND (? IS NULL OR round!=?)")
        .run(now - 30 * day, current, current).changes),
      evaluations: Number(this.sql(`DELETE FROM evaluations WHERE rowid<=
        (SELECT rowid FROM evaluations ORDER BY rowid DESC LIMIT 1 OFFSET 5000)`).run().changes),
      placeholders: Number(this.sql("DELETE FROM rounds WHERE value='{}'").run().changes),
    }));
  }
  candidate(candidate: Candidate, status = "eligible") {
    this.sql("INSERT OR REPLACE INTO candidates VALUES (?,?,?,?)")
      .run(candidate.id, candidate.window, status, JSON.stringify(candidate));
  }
  candidateStatus(id: string, status: string) {
    this.sql("UPDATE candidates SET status=? WHERE id=?").run(status, id);
  }
  cache(key: string): Evaluation | undefined {
    const row = this.sql("SELECT value FROM evaluations WHERE key=?").get(key) as { value: string } | undefined;
    return row && JSON.parse(row.value);
  }
  cachePut(key: string, value: Evaluation) {
    this.sql("INSERT OR REPLACE INTO evaluations VALUES (?,?)").run(key, JSON.stringify(value));
  }
  decision(window: number, value: unknown) {
    this.sql("INSERT INTO decisions(at,window,value) VALUES (?,?,?)").run(Date.now(), window, JSON.stringify(value));
  }
  event(event: Activity) {
    return this.sql("INSERT OR IGNORE INTO events VALUES (?,?,?,?)")
      .run(event.id, event.round, event.at, JSON.stringify(event)).changes > 0;
  }
  replaceEvent(event: Activity) {
    this.sql("UPDATE events SET at=?, value=? WHERE id=?").run(event.at, JSON.stringify(event), event.id);
  }
  recent(round?: number): Activity[] {
    return (this.sql("SELECT value FROM events WHERE (? IS NULL OR round=?) ORDER BY at DESC LIMIT 160")
      .all(round ?? null, round ?? null) as { value: string }[])
      .reverse()
      .map((r) => JSON.parse(r.value));
  }
  seen(id: string) {
    const added = this.sql("INSERT OR IGNORE INTO messages VALUES (?,?)").run(id, Date.now()).changes > 0;
    return !added;
  }
  gift(viewer: string, evidence: string, at = Date.now()) {
    this.sql("INSERT OR REPLACE INTO gifts VALUES (?,?,?)").run(viewer, at, evidence);
  }
  giftEvidence(viewer: string, since: number): string | undefined {
    return (this.sql("SELECT evidence FROM gifts WHERE viewer=? AND at>=?").get(viewer, since) as
      { evidence: string } | undefined)?.evidence;
  }
  container(name: string) {
    this.sql("INSERT OR IGNORE INTO containers VALUES (?)").run(name);
  }
  containers(): string[] {
    return (this.sql("SELECT name FROM containers").all() as { name: string }[]).map((r) => r.name);
  }
  forgetContainer(name: string) {
    this.sql("DELETE FROM containers WHERE name=?").run(name);
  }
  close() {
    this.statements.clear();
    try {
      this.db.close();
    } catch (error) {
      if (!/not open/i.test(error instanceof Error ? error.message : String(error)))
        throw error;
    }
  }
}

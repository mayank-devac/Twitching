import { legacyModel } from "../shared/types.js";
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
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
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
      rounds: rows.slice(0, 20).map((r) => JSON.parse(r.value)),
      before: rows.length > 20 ? rows[19].id : undefined,
    };
  }
  state(): ShowState | undefined {
    const row = this.db
      .prepare("SELECT value FROM state WHERE id=1")
      .get() as any;
    if (!row) return undefined;
    const state: ShowState = JSON.parse(row.value);
    if (state.round && !state.round.sessions) {
      // Legacy keys are also their original file directories. Never rename them.
      state.round.sessions = Object.entries(state.round.attempts)
        .filter(
          ([id, attempt]) =>
            (id === "codex" || id === "cursor") && attempt.status !== "idle",
        )
        .map(([id, attempt]) => {
          const cli = id as "codex" | "cursor";
          attempt.cli = cli;
          Object.assign(attempt, legacyModel(attempt.model));
          return {
            id,
            cli,
            model: attempt.model,
            ...(attempt.effort ? { effort: attempt.effort } : {}),
          };
        });
    }
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

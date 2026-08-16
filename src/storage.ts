/**
 * SQLite-backed storage for dejavu.
 *
 * Core memory tables: slips, links, handoffs, and recall_traces.
 * A separate messages table supports optional local coordination.
 * FTS5 virtual table on slips.text/tags powers recall().
 *
 * Atomic-immutable: rows are inserted, state transitions are updates to
 * `state` and `*_at` timestamps only. Text is never edited in place.
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  Anchor,
  Slip,
  SlipState,
  Link,
  LinkKind,
  Handoff,
  AgentMessage,
  MessageState,
  RecallTrace,
  MemoryKind,
  HandoffStatus,
  RecallAssessment,
} from "./types.ts";

export interface StorageOptions {
  /** Override DB path. Default: ~/.dejavu/dejavu.db (or :memory: in tests). */
  path?: string;
}

export function defaultDbPath(): string {
  return process.env.DEJAVU_DB ?? join(homedir(), ".dejavu", "dejavu.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slips (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  authored_by TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'legacy:global',
  kind        TEXT NOT NULL DEFAULT 'note',
  text        TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',  -- JSON array
  state       TEXT NOT NULL CHECK (state IN ('draft','kept','expired')),
  created_at  INTEGER NOT NULL,
  kept_at     INTEGER,
  expired_at  INTEGER,
  used_count  INTEGER NOT NULL DEFAULT 0,
  wrong_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_slips_session  ON slips(session_id);
CREATE INDEX IF NOT EXISTS idx_slips_state    ON slips(state);
CREATE INDEX IF NOT EXISTS idx_slips_created  ON slips(created_at);

CREATE TABLE IF NOT EXISTS links (
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('supersedes','contradicts','related')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, kind),
  FOREIGN KEY (from_id) REFERENCES slips(id),
  FOREIGN KEY (to_id)   REFERENCES slips(id)
);

CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_id);

-- Pointers from a slip to the code it is about. Immutable like slips:
-- rows are inserted once and never updated. The symbol column is stored as
-- '' rather than NULL so the primary key actually enforces uniqueness --
-- SQLite permits NULLs in a non-INTEGER primary key, which would otherwise
-- let duplicate anchors through.
CREATE TABLE IF NOT EXISTS anchors (
  slip_id    TEXT NOT NULL,
  path       TEXT NOT NULL,
  symbol     TEXT NOT NULL DEFAULT '',
  line       INTEGER,
  blob_sha   TEXT NOT NULL,
  commit_sha TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (slip_id, path, symbol),
  FOREIGN KEY (slip_id) REFERENCES slips(id)
);

CREATE INDEX IF NOT EXISTS idx_anchors_path ON anchors(path);
CREATE INDEX IF NOT EXISTS idx_anchors_slip ON anchors(slip_id);

CREATE TABLE IF NOT EXISTS handoffs (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL UNIQUE,  -- one handoff per session
  authored_by TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'legacy:global',
  summary     TEXT NOT NULL,
  kept        TEXT NOT NULL DEFAULT '[]',  -- JSON array of slip ids
  next        TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  status      TEXT NOT NULL DEFAULT 'active',
  automatic   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS recall_traces (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  authored_by TEXT NOT NULL,
  scope       TEXT NOT NULL,
  query       TEXT NOT NULL,
  hit_ids     TEXT NOT NULL DEFAULT '[]',
  handoff_id  TEXT,
  created_at  INTEGER NOT NULL,
  assessment  TEXT,
  assessed_at INTEGER,
  note        TEXT
);

CREATE INDEX IF NOT EXISTS idx_recall_traces_scope_created
  ON recall_traces(scope, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  from_author TEXT NOT NULL,
  to_author   TEXT NOT NULL,
  body        TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('pending','read','archived')),
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_to_state ON messages(to_author, state, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);

-- Porter stemming layered on top of unicode61. Catches morphological
-- variants ("prefers" matches "preferred", "deploy" matches "deployment").
-- Stemming is the cheapest possible win for natural-language queries
-- where the slip and the query don't share exact word forms.
CREATE VIRTUAL TABLE IF NOT EXISTS slips_fts USING fts5(
  text,
  tags,
  content='slips',
  content_rowid='rowid',
  tokenize="porter unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS slips_ai AFTER INSERT ON slips BEGIN
  INSERT INTO slips_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS slips_ad AFTER DELETE ON slips BEGIN
  INSERT INTO slips_fts(slips_fts, rowid, text, tags)
    VALUES ('delete', old.rowid, old.text, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS slips_au AFTER UPDATE OF text, tags ON slips BEGIN
  INSERT INTO slips_fts(slips_fts, rowid, text, tags)
    VALUES ('delete', old.rowid, old.text, old.tags);
  INSERT INTO slips_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;
`;

interface SlipRow {
  id: string;
  session_id: string;
  authored_by: string;
  scope: string;
  kind: MemoryKind;
  text: string;
  tags: string;
  state: SlipState;
  created_at: number;
  kept_at: number | null;
  expired_at: number | null;
  used_count: number;
  wrong_count: number;
}

function rowToSlip(r: SlipRow): Slip {
  return {
    id: r.id,
    sessionId: r.session_id,
    authoredBy: r.authored_by,
    scope: r.scope,
    kind: r.kind,
    text: r.text,
    tags: JSON.parse(r.tags) as string[],
    state: r.state,
    createdAt: r.created_at,
    keptAt: r.kept_at,
    expiredAt: r.expired_at,
    usedCount: r.used_count,
    wrongCount: r.wrong_count,
  };
}

interface HandoffRow {
  id: string;
  session_id: string;
  authored_by: string;
  scope: string;
  summary: string;
  kept: string;
  next: string;
  status: HandoffStatus;
  automatic: number;
  created_at: number;
  resolved_at: number | null;
}

function rowToHandoff(r: HandoffRow): Handoff {
  return {
    id: r.id,
    sessionId: r.session_id,
    authoredBy: r.authored_by,
    scope: r.scope,
    summary: r.summary,
    kept: JSON.parse(r.kept) as string[],
    next: JSON.parse(r.next) as string[],
    status: r.status,
    automatic: r.automatic === 1,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

interface AnchorRow {
  slip_id: string;
  path: string;
  symbol: string;
  line: number | null;
  blob_sha: string;
  commit_sha: string | null;
  created_at: number;
}

function rowToAnchor(r: AnchorRow): Anchor {
  return {
    slipId: r.slip_id,
    path: r.path,
    symbol: r.symbol === "" ? null : r.symbol,
    line: r.line,
    blobSha: r.blob_sha,
    commit: r.commit_sha,
    createdAt: r.created_at,
  };
}

interface MessageRow {
  id: string;
  thread_id: string;
  from_author: string;
  to_author: string;
  body: string;
  state: MessageState;
  created_at: number;
  read_at: number | null;
}

function rowToMessage(r: MessageRow): AgentMessage {
  return {
    id: r.id,
    threadId: r.thread_id,
    from: r.from_author,
    to: r.to_author,
    body: r.body,
    state: r.state,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}

export class Storage {
  readonly db: Database;
  readonly path: string;

  constructor(opts: StorageOptions = {}) {
    this.path = opts.path ?? defaultDbPath();
    if (this.path !== ":memory:") {
      mkdirSync(dirname(this.path), { recursive: true });
    }
    this.db = new Database(this.path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.ensureScopeColumns();
  }

  /** Add repository scoping to databases created before v0.0.4. */
  private ensureScopeColumns(): void {
    const slipColumns = this.db.prepare(`PRAGMA table_info(slips)`).all() as Array<{ name: string }>;
    if (!slipColumns.some((column) => column.name === "scope")) {
      this.db.exec(`ALTER TABLE slips ADD COLUMN scope TEXT NOT NULL DEFAULT 'legacy:global'`);
    }
    if (!slipColumns.some((column) => column.name === "kind")) {
      this.db.exec(`ALTER TABLE slips ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'`);
    }
    const handoffColumns = this.db.prepare(`PRAGMA table_info(handoffs)`).all() as Array<{ name: string }>;
    if (!handoffColumns.some((column) => column.name === "scope")) {
      this.db.exec(`ALTER TABLE handoffs ADD COLUMN scope TEXT NOT NULL DEFAULT 'legacy:global'`);
    }
    if (!handoffColumns.some((column) => column.name === "status")) {
      this.db.exec(`ALTER TABLE handoffs ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
    }
    if (!handoffColumns.some((column) => column.name === "resolved_at")) {
      this.db.exec(`ALTER TABLE handoffs ADD COLUMN resolved_at INTEGER`);
    }
    if (!handoffColumns.some((column) => column.name === "automatic")) {
      this.db.exec(`ALTER TABLE handoffs ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0`);
    }
    const traceColumns = this.db.prepare(`PRAGMA table_info(recall_traces)`).all() as Array<{ name: string }>;
    if (!traceColumns.some((column) => column.name === "assessment")) {
      this.db.exec(`ALTER TABLE recall_traces ADD COLUMN assessment TEXT`);
    }
    if (!traceColumns.some((column) => column.name === "assessed_at")) {
      this.db.exec(`ALTER TABLE recall_traces ADD COLUMN assessed_at INTEGER`);
    }
    if (!traceColumns.some((column) => column.name === "note")) {
      this.db.exec(`ALTER TABLE recall_traces ADD COLUMN note TEXT`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_slips_scope_state ON slips(scope, state)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_handoffs_scope_created ON handoffs(scope, created_at)`);
  }

  close(): void {
    this.db.close();
  }

  // ----- slips -----

  insertSlip(s: Slip): void {
    this.db
      .prepare(
        `INSERT INTO slips
         (id, session_id, authored_by, scope, kind, text, tags, state, created_at, kept_at, expired_at, used_count, wrong_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id,
        s.sessionId,
        s.authoredBy,
        s.scope,
        s.kind ?? "note",
        s.text,
        JSON.stringify(s.tags),
        s.state,
        s.createdAt,
        s.keptAt,
        s.expiredAt,
        s.usedCount,
        s.wrongCount,
      );
  }

  getSlip(id: string): Slip | null {
    const r = this.db
      .prepare(`SELECT * FROM slips WHERE id = ?`)
      .get(id) as SlipRow | null;
    return r ? rowToSlip(r) : null;
  }

  setState(id: string, state: SlipState, at: number): boolean {
    const stmt =
      state === "kept"
        ? `UPDATE slips SET state = 'kept',    kept_at    = ? WHERE id = ?`
        : state === "expired"
          ? `UPDATE slips SET state = 'expired', expired_at = ? WHERE id = ?`
          : `UPDATE slips SET state = 'draft' WHERE id = ?`;
    const args = state === "draft" ? [id] : [at, id];
    const res = this.db.prepare(stmt).run(...args);
    return res.changes > 0;
  }

  bumpUsed(id: string): void {
    this.db
      .prepare(`UPDATE slips SET used_count = used_count + 1 WHERE id = ?`)
      .run(id);
  }

  bumpWrong(id: string): void {
    this.db
      .prepare(`UPDATE slips SET wrong_count = wrong_count + 1 WHERE id = ?`)
      .run(id);
  }

  /** Expire all drafts older than `cutoff` ms. Returns count. */
  gcDrafts(cutoff: number, now: number): number {
    const res = this.db
      .prepare(
        `UPDATE slips SET state = 'expired', expired_at = ?
         WHERE state = 'draft' AND created_at < ?`,
      )
      .run(now, cutoff);
    return res.changes;
  }

  listBySession(sessionId: string, scope?: string): Slip[] {
    const rows = scope
      ? this.db
          .prepare(`SELECT * FROM slips WHERE session_id = ? AND scope = ? ORDER BY created_at ASC`)
          .all(sessionId, scope) as SlipRow[]
      : this.db
          .prepare(`SELECT * FROM slips WHERE session_id = ? ORDER BY created_at ASC`)
          .all(sessionId) as SlipRow[];
    return rows.map(rowToSlip);
  }

  listKept(limit = 50, scope?: string, includeLegacy = false, kinds?: MemoryKind[]): Slip[] {
    const rows = scope
      ? this.db
          .prepare(
            `SELECT * FROM slips
             WHERE state = 'kept' AND (scope = ? OR scope = 'global' OR (? AND scope = 'legacy:global'))
               AND (? = '[]' OR kind IN (SELECT value FROM json_each(?)))
             ORDER BY kept_at DESC LIMIT ?`,
          )
          .all(scope, includeLegacy ? 1 : 0, JSON.stringify(kinds ?? []), JSON.stringify(kinds ?? []), limit) as SlipRow[]
      : this.db
          .prepare(`SELECT * FROM slips WHERE state = 'kept' ORDER BY kept_at DESC LIMIT ?`)
          .all(limit) as SlipRow[];
    return rows.map(rowToSlip);
  }

  // ----- search -----

  /** FTS5 search over kept + draft slips (excludes expired). */
  searchFts(
    query: string,
    limit: number,
    scope?: string,
    includeLegacy = false,
    kinds?: MemoryKind[],
  ): Array<{ slip: Slip; score: number }> {
    // Tokenize on whitespace, strip non-word chars per token, drop empties.
    // Bare tokens let FTS5's porter tokenizer stem ("prefers" matches "preferred").
    // We OR them so any subset match still ranks; longest match wins via BM25.
    const sanitized = query
      .split(/\s+/)
      .map((t) => t.replace(/[^a-zA-Z0-9]/g, ""))
      .filter((t) => t.length > 0)
      .join(" OR ");
    if (!sanitized) return [];

    const rows = scope
      ? this.db
          .prepare(
            `SELECT s.*, bm25(slips_fts) AS score
             FROM slips_fts
             JOIN slips s ON s.rowid = slips_fts.rowid
             WHERE slips_fts MATCH ?
               AND s.state != 'expired'
               AND (s.scope = ? OR s.scope = 'global' OR (? AND s.scope = 'legacy:global'))
               AND (? = '[]' OR s.kind IN (SELECT value FROM json_each(?)))
             ORDER BY score ASC
             LIMIT ?`,
          )
          .all(sanitized, scope, includeLegacy ? 1 : 0, JSON.stringify(kinds ?? []), JSON.stringify(kinds ?? []), limit) as Array<SlipRow & { score: number }>
      : this.db
          .prepare(
            `SELECT s.*, bm25(slips_fts) AS score
             FROM slips_fts
             JOIN slips s ON s.rowid = slips_fts.rowid
             WHERE slips_fts MATCH ? AND s.state != 'expired'
             ORDER BY score ASC LIMIT ?`,
          )
          .all(sanitized, limit) as Array<SlipRow & { score: number }>;

    return rows.map((r) => ({
      slip: rowToSlip(r),
      score: r.score,
    }));
  }

  // ----- anchors -----

  /**
   * Store a code anchor. Insert-or-ignore, because anchors are immutable:
   * re-anchoring the same slip to the same path and symbol is a no-op, not
   * an update of the captured blob id.
   */
  insertAnchor(a: Anchor): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO anchors (slip_id, path, symbol, line, blob_sha, commit_sha, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.slipId, a.path, a.symbol ?? "", a.line, a.blobSha, a.commit, a.createdAt);
  }

  anchorsFor(slipId: string): Anchor[] {
    const rows = this.db
      .prepare(`SELECT * FROM anchors WHERE slip_id = ? ORDER BY path ASC, symbol ASC`)
      .all(slipId) as AnchorRow[];
    return rows.map(rowToAnchor);
  }

  /**
   * Anchors for a batch of slips, as one indexed query.
   *
   * Recall calls this once per packet, so it must not become a query per
   * hit. Slips with no anchors are simply absent from the map.
   */
  anchorsForSlips(slipIds: string[]): Map<string, Anchor[]> {
    const grouped = new Map<string, Anchor[]>();
    if (slipIds.length === 0) return grouped;
    const rows = this.db
      .prepare(
        `SELECT * FROM anchors
         WHERE slip_id IN (SELECT value FROM json_each(?))
         ORDER BY path ASC, symbol ASC`,
      )
      .all(JSON.stringify(slipIds)) as AnchorRow[];
    for (const row of rows) {
      const anchor = rowToAnchor(row);
      const bucket = grouped.get(anchor.slipId);
      if (bucket) bucket.push(anchor);
      else grouped.set(anchor.slipId, [anchor]);
    }
    return grouped;
  }

  /**
   * Reverse lookup: non-expired slips anchored to any of `paths`.
   *
   * Scope filtering matches recall exactly, including deliberate global
   * slips, so file-shaped retrieval cannot leak another repository's
   * memory into this one.
   */
  slipsAnchoredTo(
    paths: string[],
    scope: string,
    includeLegacy = false,
    limit = 20,
  ): Slip[] {
    if (paths.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT s.* FROM anchors a
         JOIN slips s ON s.id = a.slip_id
         WHERE a.path IN (SELECT value FROM json_each(?))
           AND s.state != 'expired'
           AND (s.scope = ? OR s.scope = 'global' OR (? AND s.scope = 'legacy:global'))
         ORDER BY s.created_at DESC
         LIMIT ?`,
      )
      .all(JSON.stringify(paths), scope, includeLegacy ? 1 : 0, limit) as SlipRow[];
    return rows.map(rowToSlip);
  }

  /** Every non-expired anchored slip in scope, newest first. */
  listAnchoredSlips(scope: string, includeLegacy = false, limit = 100): Slip[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT s.* FROM anchors a
         JOIN slips s ON s.id = a.slip_id
         WHERE s.state != 'expired'
           AND (s.scope = ? OR s.scope = 'global' OR (? AND s.scope = 'legacy:global'))
         ORDER BY s.created_at DESC
         LIMIT ?`,
      )
      .all(scope, includeLegacy ? 1 : 0, limit) as SlipRow[];
    return rows.map(rowToSlip);
  }

  // ----- links -----

  insertLink(l: Link): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO links (from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(l.fromId, l.toId, l.kind, l.createdAt);
  }

  linksFrom(id: string): Link[] {
    return this.linksByColumn("from_id", id);
  }

  linksTo(id: string): Link[] {
    return this.linksByColumn("to_id", id);
  }

  /** Return the newest non-expired memory that explicitly replaces `id`. */
  activeSuperseder(id: string, scope: string): Slip | null {
    const row = this.db.prepare(
      `SELECT s.* FROM links l
       JOIN slips s ON s.id = l.from_id
       WHERE l.to_id = ? AND l.kind = 'supersedes'
         AND s.scope = ? AND s.state != 'expired'
       ORDER BY s.created_at DESC LIMIT 1`,
    ).get(id, scope) as SlipRow | null;
    return row ? rowToSlip(row) : null;
  }

  /**
   * Shared body for `linksFrom` / `linksTo`. The two methods differ only in
   * which column they filter on; everything else (selection, row-to-Link
   * mapping) is identical.
   */
  private linksByColumn(column: "from_id" | "to_id", id: string): Link[] {
    const rows = this.db
      .prepare(`SELECT from_id, to_id, kind, created_at FROM links WHERE ${column} = ?`)
      .all(id) as Array<{
      from_id: string;
      to_id: string;
      kind: LinkKind;
      created_at: number;
    }>;
    return rows.map((r) => ({
      fromId: r.from_id,
      toId: r.to_id,
      kind: r.kind,
      createdAt: r.created_at,
    }));
  }

  // ----- handoffs -----

  insertHandoff(h: Handoff): void {
    this.db
      .prepare(
        `INSERT INTO handoffs (id, session_id, authored_by, scope, summary, kept, next, status, automatic, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        h.id,
        h.sessionId,
        h.authoredBy,
        h.scope,
        h.summary,
        JSON.stringify(h.kept),
        JSON.stringify(h.next),
        h.status ?? "active",
        h.automatic ? 1 : 0,
        h.createdAt,
        h.resolvedAt ?? null,
      );
  }

  getHandoffBySession(sessionId: string, scope?: string): Handoff | null {
    const r = scope
      ? this.db
          .prepare(`SELECT * FROM handoffs WHERE session_id = ? AND scope = ?`)
          .get(sessionId, scope) as HandoffRow | null
      : this.db
          .prepare(`SELECT * FROM handoffs WHERE session_id = ?`)
          .get(sessionId) as HandoffRow | null;
    return r ? rowToHandoff(r) : null;
  }

  getActiveHandoffBySession(sessionId: string, scope: string): Handoff | null {
    const row = this.db
      .prepare(`SELECT * FROM handoffs WHERE session_id = ? AND scope = ? AND status = 'active'`)
      .get(sessionId, scope) as HandoffRow | null;
    return row ? rowToHandoff(row) : null;
  }

  latestHandoffs(limit = 5, scope?: string, includeLegacy = false): Handoff[] {
    const rows = scope
      ? this.db
          .prepare(
            `SELECT * FROM handoffs
             WHERE status = 'active' AND (scope = ? OR (? AND scope = 'legacy:global'))
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(scope, includeLegacy ? 1 : 0, limit) as HandoffRow[]
      : this.db
          .prepare(`SELECT * FROM handoffs ORDER BY created_at DESC LIMIT ?`)
          .all(limit) as HandoffRow[];
    return rows.map(rowToHandoff);
  }

  replaceAutomaticHandoff(existingId: string, replacement: Handoff): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM handoffs WHERE id = ? AND automatic = 1`).run(existingId);
      this.insertHandoff(replacement);
    });
    transaction();
  }

  resolveHandoff(id: string, status: Exclude<HandoffStatus, "active">, at: number): boolean {
    const result = this.db
      .prepare(`UPDATE handoffs SET status = ?, resolved_at = ? WHERE id = ? AND status = 'active'`)
      .run(status, at, id);
    return result.changes > 0;
  }

  // ----- messages -----

  insertMessage(m: AgentMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages
         (id, thread_id, from_author, to_author, body, state, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.id, m.threadId, m.from, m.to, m.body, m.state, m.createdAt, m.readAt);
  }

  inbox(to: string, limit = 20, includeRead = false): AgentMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE to_author = ? AND (? OR state = 'pending')
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(to, includeRead ? 1 : 0, limit) as MessageRow[];
    return rows.map(rowToMessage);
  }

  thread(threadId: string): AgentMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC`)
      .all(threadId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  markMessage(id: string, state: MessageState, now: number): boolean {
    const readAt = state === "read" ? now : null;
    const res = this.db
      .prepare(`UPDATE messages SET state = ?, read_at = COALESCE(read_at, ?) WHERE id = ?`)
      .run(state, readAt, id);
    return res.changes > 0;
  }

  // ----- recall evidence -----

  recordRecall(trace: RecallTrace): void {
    this.db
      .prepare(
        `INSERT INTO recall_traces
         (id, session_id, authored_by, scope, query, hit_ids, handoff_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trace.id,
        trace.sessionId,
        trace.authoredBy,
        trace.scope,
        trace.query,
        JSON.stringify(trace.hitIds),
        trace.handoffId,
        trace.createdAt,
      );
  }

  recentRecallTraces(limit = 100, scope?: string): RecallTrace[] {
    const rows = scope
      ? this.db
          .prepare(`SELECT * FROM recall_traces WHERE scope = ? ORDER BY created_at DESC LIMIT ?`)
          .all(scope, limit)
      : this.db
          .prepare(`SELECT * FROM recall_traces ORDER BY created_at DESC LIMIT ?`)
          .all(limit);
    return (rows as Array<{
      id: string;
      session_id: string;
      authored_by: string;
      scope: string;
      query: string;
      hit_ids: string;
      handoff_id: string | null;
      created_at: number;
      assessment: RecallAssessment | null;
      assessed_at: number | null;
      note: string | null;
    }>).map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      authoredBy: row.authored_by,
      scope: row.scope,
      query: row.query,
      hitIds: JSON.parse(row.hit_ids) as string[],
      handoffId: row.handoff_id,
      createdAt: row.created_at,
      assessment: row.assessment,
      assessedAt: row.assessed_at,
      note: row.note,
    }));
  }

  assessRecall(id: string, assessment: RecallAssessment, note: string | null, at: number): boolean {
    const result = this.db
      .prepare(`UPDATE recall_traces SET assessment = ?, assessed_at = ?, note = ? WHERE id = ?`)
      .run(assessment, at, note, id);
    return result.changes > 0;
  }

  recallReport(scope?: string): {
    total: number;
    assessed: number;
    useful: number;
    wrong: number;
    missed: number;
    noMemoryNeeded: number;
  } {
    const where = scope ? `WHERE scope = ?` : "";
    const row = this.db.prepare(
      `SELECT COUNT(*) total,
        COUNT(assessment) assessed,
        SUM(CASE WHEN assessment = 'useful' THEN 1 ELSE 0 END) useful,
        SUM(CASE WHEN assessment = 'wrong' THEN 1 ELSE 0 END) wrong,
        SUM(CASE WHEN assessment = 'missed' THEN 1 ELSE 0 END) missed,
        SUM(CASE WHEN assessment = 'no_memory_needed' THEN 1 ELSE 0 END) no_memory_needed
       FROM recall_traces ${where}`,
    ).get(...(scope ? [scope] : [])) as Record<string, number | null>;
    return {
      total: row.total ?? 0,
      assessed: row.assessed ?? 0,
      useful: row.useful ?? 0,
      wrong: row.wrong ?? 0,
      missed: row.missed ?? 0,
      noMemoryNeeded: row.no_memory_needed ?? 0,
    };
  }

  // ----- diagnostics -----

  health(): { ok: boolean; sqlite: string; slips: number; indexed: number } {
    const sqlite = (this.db.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string }).integrity_check;
    const slips = (this.db.prepare(`SELECT COUNT(*) n FROM slips`).get() as { n: number }).n;
    const indexed = (this.db.prepare(`SELECT COUNT(*) n FROM slips_fts`).get() as { n: number }).n;
    return { ok: sqlite === "ok" && slips === indexed, sqlite, slips, indexed };
  }

  counts(): { slips: number; kept: number; drafts: number; handoffs: number; messages: number; pending: number } {
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM slips`).get() as { n: number }
    ).n;
    const kept = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM slips WHERE state = 'kept'`)
        .get() as { n: number }
    ).n;
    const drafts = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM slips WHERE state = 'draft'`)
        .get() as { n: number }
    ).n;
    const handoffs = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM handoffs`).get() as { n: number }
    ).n;
    const messages = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }
    ).n;
    const pending = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE state = 'pending'`)
        .get() as { n: number }
    ).n;
    return { slips: total, kept, drafts, handoffs, messages, pending };
  }
}

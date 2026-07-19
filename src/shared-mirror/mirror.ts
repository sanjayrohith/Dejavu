/**
 * Local mirror of a shared-memory authority.
 *
 * Implements the mirror seam from
 * docs/shared-memory-implementation-contract.md:
 *
 *   - apply(event) / applyReceipt(receipt)
 *   - dedupe by revision and eventId
 *   - contiguous mirrorRevision watermark (own ack ahead of peer gap is OK to
 *     materialize for read-after-write, but watermark stays at the highest
 *     contiguous prefix)
 *   - catchUp(fetchEvents) — pulls from the authority via injected fetcher
 *   - freshness(headRevision)
 *   - recallLocal({ query, tags, limit })
 *
 * Storage uses Bun's bun:sqlite + FTS5, matching the existing repo style
 * (see src/storage.ts). Tests pass `:memory:` for isolation.
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  ApplyResult,
  CatchUpResult,
  FetchEventsFn,
  FreshnessReport,
  LocalRecallHit,
  LocalRecallQuery,
  LocalRecallResult,
  SharedLocalHandoff,
  SharedDeletePayload,
  SharedHandoffPayload,
  SharedMemoryEvent,
  SharedPurgedRememberPayload,
  SharedRememberPayload,
  SharedSignalPayload,
  SharedWriteReceipt,
} from "./types.ts";

export interface MirrorOptions {
  /** Override DB path. Default: ~/.dejavu/shared-mirror.db. Use ":memory:" for tests. */
  path?: string;
  /** Authority id this mirror is bound to. Stored for diagnostics. */
  authority?: string;
}

function defaultMirrorPath(): string {
  return (
    process.env.DEJAVU_SHARED_MIRROR_DB ??
    join(homedir(), ".dejavu", "shared-mirror.db")
  );
}

const SCHEMA = `
-- One row per known shared-memory event. revision is the per-authority
-- monotonic integer key. eventId is also unique so duplicate deliveries
-- on different paths (live SSE + catchUp) dedupe cleanly.
CREATE TABLE IF NOT EXISTS mirror_events (
  revision      INTEGER PRIMARY KEY,
  event_id      TEXT NOT NULL UNIQUE,
  type          TEXT NOT NULL,
  authority     TEXT NOT NULL,
  committed_at  TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  received_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mirror_events_type ON mirror_events(type);

-- Single-row table holding the contiguous watermark.
-- mirror_revision = R means every event in [1..R] has been recorded
-- in mirror_events. It MUST NOT advance past a gap.
CREATE TABLE IF NOT EXISTS mirror_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  mirror_revision  INTEGER NOT NULL DEFAULT 0,
  authority        TEXT
);

INSERT OR IGNORE INTO mirror_state (id, mirror_revision, authority)
VALUES (1, 0, NULL);

-- Materialized kept slips. Populated on event apply (NOT on watermark
-- advance), so a writer's own acked event is recallable immediately
-- even when peer gap repair is still outstanding.
CREATE TABLE IF NOT EXISTS mirror_slips (
  slip_id       TEXT PRIMARY KEY,
  revision      INTEGER NOT NULL UNIQUE,
  authority     TEXT NOT NULL,
  authored_by   TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  text          TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',   -- JSON array
  state         TEXT NOT NULL,                -- shared v1 starts 'kept'; signals may expire it
  used_count    INTEGER NOT NULL DEFAULT 0,
  wrong_count   INTEGER NOT NULL DEFAULT 0,
  committed_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mirror_slips_committed
  ON mirror_slips(committed_at);

CREATE TABLE IF NOT EXISTS mirror_handoffs (
  handoff_id    TEXT PRIMARY KEY,
  revision      INTEGER NOT NULL UNIQUE,
  authored_by   TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  summary       TEXT NOT NULL,
  kept          TEXT NOT NULL DEFAULT '[]',
  next          TEXT NOT NULL DEFAULT '[]',
  committed_at  TEXT NOT NULL
);

-- Local exact FTS over memory text/tags, matching the pattern used by
-- src/storage.ts for local slips.
CREATE VIRTUAL TABLE IF NOT EXISTS mirror_slips_fts USING fts5(
  text,
  tags,
  content='mirror_slips',
  content_rowid='rowid',
  tokenize="porter unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS mirror_slips_ai AFTER INSERT ON mirror_slips BEGIN
  INSERT INTO mirror_slips_fts(rowid, text, tags)
    VALUES (new.rowid, new.text, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS mirror_slips_ad AFTER DELETE ON mirror_slips BEGIN
  INSERT INTO mirror_slips_fts(mirror_slips_fts, rowid, text, tags)
    VALUES ('delete', old.rowid, old.text, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS mirror_slips_au AFTER UPDATE OF text, tags ON mirror_slips BEGIN
  INSERT INTO mirror_slips_fts(mirror_slips_fts, rowid, text, tags)
    VALUES ('delete', old.rowid, old.text, old.tags);
  INSERT INTO mirror_slips_fts(rowid, text, tags)
    VALUES (new.rowid, new.text, new.tags);
END;
`;

interface MirrorStateRow {
  mirror_revision: number;
  authority: string | null;
}

interface MirrorHandoffRow {
  handoff_id: string;
  revision: number;
  authored_by: string;
  session_id: string;
  summary: string;
  kept: string;
  next: string;
  committed_at: string;
}

interface MirrorSlipRow {
  slip_id: string;
  revision: number;
  authority: string;
  authored_by: string;
  session_id: string;
  text: string;
  tags: string;
  state: string;
  used_count: number;
  wrong_count: number;
  committed_at: string;
}

export class LocalMirror {
  readonly db: Database;
  readonly path: string;
  private readonly boundAuthority: string | null;

  constructor(opts: MirrorOptions = {}) {
    this.path = opts.path ?? defaultMirrorPath();
    if (this.path !== ":memory:") {
      mkdirSync(dirname(this.path), { recursive: true });
    }
    this.db = new Database(this.path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);

    if (opts.authority) {
      this.db
        .prepare(`UPDATE mirror_state SET authority = COALESCE(authority, ?) WHERE id = 1`)
        .run(opts.authority);
    }
    const row = this.readState();
    this.boundAuthority = row.authority ?? opts.authority ?? null;
  }

  close(): void {
    this.db.close();
  }

  // ---- public API: apply / receipt ----

  /**
   * Record a shared-memory event. Idempotent: duplicate (revision, eventId)
   * deliveries dedupe to `applied:false`. Advances the contiguous watermark
   * as far as possible from `mirror_revision + 1`.
   */
  apply(event: SharedMemoryEvent): ApplyResult {
    return this.applyEventInternal(event);
  }

  /**
   * Convenience for the writer read-after-write path: a SharedWriteReceipt
   * carries the canonical event that the writer's authority already
   * committed. Apply it locally so recall sees it immediately.
   */
  applyReceipt(receipt: SharedWriteReceipt): ApplyResult {
    return this.applyEventInternal(receipt.event);
  }

  // ---- public API: catch-up ----

  /**
   * Pull events from the authority via the injected fetcher until the
   * mirror reaches `headRevision`, or until a fetch returns no progress.
   * Returns the total number of newly applied events and the final
   * watermark/head.
   */
  async catchUp(
    fetchEvents: FetchEventsFn,
    opts: { batchSize?: number; maxBatches?: number } = {},
  ): Promise<CatchUpResult> {
    const batchSize = opts.batchSize ?? 200;
    const maxBatches = opts.maxBatches ?? 100;

    let appliedTotal = 0;
    let headRevision = 0;

    for (let i = 0; i < maxBatches; i++) {
      // Fetch using mirror_revision (the contiguous watermark), NOT the
      // highest known event. That way any gap still gets repaired even if
      // we already buffered events past the gap from a live feed.
      const since = this.readState().mirror_revision;
      const resp = await fetchEvents(since, batchSize);
      headRevision = resp.headRevision;

      if (resp.events.length === 0) break;

      let appliedThisBatch = 0;
      for (const ev of resp.events) {
        const res = this.applyEventInternal(ev);
        if (res.applied) appliedThisBatch++;
      }
      appliedTotal += appliedThisBatch;

      const after = this.readState().mirror_revision;
      // Stop if we've reached head, or if the batch made no forward progress.
      if (after >= headRevision) break;
      if (appliedThisBatch === 0) break;
    }

    return {
      applied: appliedTotal,
      mirrorRevision: this.readState().mirror_revision,
      headRevision,
    };
  }

  // ---- public API: freshness ----

  freshness(headRevision: number): FreshnessReport {
    const mirrorRevision = this.readState().mirror_revision;
    const behind = Math.max(0, headRevision - mirrorRevision);
    return {
      mirrorRevision,
      headRevision,
      behind,
      fresh: behind === 0,
    };
  }

  // ---- public API: local recall ----

  recallLocal(q: LocalRecallQuery = {}): LocalRecallResult {
    const limit = Math.max(1, q.limit ?? 8);
    const text = (q.query ?? "").trim();
    const tagFilter = (q.tags ?? []).filter((t) => t.length > 0);

    let hits: LocalRecallHit[];
    if (text.length > 0) {
      hits = this.ftsSearch(text, limit * 4); // overfetch, then tag-filter
    } else {
      hits = this.recentHits(limit * 4);
    }

    if (tagFilter.length > 0) {
      hits = hits.filter((h) =>
        tagFilter.every((t) => h.tags.includes(t)),
      );
    }

    hits = hits.slice(0, limit);

    return {
      hits,
      mirrorRevision: this.readState().mirror_revision,
      latestHandoff: this.latestHandoff(),
    };
  }

  // ---- diagnostics ----

  getMirrorRevision(): number {
    return this.readState().mirror_revision;
  }

  /** Highest known event revision, even across a gap. Useful for tests/debug. */
  getHighestKnownRevision(): number {
    const r = this.db
      .prepare(`SELECT MAX(revision) AS r FROM mirror_events`)
      .get() as { r: number | null };
    return r.r ?? 0;
  }

  authority(): string | null {
    return this.boundAuthority;
  }

  latestHandoff(): SharedLocalHandoff | null {
    const row = this.db.prepare(`SELECT * FROM mirror_handoffs ORDER BY revision DESC LIMIT 1`).get() as MirrorHandoffRow | null;
    if (!row) return null;
    return { handoffId: row.handoff_id, summary: row.summary, next: JSON.parse(row.next) as string[], kept: JSON.parse(row.kept) as string[], authoredBy: row.authored_by, sessionId: row.session_id, revision: row.revision, committedAt: row.committed_at };
  }

  // ---- internals ----

  private applyEventInternal(event: SharedMemoryEvent): ApplyResult {
    if (
      typeof event.revision !== "number" ||
      !Number.isInteger(event.revision) ||
      event.revision < 1
    ) {
      // Defensive: contract says revisions are positive integers. Reject.
      return { applied: false, mirrorRevision: this.readState().mirror_revision };
    }

    // Single transaction: insert event, optionally materialize slip,
    // then advance watermark across whatever contiguous prefix is now
    // available. SQLite gives us atomicity for the whole apply.
    const txn = this.db.transaction(() => {
      const insertEvent = this.db.prepare(
        `INSERT OR IGNORE INTO mirror_events
         (revision, event_id, type, authority, committed_at, payload_json, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const res = insertEvent.run(
        event.revision,
        event.eventId,
        event.type,
        event.authority,
        event.committedAt,
        JSON.stringify(event.payload),
        Date.now(),
      );

      const inserted = res.changes > 0;

      if (inserted && event.type === "remember") {
        const payload = event.payload as SharedRememberPayload | SharedPurgedRememberPayload;
        if ("purged" in payload && payload.purged === true) {
          // Deleted history retains revision order without any content to copy.
        } else {
          this.materializeRemember(event, payload as SharedRememberPayload);
        }
      }
      if (inserted && event.type === "handoff") {
        this.materializeHandoff(event, event.payload as SharedHandoffPayload);
      }
      if (inserted && event.type === "signal") {
        this.applySignal(event.payload as SharedSignalPayload);
      }
      if (inserted && event.type === "delete") {
        this.applyDelete(event.payload as SharedDeletePayload);
      }

      if (inserted) {
        this.advanceWatermark();
      }

      return inserted;
    });

    const applied = txn();
    return {
      applied,
      mirrorRevision: this.readState().mirror_revision,
    };
  }

  private materializeRemember(
    event: SharedMemoryEvent,
    payload: SharedRememberPayload,
  ): void {
    // Shared v1 only publishes kept slips. Be defensive but match contract:
    // we accept any state field but record what was sent.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO mirror_slips
         (slip_id, revision, authority, authored_by, session_id, text, tags, state, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        payload.slipId,
        event.revision,
        event.authority,
        payload.authoredBy,
        payload.sessionId,
        payload.text,
        JSON.stringify(payload.tags ?? []),
        payload.state ?? "kept",
        event.committedAt,
      );
  }

  private materializeHandoff(event: SharedMemoryEvent, payload: SharedHandoffPayload): void {
    this.db.prepare(`INSERT OR IGNORE INTO mirror_handoffs (handoff_id, revision, authored_by, session_id, summary, kept, next, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(payload.handoffId, event.revision, payload.authoredBy, payload.sessionId, payload.summary, JSON.stringify(payload.kept ?? []), JSON.stringify(payload.next ?? []), event.committedAt);
  }

  private applySignal(payload: SharedSignalPayload): void {
    switch (payload.action) {
      case "used":
        this.db.prepare(`UPDATE mirror_slips SET used_count = used_count + 1 WHERE slip_id = ?`).run(payload.slipId);
        return;
      case "wrong":
        this.db.prepare(`UPDATE mirror_slips SET wrong_count = wrong_count + 1 WHERE slip_id = ?`).run(payload.slipId);
        return;
      case "forget":
        this.db.prepare(`UPDATE mirror_slips SET state = 'expired' WHERE slip_id = ?`).run(payload.slipId);
        return;
    }
  }

  private applyDelete(payload: SharedDeletePayload): void {
    // The delete event remains in mirror_events as the sync receipt/tombstone,
    // while the memory content and FTS row are removed from the searchable copy.
    this.db.prepare(`DELETE FROM mirror_slips WHERE slip_id = ?`).run(payload.slipId);
  }

  /**
   * Walk forward from current watermark while the next revision is present
   * in mirror_events. The watermark only advances across a contiguous run;
   * a gap halts it immediately.
   */
  private advanceWatermark(): void {
    let current = this.readState().mirror_revision;
    const hasNext = this.db.prepare(
      `SELECT 1 FROM mirror_events WHERE revision = ?`,
    );
    // Avoid an unbounded loop in adversarial input; cap by highest known.
    const highest = this.getHighestKnownRevision();
    while (current < highest) {
      const next = current + 1;
      const row = hasNext.get(next);
      if (!row) break;
      current = next;
    }
    this.db
      .prepare(`UPDATE mirror_state SET mirror_revision = ? WHERE id = 1`)
      .run(current);
  }

  private readState(): MirrorStateRow {
    const row = this.db
      .prepare(`SELECT mirror_revision, authority FROM mirror_state WHERE id = 1`)
      .get() as MirrorStateRow | null;
    // SCHEMA seeds row 1, so row should never be null. Be defensive anyway.
    return row ?? { mirror_revision: 0, authority: null };
  }

  private rowToHit(r: MirrorSlipRow & { score?: number | null }): LocalRecallHit {
    return {
      slipId: r.slip_id,
      text: r.text,
      tags: JSON.parse(r.tags) as string[],
      authoredBy: r.authored_by,
      sessionId: r.session_id,
      revision: r.revision,
      committedAt: r.committed_at,
      state: r.state,
      usedCount: r.used_count,
      wrongCount: r.wrong_count,
      score: r.score ?? null,
    };
  }

  private ftsSearch(query: string, limit: number): LocalRecallHit[] {
    // Sanitization mirrors src/storage.ts#searchFts: tokenize on whitespace,
    // strip non-word chars per token, OR them together so any subset matches
    // and the porter tokenizer can stem.
    const sanitized = query
      .split(/\s+/)
      .map((t) => t.replace(/[^a-zA-Z0-9]/g, ""))
      .filter((t) => t.length > 0)
      .join(" OR ");
    if (!sanitized) return [];

    const rows = this.db
      .prepare(
        `SELECT s.*, bm25(mirror_slips_fts) AS score
         FROM mirror_slips_fts
         JOIN mirror_slips s ON s.rowid = mirror_slips_fts.rowid
         WHERE mirror_slips_fts MATCH ? AND s.state != 'expired'
         ORDER BY score ASC
         LIMIT ?`,
      )
      .all(sanitized, limit) as Array<MirrorSlipRow & { score: number }>;

    return rows.map((r) => this.rowToHit(r));
  }

  private recentHits(limit: number): LocalRecallHit[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mirror_slips
         WHERE state != 'expired'
         ORDER BY committed_at DESC, revision DESC
         LIMIT ?`,
      )
      .all(limit) as MirrorSlipRow[];
    return rows.map((r) => this.rowToHit({ ...r, score: null }));
  }
}

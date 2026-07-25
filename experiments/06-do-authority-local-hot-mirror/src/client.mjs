// Experiment 06 — Client with laptop-local hot SQLite mirror.
//
// Each client owns its own SQLite database file (or :memory:). The database
// holds:
//
//   memory(id, ulid, revision, client, text, ts)     -- mirrored events
//   memory_fts(text)                                 -- FTS5 index (or LIKE)
//   meta(key, value)                                 -- key=mirror_revision
//
// The contract this client offers to its caller:
//
//   remember(text)         -- POST authority /remember, on 200 apply the
//                             acked event to the local mirror *before*
//                             returning the receipt. Receipt is therefore
//                             always read-after-writable locally as well.
//
//   recallLocal(q, limit)  -- query the local mirror only. Returns
//                             { hits, mirror_revision, stale_warning? }.
//                             Does NOT contact the authority. "Warm local
//                             recall."
//
//   recallAuth(q, limit)   -- query the authority directly. Returns
//                             { hits, head_revision }.
//
//   catchUp(opts?)         -- pull /events?since=mirror_revision until
//                             mirror_revision == head_revision (or we hit
//                             a configurable max-page count). Returns
//                             { applied, mirror_revision, head_revision }.
//
//   freshness()            -- GET /head and compare to mirror_revision.
//                             Returns { mirror_revision, head_revision,
//                             behind, fresh }.
//
// "stale_warning" is the candor knob this experiment cares about. A pure
// local recall has no way to *know* it is stale without asking the authority.
// We expose `recallLocal` honestly: it returns whatever the mirror has,
// plus the mirror's revision. The caller (or harness) decides whether to
// trust it. We deliberately do NOT have recallLocal silently call /head;
// that would defeat the point of a "warm local" path.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createClient({ name, authorityBase, dbPath }) {
  if (!name) throw new Error("client: name required");
  if (!authorityBase) throw new Error("client: authorityBase required");
  if (!dbPath) throw new Error("client: dbPath required");

  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id        INTEGER PRIMARY KEY,
      ulid      TEXT NOT NULL UNIQUE,
      revision  INTEGER NOT NULL UNIQUE,
      client    TEXT NOT NULL,
      text      TEXT NOT NULL,
      ts        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_revision_idx ON memory(revision);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO meta(key, value) VALUES ('mirror_revision', '0');
  `);

  let ftsMode = "fts5";
  let ftsError = null;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
        USING fts5(text, content='memory', content_rowid='id');
    `);
    // Rebuild in case rows were inserted before fts table existed.
    db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild');");
  } catch (err) {
    ftsMode = "like";
    ftsError = err.message;
  }

  const upsertMemoryStmt = db.prepare(
    `INSERT INTO memory(id, ulid, revision, client, text, ts)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  const insertFtsStmt =
    ftsMode === "fts5"
      ? db.prepare(`INSERT INTO memory_fts(rowid, text) VALUES (?, ?)`)
      : null;
  const getRevisionStmt = db.prepare(
    `SELECT value FROM meta WHERE key='mirror_revision'`,
  );
  const setRevisionStmt = db.prepare(
    `UPDATE meta SET value=? WHERE key='mirror_revision'`,
  );
  const ftsRecallStmt =
    ftsMode === "fts5"
      ? db.prepare(`
          SELECT m.id, m.ulid, m.revision, m.client, m.text, m.ts
            FROM memory_fts f JOIN memory m ON m.id = f.rowid
           WHERE f.text MATCH ?
           ORDER BY m.id DESC LIMIT ?
        `)
      : null;
  const likeRecallStmt = db.prepare(
    `SELECT id, ulid, revision, client, text, ts FROM memory
       WHERE text LIKE ? ORDER BY id DESC LIMIT ?`,
  );
  const existsByRevisionStmt = db.prepare(
    `SELECT 1 AS x FROM memory WHERE revision=? LIMIT 1`,
  );

  function getMirrorRevision() {
    return Number.parseInt(getRevisionStmt.get().value, 10);
  }
  function bumpMirrorRevision(to) {
    setRevisionStmt.run(String(to));
  }
  function applyEvent(ev) {
    // Idempotent. Acked events from /remember and pulled events from /events
    // both come through here.
    if (existsByRevisionStmt.get(ev.revision)) return false;
    upsertMemoryStmt.run(ev.id, ev.ulid, ev.revision, ev.client, ev.text, ev.ts);
    if (insertFtsStmt) insertFtsStmt.run(ev.id, ev.text);
    advanceMirrorRevision();
    return true;
  }

  // mirror_revision is the *contiguous* applied watermark — the largest R such
  // that we have applied every event in [1..R]. Critically, applying our own
  // /remember ack (whose revision may be far ahead of the watermark, because
  // other clients may have committed in between our last catchUp and this
  // write) inserts the row but does NOT advance the watermark past gaps.
  // catchUp() pulls /events?since=mirror_revision and so will still get the
  // missed-in-between events from other clients. existsByRevisionStmt dedupes
  // the row we already inserted ahead of time.
  function advanceMirrorRevision() {
    let cur = getMirrorRevision();
    // Walk forward as long as the next revision is already in the mirror.
    // For our common case (just inserted ev.revision == cur+1), this is one
    // step. After a catchUp, this walks the whole pulled batch in O(n).
    while (existsByRevisionStmt.get(cur + 1)) cur++;
    bumpMirrorRevision(cur);
  }

  async function http(method, path, body) {
    const url = authorityBase.replace(/\/+$/, "") + path;
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const r = await fetch(url, init);
    const text = await r.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!r.ok) {
      const e = new Error(
        `authority ${method} ${path} -> ${r.status}: ${text.slice(0, 200)}`,
      );
      e.status = r.status;
      e.body = parsed;
      throw e;
    }
    return parsed;
  }

  async function remember(text) {
    const ackTimer = process.hrtime.bigint();
    const ack = await http("POST", "/remember", { client: name, text });
    const ackEnd = process.hrtime.bigint();
    const applyTimer = process.hrtime.bigint();
    applyEvent({
      id: ack.id,
      ulid: ack.ulid,
      revision: ack.revision,
      client: name,
      text,
      ts: ack.ts,
    });
    const applyEnd = process.hrtime.bigint();
    return {
      ...ack,
      timings_ms: {
        authority_remember: Number(ackEnd - ackTimer) / 1e6,
        local_apply: Number(applyEnd - applyTimer) / 1e6,
        total: Number(applyEnd - ackTimer) / 1e6,
      },
    };
  }

  function recallLocal(q, limit = 25) {
    const t0 = process.hrtime.bigint();
    let hits;
    if (ftsRecallStmt) {
      try {
        hits = ftsRecallStmt.all(q, limit);
      } catch {
        hits = likeRecallStmt.all("%" + q + "%", limit);
      }
    } else {
      hits = likeRecallStmt.all("%" + q + "%", limit);
    }
    const t1 = process.hrtime.bigint();
    return {
      hits,
      mirror_revision: getMirrorRevision(),
      timing_ms: Number(t1 - t0) / 1e6,
      // Caller may interpret this however they like; we expose the mirror
      // revision so they can compare to a known head if they have one.
    };
  }

  async function recallAuth(q, limit = 25) {
    const t0 = process.hrtime.bigint();
    const out = await http(
      "GET",
      `/recall?q=${encodeURIComponent(q)}&limit=${limit}`,
    );
    const t1 = process.hrtime.bigint();
    return { ...out, timing_ms: Number(t1 - t0) / 1e6 };
  }

  async function catchUp({ pageSize = 1000, maxPages = 100 } = {}) {
    let applied = 0;
    let pages = 0;
    const t0 = process.hrtime.bigint();
    while (pages < maxPages) {
      const since = getMirrorRevision();
      const page = await http(
        "GET",
        `/events?since=${since}&limit=${pageSize}`,
      );
      if (!page.events.length) {
        const t1 = process.hrtime.bigint();
        return {
          applied,
          pages,
          mirror_revision: getMirrorRevision(),
          head_revision: page.head_revision,
          timing_ms: Number(t1 - t0) / 1e6,
        };
      }
      for (const ev of page.events) {
        if (applyEvent(ev)) applied++;
      }
      pages++;
      if (page.events.length < pageSize) {
        const t1 = process.hrtime.bigint();
        return {
          applied,
          pages,
          mirror_revision: getMirrorRevision(),
          head_revision: page.head_revision,
          timing_ms: Number(t1 - t0) / 1e6,
        };
      }
    }
    const t1 = process.hrtime.bigint();
    return {
      applied,
      pages,
      mirror_revision: getMirrorRevision(),
      head_revision: undefined, // unknown without another /head call
      timing_ms: Number(t1 - t0) / 1e6,
      truncated: true,
    };
  }

  async function freshness() {
    const t0 = process.hrtime.bigint();
    const h = await http("GET", "/head");
    const t1 = process.hrtime.bigint();
    const mirror_revision = getMirrorRevision();
    return {
      mirror_revision,
      head_revision: h.head_revision,
      behind: h.head_revision - mirror_revision,
      fresh: h.head_revision === mirror_revision,
      head_probe_ms: Number(t1 - t0) / 1e6,
    };
  }

  function close() {
    db.close();
  }

  return {
    name,
    fts: ftsMode,
    ftsError,
    remember,
    recallLocal,
    recallAuth,
    catchUp,
    freshness,
    mirrorRevision: getMirrorRevision,
    close,
  };
}

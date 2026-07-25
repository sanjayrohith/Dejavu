// Experiment 06 — Authority server.
//
// This is a stand-in for the experiment 05 DO. It is intentionally simple:
// a single Node process that owns a monotonic revision-numbered event log
// plus a materialized memory table, both kept in a SQLite database. It is
// the *only* place where a write is considered committed; everything else
// in this experiment is a cache.
//
// Why Node + SQLite instead of `wrangler dev`?
//   - This experiment is about *the interaction* between an authority and a
//     local hot mirror on the same laptop. We're not re-measuring DO numbers
//     (that's experiment 05). A Node HTTP server is the smallest possible
//     stand-in for "authority you talk to over the network", lets us run
//     the whole thing offline, and keeps run.sh trivially deterministic.
//   - A real deployment would replace this with the DO from experiment 05.
//     The wire contract below is the contract that DO would have to honor.
//
// Wire contract (used by client.mjs and harness.mjs):
//
//   POST /remember   { client, text }
//        -> 200 { id, ulid, revision, head_revision }
//        The authority assigns a strictly-increasing `revision` to this
//        write and returns the head revision (== revision for this op,
//        but we still return both so the client can't accidentally treat
//        a future head as belonging to this receipt).
//
//   GET  /recall?q=<text>&limit=<n>
//        -> 200 { hits: [...], head_revision }
//        Authoritative recall — always reflects everything committed up to
//        head_revision at the moment the query ran.
//
//   GET  /events?since=<rev>&limit=<n>
//        -> 200 { events: [{ revision, id, ulid, client, text, ts }], head_revision }
//        Catch-up endpoint for the mirror. Returns events with
//        `revision > since`, ordered by revision ascending, capped at
//        `limit` (default 1000). `head_revision` is the *authority*'s
//        current head so the caller knows how far behind it still is.
//
//   GET  /head
//        -> 200 { head_revision }
//        Cheap freshness probe.
//
//   POST /reset
//        -> 200 { ok: true, cleared: <n> }
//        Test-only. Clears everything and resets revision to 0.
//
//   GET  /health
//        -> 200 { ok: true, head_revision }

import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const PORT = Number.parseInt(process.env.AUTHORITY_PORT ?? "8876", 10);
const DB_PATH = process.env.AUTHORITY_DB ?? ":memory:";

if (DB_PATH !== ":memory:") {
  mkdirSync(dirname(DB_PATH), { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
// WAL for sane concurrent reads (not strictly needed; we serialize via Node's
// single-threaded event loop, but it's the right default for a file-backed db).
if (DB_PATH !== ":memory:") {
  db.exec("PRAGMA journal_mode = WAL;");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS memory (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ulid      TEXT    NOT NULL UNIQUE,
    revision  INTEGER NOT NULL UNIQUE,
    client    TEXT    NOT NULL,
    text      TEXT    NOT NULL,
    ts        TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_revision_idx ON memory(revision);
`);

// FTS5 for content match. If FTS5 isn't available we fall back to LIKE.
let ftsMode = "fts5";
let ftsError = null;
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
      USING fts5(text, content='memory', content_rowid='id');
  `);
  // Backfill in case rows existed before fts table was created.
  db.exec(`INSERT INTO memory_fts(memory_fts) VALUES('rebuild');`);
} catch (err) {
  ftsMode = "like";
  ftsError = err.message;
}

const insertStmt = db.prepare(
  `INSERT INTO memory(ulid, revision, client, text, ts) VALUES (?, ?, ?, ?, ?)`,
);
const insertFtsStmt =
  ftsMode === "fts5"
    ? db.prepare(`INSERT INTO memory_fts(rowid, text) VALUES (?, ?)`)
    : null;
const headStmt = db.prepare(
  `SELECT COALESCE(MAX(revision), 0) AS head FROM memory`,
);
const eventsSinceStmt = db.prepare(
  `SELECT id, ulid, revision, client, text, ts FROM memory
     WHERE revision > ? ORDER BY revision ASC LIMIT ?`,
);
const ftsRecallStmt =
  ftsMode === "fts5"
    ? db.prepare(`
        SELECT m.id, m.ulid, m.revision, m.client, m.text, m.ts
          FROM memory_fts f
          JOIN memory m ON m.id = f.rowid
         WHERE f.text MATCH ?
         ORDER BY m.id DESC
         LIMIT ?
      `)
    : null;
const likeRecallStmt = db.prepare(
  `SELECT id, ulid, revision, client, text, ts FROM memory
     WHERE text LIKE ? ORDER BY id DESC LIMIT ?`,
);

function newUlid() {
  // Same shape as experiment 05's ulid — not time-sortable, just a UUID-ish
  // tag. Good enough for this experiment.
  return "mem_" + randomBytes(16).toString("hex");
}

function headRevision() {
  return headStmt.get().head;
}

function remember(client, text) {
  const ulid = newUlid();
  const ts = new Date().toISOString();
  // We compute revision as MAX(revision)+1 inside a transaction so two
  // concurrent /remember calls can't collide.
  let assigned;
  db.exec("BEGIN IMMEDIATE");
  try {
    const head = headRevision();
    assigned = head + 1;
    const info = insertStmt.run(ulid, assigned, client, text, ts);
    if (insertFtsStmt) insertFtsStmt.run(info.lastInsertRowid, text);
    db.exec("COMMIT");
    return {
      id: Number(info.lastInsertRowid),
      ulid,
      revision: assigned,
      head_revision: assigned,
      ts,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function recall(q, limit) {
  if (ftsRecallStmt) {
    try {
      const rows = ftsRecallStmt.all(q, limit);
      return { hits: rows, head_revision: headRevision() };
    } catch {
      // FTS query parse error -> fall back to LIKE for that query.
    }
  }
  const rows = likeRecallStmt.all("%" + q + "%", limit);
  return { hits: rows, head_revision: headRevision() };
}

function eventsSince(since, limit) {
  const rows = eventsSinceStmt.all(since, limit);
  return { events: rows, head_revision: headRevision() };
}

function reset() {
  db.exec("BEGIN IMMEDIATE");
  const before = headRevision();
  db.exec("DELETE FROM memory;");
  if (ftsMode === "fts5") {
    db.exec("DELETE FROM memory_fts;");
  }
  // Reset AUTOINCREMENT so ids restart at 1 -- nice for deterministic harness output.
  try {
    db.exec("DELETE FROM sqlite_sequence WHERE name='memory';");
  } catch {}
  db.exec("COMMIT");
  return { ok: true, cleared: before };
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, {
        ok: true,
        head_revision: headRevision(),
        fts: ftsMode,
        ftsError,
      });
    }
    if (req.method === "GET" && url.pathname === "/head") {
      return send(res, 200, { head_revision: headRevision() });
    }
    if (req.method === "POST" && url.pathname === "/remember") {
      const body = await readJson(req);
      if (typeof body.text !== "string" || !body.text) {
        return send(res, 400, { error: "text required" });
      }
      const client = typeof body.client === "string" ? body.client : "anon";
      const r = remember(client, body.text);
      return send(res, 200, r);
    }
    if (req.method === "GET" && url.pathname === "/recall") {
      const q = url.searchParams.get("q") ?? "";
      const limit = clampInt(url.searchParams.get("limit"), 25, 1, 500);
      return send(res, 200, recall(q, limit));
    }
    if (req.method === "GET" && url.pathname === "/events") {
      const since = clampInt(url.searchParams.get("since"), 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = clampInt(url.searchParams.get("limit"), 1000, 1, 10000);
      return send(res, 200, eventsSince(since, limit));
    }
    if (req.method === "POST" && url.pathname === "/reset") {
      return send(res, 200, reset());
    }
    send(res, 404, { error: "not found", path: url.pathname });
  } catch (err) {
    send(res, 500, { error: String(err?.message ?? err) });
  }
});

function clampInt(raw, def, min, max) {
  if (raw == null) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(
    `[authority] listening on http://127.0.0.1:${PORT} db=${DB_PATH} fts=${ftsMode}` +
      (ftsError ? ` ftsError=${ftsError}` : ""),
  );
});

// Clean shutdown so run.sh can SIGTERM us deterministically.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => {
      try { db.close(); } catch {}
      process.exit(0);
    });
  });
}

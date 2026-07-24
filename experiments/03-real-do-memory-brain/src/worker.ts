// Experiment 03 — real Cloudflare Workers + Durable Object SQL prototype
// for Dejavu shared immediate memory.
//
// Shape:
//   POST /remember   { client, text }   -> { id, ulid, durable }
//   GET  /recall?q=  &limit=             -> { hits: [...] }
//   GET  /health                          -> { ok: true, fts: "fts5"|"like" }
//
// Every request is routed to the *same* DO instance (`BRAIN.idFromName("singleton")`).
// That single DO owns one SQLite database via `ctx.storage.sql`. The DO is the
// only authority — same shape as experiment 01, but the authority is a real
// Cloudflare DO running locally inside `wrangler dev`.

export interface Env {
  BRAIN: DurableObjectNamespace;
}

// -----------------------------------------------------------------------------
// Worker entry — pure router. All real work happens inside the DO.
// -----------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.BRAIN.idFromName("singleton");
    const stub = env.BRAIN.get(id);
    return stub.fetch(request);
  },
};

// -----------------------------------------------------------------------------
// Durable Object
// -----------------------------------------------------------------------------
export class BrainDO {
  private ctx: DurableObjectState;
  private sql: SqlStorage;
  private initialized = false;
  // `ftsMode` is decided at init time. We *try* FTS5; if `CREATE VIRTUAL TABLE
  // ... USING fts5` throws inside the DO SQL engine, we fall back to LIKE and
  // record the exact error so RESULT.md can be honest about what local DO SQL
  // supports today.
  private ftsMode: "fts5" | "like" = "like";
  private ftsError: string | null = null;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx;
    // `ctx.storage.sql` is only present when the class is opted in via
    // `new_sqlite_classes` in wrangler.toml. If it's missing, every request
    // will surface a clear 500 instead of silently doing the wrong thing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.sql = (ctx.storage as any).sql as SqlStorage;
  }

  private ensureInit(): void {
    if (this.initialized) return;
    if (!this.sql) {
      throw new Error(
        "ctx.storage.sql is not available — DO is not opted into SQL storage. " +
          "Check `new_sqlite_classes` in wrangler.toml.",
      );
    }

    // Core append-only memory table. `id` is monotonic per DO; `ulid` is a
    // globally-unique opaque receipt the agent layer would hand back to a
    // client. `client` lets us assert cross-client visibility in the harness.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        ulid   TEXT    NOT NULL UNIQUE,
        client TEXT    NOT NULL,
        text   TEXT    NOT NULL,
        ts     INTEGER NOT NULL
      )
    `);

    // Try FTS5. The DO SQL engine is libSQL-flavored SQLite; FTS5 *may* be
    // compiled in. If it's not, the CREATE VIRTUAL TABLE will throw and we
    // capture the message verbatim for RESULT.md.
    try {
      this.sql.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
        USING fts5(text, content='memory', content_rowid='id')
      `);
      // Triggers keep future inserts in sync with the base table. Rebuild below
      // backfills any rows inserted before an earlier failed/partial init left
      // the virtual table present but not populated.
      this.sql.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
          INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
        END
      `);
      this.sql.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
          INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.id, old.text);
        END
      `);
      this.sql.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
          INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.id, old.text);
          INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
        END
      `);
      // External-content FTS tables are not automatically populated by CREATE
      // VIRTUAL TABLE; rebuild once so the same request that just inserted a
      // row can be recalled through FTS, even across dev-server restarts.
      this.sql.exec(`INSERT INTO memory_fts(memory_fts) VALUES('rebuild')`);
      // Probe: actually issue a MATCH query. Some SQLite builds parse the
      // CREATE VIRTUAL TABLE but error at query time; we want one source of
      // truth for ftsMode.
      this.sql.exec(`SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'probe' LIMIT 1`).toArray();
      this.ftsMode = "fts5";
    } catch (err) {
      this.ftsError = err instanceof Error ? err.message : String(err);
      this.ftsMode = "like";
    }

    this.initialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      this.ensureInit();
    } catch (err) {
      return json(500, { ok: false, error: (err as Error).message });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return json(200, {
        ok: true,
        fts: this.ftsMode,
        ftsError: this.ftsError,
      });
    }

    if (url.pathname === "/remember" && request.method === "POST") {
      return await this.handleRemember(request);
    }

    if (url.pathname === "/recall" && request.method === "GET") {
      return this.handleRecall(url);
    }

    return json(404, { ok: false, error: "not found" });
  }

  // ---------------------------------------------------------------------------
  // POST /remember
  //
  // DO single-threaded execution + ctx.storage.sql gives us serialized,
  // synchronous-on-return writes. The receipt is returned only after the
  // INSERT has committed inside the DO. There is no separate "publish" step
  // and no eventual visibility — this is the entire point of the experiment.
  // ---------------------------------------------------------------------------
  private async handleRemember(request: Request): Promise<Response> {
    let body: { client?: unknown; text?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json(400, { ok: false, error: "invalid json" });
    }

    const client = typeof body.client === "string" ? body.client : "";
    const text = typeof body.text === "string" ? body.text : "";
    if (!client || !text) {
      return json(400, { ok: false, error: "client and text are required strings" });
    }

    const ulid = mintUlid();
    const ts = Date.now();

    // `RETURNING id` makes the receipt round-trip exactly one statement.
    const row = this.sql
      .exec(
        `INSERT INTO memory (ulid, client, text, ts) VALUES (?, ?, ?, ?) RETURNING id`,
        ulid,
        client,
        text,
        ts,
      )
      .one() as { id: number };

    // Workerd's local DO SQL accepts FTS5 tables, but this experiment found
    // AFTER INSERT triggers did not make the just-inserted row recallable. The
    // memory authority cannot report success and wait for search. Populate the
    // FTS row explicitly in the same DO turn so read-after-write is provable.
    if (this.ftsMode === "fts5") {
      this.sql.exec(`INSERT INTO memory_fts(rowid, text) VALUES (?, ?)`, row.id, text);
    }

    return json(200, {
      ok: true,
      id: row.id,
      ulid,
      durable: `do-sql:${this.ftsMode}`,
    });
  }

  // ---------------------------------------------------------------------------
  // GET /recall?q=...
  //
  // FTS5 path uses MATCH with a sanitized prefix query; LIKE path is the
  // documented fallback so the experiment still finishes end-to-end even if
  // local DO SQL doesn't expose FTS5.
  // ---------------------------------------------------------------------------
  private handleRecall(url: URL): Response {
    const q = (url.searchParams.get("q") ?? "").trim();
    const limit = clampInt(url.searchParams.get("limit"), 10, 1, 200);
    if (!q) return json(400, { ok: false, error: "q is required" });

    let hits: Array<{ id: number; ulid: string; client: string; text: string; ts: number }>;

    if (this.ftsMode === "fts5") {
      // Tokenize the *query* the same way FTS5's default unicode61 tokenizer
      // tokenizes the *document*: split on anything that isn't a letter,
      // number, or underscore. (FTS5 by default treats `-`, `.`, etc. as
      // separators — if we keep them, `alpha-abc` indexes as two tokens
      // `alpha` and `abc` but a query for `alpha-abc*` matches neither.)
      // Then build a `term* term*` AND-MATCH expression with prefix on each
      // term. This also sanitizes FTS5 operators (AND/OR/NEAR/etc.) out
      // because they can't survive the character filter.
      const safe = q
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((t) => t.length > 0)
        .map((t) => `${t}*`)
        .join(" ");

      if (!safe) {
        // Query was all punctuation; fall through to LIKE for this request.
        hits = this.recallLike(q, limit);
      } else {
        hits = this.sql
          .exec(
            `SELECT m.id, m.ulid, m.client, m.text, m.ts
               FROM memory_fts f
               JOIN memory m ON m.id = f.rowid
              WHERE memory_fts MATCH ?
              ORDER BY m.id DESC
              LIMIT ?`,
            safe,
            limit,
          )
          .toArray() as typeof hits;
      }
    } else {
      hits = this.recallLike(q, limit);
    }

    return json(200, { ok: true, hits, mode: this.ftsMode });
  }

  private recallLike(q: string, limit: number) {
    const like = `%${q.replace(/[%_]/g, (m) => "\\" + m)}%`;
    return this.sql
      .exec(
        `SELECT id, ulid, client, text, ts
           FROM memory
          WHERE text LIKE ? ESCAPE '\\'
          ORDER BY id DESC
          LIMIT ?`,
        like,
        limit,
      )
      .toArray() as Array<{ id: number; ulid: string; client: string; text: string; ts: number }>;
  }
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  if (raw == null) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

// ULID-shaped opaque receipt. Not crypto-grade; matches the format used in
// experiment 01 so RESULT files line up.
function mintUlid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `mem_${hex}`;
}

// Experiment 05 — real Cloudflare Workers + Durable Object SQL prototype,
// shaped for *deployed* use against a public workers.dev URL.
//
// This is a near-verbatim adaptation of experiment 03's worker. The only
// production-shaped differences:
//
//   - `/health` also reports a `build` tag so the harness can tell which
//     deployment it's actually hitting (useful when comparing local vs.
//     deployed runs side-by-side).
//   - `/reset` is exposed *only* when the `DEJAVU_EXP_ALLOW_RESET` env var
//     is set to `"1"` at deploy time. This lets `remote-harness.sh` start
//     from a clean DO before measuring, without leaving a destructive
//     endpoint on by default.
//
// Shape (same as exp 03 — the contract is what we're measuring twice):
//   POST /remember   { client, text }   -> { id, ulid, durable }
//   GET  /recall?q=  &limit=             -> { hits: [...] }
//   GET  /health                          -> { ok, fts, ftsError, build, resetEnabled }
//   POST /reset                           -> { ok, cleared } (only if enabled)
//
// Every request is routed to the *same* DO instance
// (`BRAIN.idFromName("singleton")`). One DO, one SQLite database, one
// authority — exactly the experiment 01/03 shape, but reachable from outside
// `wrangler dev` once you `wrangler deploy`.

export interface Env {
  BRAIN: DurableObjectNamespace;
  // Optional, set in wrangler.toml `[vars]` or via `wrangler secret put`.
  // We do *not* require it — undefined means reset is disabled.
  DEJAVU_EXP_ALLOW_RESET?: string;
  // Optional build identifier; surfaces in /health so the harness can
  // confirm it hit the build it expected.
  DEJAVU_EXP_BUILD?: string;
}

// -----------------------------------------------------------------------------
// Worker entry — pure router. All real work happens inside the DO.
// -----------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.BRAIN.idFromName("singleton");
    const stub = env.BRAIN.get(id);
    // Forward the env's reset/build hints to the DO via headers so the DO
    // doesn't have to be re-bound to env on every request and so the
    // permission decision is made at the edge worker once, deterministically.
    const fwd = new Request(request, request);
    fwd.headers.set("x-dejavu-allow-reset", env.DEJAVU_EXP_ALLOW_RESET === "1" ? "1" : "0");
    fwd.headers.set("x-dejavu-build", env.DEJAVU_EXP_BUILD ?? "unknown");
    return stub.fetch(fwd);
  },
};

// -----------------------------------------------------------------------------
// Durable Object
// -----------------------------------------------------------------------------
export class BrainDO {
  private ctx: DurableObjectState;
  private sql: SqlStorage;
  private initialized = false;
  private ftsMode: "fts5" | "like" = "like";
  private ftsError: string | null = null;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx;
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

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        ulid   TEXT    NOT NULL UNIQUE,
        client TEXT    NOT NULL,
        text   TEXT    NOT NULL,
        ts     INTEGER NOT NULL
      )
    `);

    try {
      this.sql.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
        USING fts5(text, content='memory', content_rowid='id')
      `);
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
      this.sql.exec(`INSERT INTO memory_fts(memory_fts) VALUES('rebuild')`);
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
    const allowReset = request.headers.get("x-dejavu-allow-reset") === "1";
    const build = request.headers.get("x-dejavu-build") ?? "unknown";

    if (url.pathname === "/health" && request.method === "GET") {
      // Report the highest id currently in the table so the harness can
      // anchor "contiguous id range" assertions across multiple runs and
      // confirm whether /reset actually cleared state on a deployed worker.
      let lastId = 0;
      try {
        const row = this.sql.exec(`SELECT COALESCE(MAX(id), 0) AS m FROM memory`).one() as
          | { m: number }
          | undefined;
        if (row && typeof row.m === "number") lastId = row.m;
      } catch {
        // ignore — health stays informative even if the table somehow vanished
      }
      return json(200, {
        ok: true,
        fts: this.ftsMode,
        ftsError: this.ftsError,
        build,
        resetEnabled: allowReset,
        lastId,
      });
    }

    if (url.pathname === "/remember" && request.method === "POST") {
      return await this.handleRemember(request);
    }

    if (url.pathname === "/recall" && request.method === "GET") {
      return this.handleRecall(url);
    }

    if (url.pathname === "/reset" && request.method === "POST") {
      if (!allowReset) {
        return json(403, {
          ok: false,
          error:
            "reset disabled — set DEJAVU_EXP_ALLOW_RESET=1 in the worker env to enable",
        });
      }
      const before = (
        this.sql.exec(`SELECT COUNT(*) AS c FROM memory`).one() as { c: number }
      ).c;
      this.sql.exec(`DELETE FROM memory`);
      if (this.ftsMode === "fts5") {
        // Rebuild keeps the external-content FTS table in sync after a bulk delete.
        try {
          this.sql.exec(`INSERT INTO memory_fts(memory_fts) VALUES('rebuild')`);
        } catch {
          // If rebuild fails on a deployed runtime, fall back to dropping rows
          // explicitly — the next /remember will re-populate via the trigger
          // and the explicit insert in handleRemember.
          try {
            this.sql.exec(`DELETE FROM memory_fts`);
          } catch {
            // Last-ditch: leave FTS in whatever state it's in; reads still work
            // because we DESC by m.id and FTS only filters.
          }
        }
      }
      return json(200, { ok: true, cleared: before });
    }

    return json(404, { ok: false, error: "not found" });
  }

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

    const row = this.sql
      .exec(
        `INSERT INTO memory (ulid, client, text, ts) VALUES (?, ?, ?, ?) RETURNING id`,
        ulid,
        client,
        text,
        ts,
      )
      .one() as { id: number };

    // Same explicit-FTS-insert as experiment 03: triggers fire AFTER INSERT
    // but immediate read-after-write through FTS depends on the row already
    // being present when the response leaves the DO. Belt-and-suspenders here
    // is intentional — duplicates against an external-content FTS are cheap
    // and reads ORDER BY m.id DESC, so a double-insert can't show up twice.
    if (this.ftsMode === "fts5") {
      try {
        this.sql.exec(`INSERT INTO memory_fts(rowid, text) VALUES (?, ?)`, row.id, text);
      } catch {
        // If the trigger already inserted (depends on runtime version),
        // ignore the duplicate.
      }
    }

    return json(200, {
      ok: true,
      id: row.id,
      ulid,
      durable: `do-sql:${this.ftsMode}`,
    });
  }

  private handleRecall(url: URL): Response {
    const q = (url.searchParams.get("q") ?? "").trim();
    const limit = clampInt(url.searchParams.get("limit"), 10, 1, 200);
    if (!q) return json(400, { ok: false, error: "q is required" });

    let hits: Array<{ id: number; ulid: string; client: string; text: string; ts: number }>;

    if (this.ftsMode === "fts5") {
      const safe = q
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((t) => t.length > 0)
        .map((t) => `${t}*`)
        .join(" ");

      if (!safe) {
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

// ULID-shaped opaque receipt. Same format as experiment 01/03 so RESULT
// files line up across the series.
function mintUlid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `mem_${hex}`;
}

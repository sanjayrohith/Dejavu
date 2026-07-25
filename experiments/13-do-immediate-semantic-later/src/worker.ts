interface Env {
  CONTINUITY: DurableObjectNamespace;
}

type SemanticState = "pending" | "submitted" | "visible" | "failed";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // One named object is intentional: this experiment tests one serialized
    // continuity authority, not sharding or placement.
    const id = env.CONTINUITY.idFromName("experiment-13");
    return env.CONTINUITY.get(id).fetch(request);
  },
};

export class ContinuityDO {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx;
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS continuity (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        marker TEXT NOT NULL,
        created_at TEXT NOT NULL,
        semantic_state TEXT NOT NULL DEFAULT 'pending'
          CHECK (semantic_state IN ('pending', 'submitted', 'visible', 'failed')),
        semantic_document_id TEXT,
        semantic_submitted_at TEXT,
        semantic_visible_at TEXT,
        semantic_last_error TEXT
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, authority: "durable-object-sqlite" });
    }

    if (request.method === "POST" && url.pathname === "/records") {
      const body = await request.json<Record<string, unknown>>().catch(() => ({}));
      const id = typeof body.id === "string" ? body.id : "";
      const content = typeof body.content === "string" ? body.content : "";
      const marker = typeof body.marker === "string" ? body.marker : "";
      if (!id || !content || !marker) return json({ error: "id, content, and marker are required" }, 400);

      const createdAt = new Date().toISOString();
      try {
        this.ctx.storage.sql.exec(
          "INSERT INTO continuity (id, content, marker, created_at) VALUES (?, ?, ?, ?)",
          id, content, marker, createdAt,
        );
      } catch (error) {
        return json({ error: "insert failed", detail: String(error) }, 409);
      }
      const record = this.get(id);
      // DO output gates do not release this response until the write is durable.
      return json({ ok: true, committed: true, authority: "durable-object-sqlite", record }, 201);
    }

    if (request.method === "GET" && parts[0] === "records" && parts.length === 2) {
      const record = this.get(decodeURIComponent(parts[1]));
      return record ? json({ record }) : json({ error: "not found" }, 404);
    }

    if (request.method === "PATCH" && parts[0] === "records" && parts[2] === "semantic") {
      const id = decodeURIComponent(parts[1]);
      const body = await request.json<Record<string, unknown>>().catch(() => ({}));
      const state = body.state as SemanticState;
      if (!["submitted", "visible", "failed"].includes(state)) return json({ error: "invalid semantic state" }, 400);
      const current = this.get(id);
      if (!current) return json({ error: "not found" }, 404);
      if (state === "visible" && current.semantic.state !== "submitted") {
        return json({ error: "visible requires submitted state" }, 409);
      }
      const now = new Date().toISOString();
      this.ctx.storage.sql.exec(
        `UPDATE continuity SET semantic_state = ?,
          semantic_document_id = COALESCE(?, semantic_document_id),
          semantic_submitted_at = CASE WHEN ? = 'submitted' THEN ? ELSE semantic_submitted_at END,
          semantic_visible_at = CASE WHEN ? = 'visible' THEN ? ELSE semantic_visible_at END,
          semantic_last_error = ? WHERE id = ?`,
        state,
        typeof body.documentId === "string" ? body.documentId : null,
        state, now, state, now,
        typeof body.error === "string" ? body.error : null,
        id,
      );
      return json({ ok: true, record: this.get(id) });
    }

    return json({ error: "not found" }, 404);
  }

  private get(id: string): any | null {
    const rows = [...this.ctx.storage.sql.exec<any>(
      `SELECT id, content, marker, created_at, semantic_state,
       semantic_document_id, semantic_submitted_at, semantic_visible_at,
       semantic_last_error FROM continuity WHERE id = ?`, id,
    )];
    if (!rows[0]) return null;
    const row = rows[0];
    const fresh = row.semantic_state === "visible";
    return {
      id: row.id,
      content: row.content,
      marker: row.marker,
      createdAt: row.created_at,
      semantic: {
        state: row.semantic_state,
        pending: row.semantic_state === "pending" || row.semantic_state === "submitted",
        stale: !fresh,
        fresh,
        documentId: row.semantic_document_id ?? null,
        submittedAt: row.semantic_submitted_at ?? null,
        visibleAt: row.semantic_visible_at ?? null,
        lastError: row.semantic_last_error ?? null,
      },
    };
  }
}

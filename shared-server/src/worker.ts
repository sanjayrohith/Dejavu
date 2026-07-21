// Dejavu shared memory server.
//
// Local development authentication is deliberately small but no longer means
// "any valid token sees the same memory". A configured token maps to one
// memory space; each space is stored in its own Durable Object.
//
// .dev.vars examples:
//   DEJAVU_SHARED_TOKENS=alice-token:alice,bob-token:bob
//   DEJAVU_SHARED_TOKENS=personal-token:personal,team-token:project-docs
//
// The old DEJAVU_SHARED_TOKEN variable still works locally and maps to the
// `local` space. Do not use either token mode for a deployed employee service;
// production identity/session expiry remains a security design task.

interface Env {
  MEMORY: DurableObjectNamespace;
  /** Local proof format: comma-separated `<token>:<space>` entries. */
  DEJAVU_SHARED_TOKENS?: string;
  /** Backward-compatible local proof token, routed to the `local` space. */
  DEJAVU_SHARED_TOKEN?: string;
  /**
   * Optional maximum lifetime (in seconds) for an authenticated SSE stream.
   * A bounded stream lifetime gives token rotation and revocation an
   * enforceable boundary because callers must reconnect with current
   * credentials before exceeding the cap. Defaults to 15 minutes. Set to
   * "unbounded" to opt out (not recommended for any real deployment).
   */
  DEJAVU_SHARED_STREAM_TTL_SECONDS?: string;
}

type EventType = "remember" | "handoff" | "signal" | "delete";

type ChangeRow = {
  revision: number;
  event_id: string;
  type: EventType;
  committed_at: string;
  payload_json: string;
};

type ChangeEvent = {
  revision: number;
  eventId: string;
  type: EventType;
  authority: string;
  committedAt: string;
  payload: unknown;
};

type RememberPayload = { slipId: string; text?: string; tags?: string[]; authoredBy?: string; sessionId?: string; state?: string };
type DeletePayload = { deleteId: string; slipId: string; authoredBy?: string; sessionId?: string };
type AuthenticatedSpace = { space: string; mode: "mapped-token" | "legacy-local-token" };

const ENCODER = new TextEncoder();
const SAFE_SPACE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const DEFAULT_STREAM_TTL_SECONDS = 15 * 60;

function streamTtlSeconds(env: Env): number | null {
  const raw = (env.DEJAVU_SHARED_STREAM_TTL_SECONDS ?? "").trim();
  if (raw === "") return DEFAULT_STREAM_TTL_SECONDS;
  if (raw.toLowerCase() === "unbounded") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STREAM_TTL_SECONDS;
  return Math.floor(parsed);
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function readBearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.replace(/^Bearer\s+/i, "");
}

function configuredSpaces(env: Env): Map<string, string> {
  const configured = new Map<string, string>();
  for (const entry of (env.DEJAVU_SHARED_TOKENS ?? "").split(",")) {
    const value = entry.trim();
    if (!value) continue;
    const colon = value.indexOf(":");
    if (colon < 1) continue;
    const token = value.slice(0, colon).trim();
    const space = value.slice(colon + 1).trim();
    if (token && SAFE_SPACE.test(space)) configured.set(token, space);
  }
  return configured;
}

function authenticate(request: Request, env: Env): AuthenticatedSpace | null {
  const token = readBearerToken(request);
  if (!token) return null;
  const space = configuredSpaces(env).get(token);
  if (space) return { space, mode: "mapped-token" };
  if (env.DEJAVU_SHARED_TOKEN && token === env.DEJAVU_SHARED_TOKEN) {
    return { space: "local", mode: "legacy-local-token" };
  }
  return null;
}

function unauthorized(): Response {
  return jsonResponse({ ok: false, error: "unauthorized" }, 401);
}

function notFound(): Response {
  return jsonResponse({ ok: false, error: "not found" }, 404);
}

function sseFrame(event: ChangeEvent): Uint8Array {
  const lines =
    `id: ${event.revision}\n` +
    `event: memory\n` +
    `data: ${JSON.stringify(event)}\n\n`;
  return ENCODER.encode(lines);
}

function helloFrame(space: string, headRevision: number): Uint8Array {
  const payload = JSON.stringify({ ok: true, authority: space, headRevision });
  return ENCODER.encode(`event: hello\ndata: ${payload}\n\n`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const authenticated = authenticate(request, env);
    if (!authenticated) return unauthorized();
    const spaceId = env.MEMORY.idFromName(`space:${authenticated.space}`);
    const forwarded = new Request(request);
    forwarded.headers.set("x-dejavu-space", authenticated.space);
    const ttl = streamTtlSeconds(env);
    if (ttl !== null) forwarded.headers.set("x-dejavu-stream-ttl-seconds", String(ttl));
    return env.MEMORY.get(spaceId).fetch(forwarded);
  },
};

export class MemoryServer {
  private readonly sql: SqlStorage;
  private schemaReady = false;
  private readonly streamWriters = new Set<WritableStreamDefaultWriter<Uint8Array>>();

  constructor(ctx: DurableObjectState, _env: Env) {
    this.sql = (ctx.storage as unknown as { sql: SqlStorage }).sql;
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS changes(
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE,
        type TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );`
    );
    this.schemaReady = true;
  }

  private space(request: Request): string {
    const space = request.headers.get("x-dejavu-space") ?? "";
    if (!SAFE_SPACE.test(space)) throw new Error("missing authenticated memory space");
    return space;
  }

  private headRevision(): number {
    const row = this.sql
      .exec(`SELECT COALESCE(MAX(revision), 0) AS n FROM changes`)
      .one() as { n: number | bigint };
    return Number(row.n);
  }

  private listChangesSince(space: string, since: number, limit = 200): ChangeEvent[] {
    const rows = this.sql
      .exec(
        `SELECT revision, event_id, type, committed_at, payload_json
         FROM changes
         WHERE revision > ?
         ORDER BY revision ASC
         LIMIT ?`,
        since,
        limit
      )
      .toArray() as ChangeRow[];
    return rows.map((row) => ({
      revision: Number(row.revision),
      eventId: row.event_id,
      type: row.type,
      authority: space,
      committedAt: row.committed_at,
      payload: JSON.parse(row.payload_json),
    }));
  }

  private purgeRememberPayload(slipId: string): void {
    const rows = this.sql
      .exec(
        `SELECT revision, payload_json
         FROM changes
         WHERE type = 'remember'
         ORDER BY revision ASC`
      )
      .toArray() as Array<{ revision: number; payload_json: string }>;
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as RememberPayload;
      if (payload.slipId !== slipId) continue;
      // Preserve the revision slot and slip id so event replay remains ordered,
      // but permanently drop the saved text/tags/identity from server history.
      this.sql.exec(
        `UPDATE changes SET payload_json = ? WHERE revision = ?`,
        JSON.stringify({ slipId, purged: true }),
        row.revision,
      );
    }
  }

  private recordChange(space: string, type: EventType, id: string, payload: unknown) {
    const eventId = crypto.randomUUID();
    const committedAt = new Date().toISOString();
    const inserted = this.sql
      .exec(
        `INSERT INTO changes(event_id, type, committed_at, payload_json)
         VALUES(?, ?, ?, ?)
         RETURNING revision`,
        eventId,
        type,
        committedAt,
        JSON.stringify(payload)
      )
      .one() as { revision: number | bigint };
    const event: ChangeEvent = {
      revision: Number(inserted.revision),
      eventId,
      type,
      authority: space,
      committedAt,
      payload,
    };
    this.broadcastChange(event);
    return {
      ok: true,
      id,
      event,
      receipt: {
        authority: space,
        revision: event.revision,
        committedAt,
      },
      recallable: true,
    };
  }

  // Failed/stalled stream sends must never block a committed save.
  private broadcastChange(event: ChangeEvent): void {
    const frame = sseFrame(event);
    for (const writer of [...this.streamWriters]) {
      writer.write(frame).catch(() => this.streamWriters.delete(writer));
    }
  }

  private openStream(space: string, since: number, ttlSeconds: number | null): Response {
    const channel = new TransformStream<Uint8Array, Uint8Array>();
    const writer = channel.writable.getWriter();
    void writer.write(helloFrame(space, this.headRevision()));
    for (const event of this.listChangesSince(space, since, 1000)) {
      void writer.write(sseFrame(event));
    }
    this.streamWriters.add(writer);
    const closeStream = (): void => {
      this.streamWriters.delete(writer);
      void writer.close().catch(() => {});
    };
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (ttlSeconds !== null) {
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      void writer.write(
        ENCODER.encode(
          `event: expires\ndata: ${JSON.stringify({
            reason: "stream-ttl",
            ttlSeconds,
            expiresAt,
          })}\n\n`
        )
      );
      timeoutHandle = setTimeout(() => {
        if (!this.streamWriters.has(writer)) return;
        void writer
          .write(
            ENCODER.encode(
              `event: closed\ndata: ${JSON.stringify({ reason: "stream-ttl" })}\n\n`
            )
          )
          .catch(() => {})
          .finally(() => closeStream());
      }, ttlSeconds * 1000);
    }
    const headers: Record<string, string> = {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
    };
    if (ttlSeconds !== null) headers["x-dejavu-stream-ttl-seconds"] = String(ttlSeconds);
    return new Response(channel.readable, { headers });
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const space = this.space(request);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "GET" && path === "/v1/shared/status") {
      return jsonResponse({
        ok: true,
        authority: space,
        headRevision: this.headRevision(),
      });
    }

    if (method === "GET" && path === "/v1/shared/events") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 200);
      return jsonResponse({
        ok: true,
        authority: space,
        headRevision: this.headRevision(),
        events: this.listChangesSince(space, since, limit),
      });
    }

    if (method === "GET" && path === "/v1/shared/stream") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const ttl = request.headers.get("x-dejavu-stream-ttl-seconds");
      const ttlSeconds = ttl === null ? null : Math.max(1, Math.floor(Number(ttl)));
      return this.openStream(space, since, ttlSeconds);
    }

    if (method === "POST" && path === "/v1/shared/remember") {
      const payload = (await request.json()) as { slipId: string };
      return jsonResponse(this.recordChange(space, "remember", payload.slipId, payload));
    }

    if (method === "POST" && path === "/v1/shared/handoff") {
      const payload = (await request.json()) as { handoffId: string };
      return jsonResponse(this.recordChange(space, "handoff", payload.handoffId, payload));
    }

    if (method === "POST" && path === "/v1/shared/signal") {
      const payload = (await request.json()) as { signalId: string };
      return jsonResponse(this.recordChange(space, "signal", payload.signalId, payload));
    }

    if (method === "POST" && path === "/v1/shared/delete") {
      const payload = (await request.json()) as DeletePayload;
      // Commit the deletion first, then redact earlier remembered content in
      // server history. Offline clients replay a redacted remember plus this
      // delete tombstone and finish without the deleted content locally.
      const receipt = this.recordChange(space, "delete", payload.slipId, payload);
      this.purgeRememberPayload(payload.slipId);
      return jsonResponse(receipt);
    }

    return notFound();
  }
}

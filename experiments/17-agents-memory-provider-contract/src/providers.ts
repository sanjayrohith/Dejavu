import type { SqlProvider } from "agents/experimental/memory/session";
import type {
  Freshness,
  MemoryHit,
  MemoryProvider,
  MemoryScope,
  MemoryWrite,
  MutationReceipt,
  RecallRequest,
  RecallResult,
  Resolution,
  WriteReceipt,
} from "./contract";

type MemoryRow = {
  id: string;
  content: string;
  scope_json: string;
  provenance_json: string;
  resolution: string;
  replaced_by: string | null;
  reason: string | null;
  facets: string | null;
};

type PendingRow = { receipt_id: string };

const now = () => new Date().toISOString();
const scopeKey = (scope: MemoryScope) =>
  JSON.stringify({
    tenant: scope.tenant,
    workspace: scope.workspace ?? null,
    agent: scope.agent ?? null,
    session: scope.session ?? null,
  });
const tokenCost = (text: string) => Math.max(1, Math.ceil(text.length / 4));
const words = (text: string) =>
  [...new Set(text.toLowerCase().match(/[a-z0-9_-]+/g) ?? [])];

function pendingFreshness(rows: PendingRow[]): Freshness {
  return {
    state: rows.length ? "pending" : "fresh",
    observedAt: now(),
    pending: rows.map((row) => ({
      kind: "semantic-index",
      receiptId: row.receipt_id,
    })),
  };
}

function hit(row: MemoryRow, score?: number): MemoryHit {
  return {
    id: row.id,
    content: row.content,
    scope: JSON.parse(row.scope_json) as MemoryScope,
    provenance: JSON.parse(row.provenance_json),
    resolution: {
      state: row.resolution as Resolution["state"],
      ...(row.replaced_by ? { replacedBy: row.replaced_by } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
    },
    ...(score === undefined ? {} : { score }),
  };
}

function applyBudget(rows: MemoryHit[], input: RecallRequest, freshness: Freshness): RecallResult {
  const maxItems = input.budget.maxItems ?? Number.MAX_SAFE_INTEGER;
  const selected: MemoryHit[] = [];
  let usedTokens = 0;
  for (const row of rows) {
    const cost = tokenCost(row.content);
    if (selected.length >= maxItems || usedTokens + cost > input.budget.maxTokens) break;
    selected.push(row);
    usedTokens += cost;
  }
  return {
    hits: selected,
    freshness,
    budget: {
      ...input.budget,
      usedTokens,
      truncated: selected.length < rows.length,
    },
  };
}

/** Durable, immediately queryable operational memory backed by the Agent's SQL. */
export class OperationalSqlMemory implements MemoryProvider {
  readonly name = "operational-sql";
  private initialized = false;

  constructor(private readonly db: SqlProvider) {}

  private init() {
    if (this.initialized) return;
    this.db.sql`CREATE TABLE IF NOT EXISTS exp17_operational (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      resolution TEXT NOT NULL DEFAULT 'active',
      replaced_by TEXT,
      reason TEXT,
      facets TEXT
    )`;
    this.initialized = true;
  }

  async write(input: MemoryWrite): Promise<WriteReceipt> {
    this.init();
    const id = crypto.randomUUID();
    const receiptId = crypto.randomUUID();
    const acceptedAt = now();
    this.db.sql`INSERT INTO exp17_operational
      (id, content, scope_key, scope_json, provenance_json, resolution)
      VALUES (${id}, ${input.content}, ${scopeKey(input.scope)}, ${JSON.stringify(input.scope)}, ${JSON.stringify(input.provenance)}, 'active')`;
    return {
      id,
      receiptId,
      acceptedAt,
      durability: "committed",
      scope: input.scope,
      freshness: { state: "fresh", observedAt: acceptedAt, pending: [] },
    };
  }

  async recall(input: RecallRequest): Promise<RecallResult> {
    this.init();
    const rows = this.db.sql<MemoryRow>`SELECT id, content, scope_json, provenance_json,
      resolution, replaced_by, reason, facets FROM exp17_operational
      WHERE scope_key = ${scopeKey(input.scope)} AND resolution = 'active'`;
    const terms = words(input.query);
    const ranked = rows
      .map((row) => ({ row, score: terms.reduce((n, term) => n + (row.content.toLowerCase().includes(term) ? 1 : 0), 0) }))
      .filter(({ score }) => terms.length === 0 || score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ row, score }) => hit(row, score));
    return applyBudget(ranked, input, await this.freshness(input.scope));
  }

  async freshness(_scope: MemoryScope): Promise<Freshness> {
    return { state: "fresh", observedAt: now(), pending: [] };
  }

  async delete(id: string, scope: MemoryScope): Promise<MutationReceipt> {
    return this.mutate(id, scope, { state: "deleted" });
  }

  async resolve(id: string, scope: MemoryScope, resolution: { replacedBy: string; reason?: string }): Promise<MutationReceipt> {
    return this.mutate(id, scope, { state: "superseded", ...resolution });
  }

  private async mutate(id: string, scope: MemoryScope, resolution: Resolution): Promise<MutationReceipt> {
    this.init();
    const existing = this.db.sql<{ id: string }>`SELECT id FROM exp17_operational WHERE id = ${id} AND scope_key = ${scopeKey(scope)}`;
    if (!existing.length) throw new Error("memory not found in scope");
    this.db.sql`UPDATE exp17_operational SET resolution = ${resolution.state},
      replaced_by = ${resolution.replacedBy ?? null}, reason = ${resolution.reason ?? null}
      WHERE id = ${id} AND scope_key = ${scopeKey(scope)}`;
    const committedAt = now();
    return {
      id,
      receiptId: crypto.randomUUID(),
      committedAt,
      scope,
      resolution,
      freshness: { state: "fresh", observedAt: committedAt, pending: [] },
    };
  }
}

/**
 * Durable source rows plus an asynchronous, provider-defined lexical facet index.
 * `drain()` stands in for queue/Workflow processing; no vector representation is assumed.
 */
export class AsyncSemanticMemory implements MemoryProvider {
  readonly name = "async-semantic-facets";
  private initialized = false;

  constructor(private readonly db: SqlProvider) {}

  private init() {
    if (this.initialized) return;
    this.db.sql`CREATE TABLE IF NOT EXISTS exp17_semantic (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      resolution TEXT NOT NULL DEFAULT 'active',
      replaced_by TEXT,
      reason TEXT,
      facets TEXT
    )`;
    this.db.sql`CREATE TABLE IF NOT EXISTS exp17_semantic_pending (
      receipt_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      scope_key TEXT NOT NULL
    )`;
    this.initialized = true;
  }

  async write(input: MemoryWrite): Promise<WriteReceipt> {
    this.init();
    const id = crypto.randomUUID();
    const receiptId = crypto.randomUUID();
    const acceptedAt = now();
    const key = scopeKey(input.scope);
    this.db.sql`INSERT INTO exp17_semantic
      (id, content, scope_key, scope_json, provenance_json, resolution, facets)
      VALUES (${id}, ${input.content}, ${key}, ${JSON.stringify(input.scope)}, ${JSON.stringify(input.provenance)}, 'active', NULL)`;
    this.db.sql`INSERT INTO exp17_semantic_pending (receipt_id, memory_id, scope_key)
      VALUES (${receiptId}, ${id}, ${key})`;
    return {
      id,
      receiptId,
      acceptedAt,
      durability: "committed",
      scope: input.scope,
      freshness: {
        state: "pending",
        observedAt: acceptedAt,
        pending: [{ kind: "semantic-index", receiptId }],
      },
    };
  }

  async drain(): Promise<number> {
    this.init();
    const rows = this.db.sql<{ receipt_id: string; memory_id: string; content: string }>`
      SELECT p.receipt_id, p.memory_id, m.content
      FROM exp17_semantic_pending p JOIN exp17_semantic m ON m.id = p.memory_id`;
    for (const row of rows) {
      this.db.sql`UPDATE exp17_semantic SET facets = ${JSON.stringify(words(row.content))} WHERE id = ${row.memory_id}`;
      this.db.sql`DELETE FROM exp17_semantic_pending WHERE receipt_id = ${row.receipt_id}`;
    }
    return rows.length;
  }

  async recall(input: RecallRequest): Promise<RecallResult> {
    this.init();
    const rows = this.db.sql<MemoryRow>`SELECT id, content, scope_json, provenance_json,
      resolution, replaced_by, reason, facets FROM exp17_semantic
      WHERE scope_key = ${scopeKey(input.scope)} AND resolution = 'active' AND facets IS NOT NULL`;
    const query = words(input.query);
    const ranked = rows
      .map((row) => {
        const facets = new Set(JSON.parse(row.facets ?? "[]") as string[]);
        return { row, score: query.reduce((n, term) => n + (facets.has(term) ? 1 : 0), 0) };
      })
      .filter(({ score }) => query.length === 0 || score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ row, score }) => hit(row, score));
    return applyBudget(ranked, input, await this.freshness(input.scope));
  }

  async freshness(scope: MemoryScope): Promise<Freshness> {
    this.init();
    const rows = this.db.sql<PendingRow>`SELECT receipt_id FROM exp17_semantic_pending WHERE scope_key = ${scopeKey(scope)}`;
    return pendingFreshness(rows);
  }

  async delete(id: string, scope: MemoryScope): Promise<MutationReceipt> {
    return this.mutate(id, scope, { state: "deleted" });
  }

  async resolve(id: string, scope: MemoryScope, resolution: { replacedBy: string; reason?: string }): Promise<MutationReceipt> {
    return this.mutate(id, scope, { state: "superseded", ...resolution });
  }

  private async mutate(id: string, scope: MemoryScope, resolution: Resolution): Promise<MutationReceipt> {
    this.init();
    const existing = this.db.sql<{ id: string }>`SELECT id FROM exp17_semantic WHERE id = ${id} AND scope_key = ${scopeKey(scope)}`;
    if (!existing.length) throw new Error("memory not found in scope");
    this.db.sql`UPDATE exp17_semantic SET resolution = ${resolution.state},
      replaced_by = ${resolution.replacedBy ?? null}, reason = ${resolution.reason ?? null}
      WHERE id = ${id} AND scope_key = ${scopeKey(scope)}`;
    this.db.sql`DELETE FROM exp17_semantic_pending WHERE memory_id = ${id}`;
    const committedAt = now();
    return {
      id,
      receiptId: crypto.randomUUID(),
      committedAt,
      scope,
      resolution,
      freshness: await this.freshness(scope),
    };
  }
}

import assert from "node:assert/strict";

const base = process.env.BASE_URL ?? "http://127.0.0.1:8891";
const scope = { tenant: "acme", workspace: `exp17-${Date.now()}`, agent: "planner" };
const otherScope = { ...scope, workspace: `${scope.workspace}-other` };
const provenance = {
  source: "agent",
  actor: "test-agent",
  ref: "turn-7",
  authoredAt: new Date().toISOString(),
};

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  assert.equal(response.ok, true, `${path}: ${JSON.stringify(json)}`);
  return json;
}

const recall = (adapter, query, targetScope = scope, budget = { maxTokens: 100, maxItems: 5 }) =>
  post(`/recall?adapter=${adapter}`, { query, scope: targetScope, budget });

const health = await fetch(`${base}/health`).then((r) => r.json());
assert.deepEqual(health, { ok: true, primitive: "agents.Agent", version: "0.15.0" });

// Immediate operational adapter: committed receipt means immediate scoped recall.
const old = await post("/write?adapter=operational", {
  content: "deploy checklist uses blue canary",
  scope,
  provenance,
});
assert.equal(old.durability, "committed");
assert.equal(old.freshness.state, "fresh");
assert.deepEqual(old.scope, scope);
let result = await recall("operational", "blue canary");
assert.equal(result.hits[0].id, old.id);
assert.deepEqual(result.hits[0].provenance, provenance);
assert.equal(result.hits[0].resolution.state, "active");
assert.equal((await recall("operational", "blue", otherScope)).hits.length, 0, "scope must isolate recall");

const replacement = await post("/write?adapter=operational", {
  content: "deploy checklist uses green canary",
  scope,
  provenance: { ...provenance, ref: "turn-8" },
});
const resolved = await post("/resolve?adapter=operational", {
  id: old.id,
  scope,
  replacedBy: replacement.id,
  reason: "runbook changed",
});
assert.deepEqual(resolved.resolution, {
  state: "superseded",
  replacedBy: replacement.id,
  reason: "runbook changed",
});
result = await recall("operational", "canary");
assert.equal(result.hits.some((hit) => hit.id === old.id), false);
assert.equal(result.hits.some((hit) => hit.id === replacement.id), true);

const constrained = await recall("operational", "green", scope, { maxTokens: 1, maxItems: 1 });
assert.equal(constrained.hits.length, 0);
assert.equal(constrained.budget.truncated, true);
assert.equal(constrained.budget.usedTokens, 0);

const deleted = await post("/delete?adapter=operational", { id: replacement.id, scope });
assert.equal(deleted.resolution.state, "deleted");
assert.equal((await recall("operational", "green")).hits.length, 0);

// Async semantic adapter: source is durable, while retrieval explicitly reports pending.
const semantic = await post("/write?adapter=semantic", {
  content: "customer prefers lunar release windows",
  scope,
  provenance: { ...provenance, source: "user", ref: "interview-2" },
});
assert.equal(semantic.durability, "committed");
assert.equal(semantic.freshness.state, "pending");
assert.equal(semantic.freshness.pending[0].receiptId, semantic.receiptId);
result = await recall("semantic", "lunar release");
assert.equal(result.hits.length, 0, "pending index must not pretend to be searchable");
assert.equal(result.freshness.state, "pending");
assert.equal(result.freshness.pending[0].receiptId, semantic.receiptId);

const drained = await post("/drain?adapter=semantic", {});
assert.equal(drained.processed >= 1, true);
result = await recall("semantic", "lunar release");
assert.equal(result.freshness.state, "fresh");
assert.equal(result.hits[0].id, semantic.id);
assert.equal(result.hits[0].score, 2);
assert.deepEqual(result.hits[0].scope, scope);

await post("/delete?adapter=semantic", { id: semantic.id, scope });
assert.equal((await recall("semantic", "lunar")).hits.length, 0);

console.log("PASS: agents.Agent DO exercised both MemoryProvider adapters");
console.log("PASS: receipt/freshness/scope/budget/provenance/delete/resolution assertions");
console.log("PASS: async retrieval transitions pending -> fresh without vector assumptions");

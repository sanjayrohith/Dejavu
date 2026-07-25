import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { semanticFlags } from "./harness.mjs";

const base = process.env.DO_BASE;
const integrationTest = base ? test : test.skip;

test("status flags never call pending or submitted fresh", () => {
  assert.deepEqual(semanticFlags("pending"), { pending: true, stale: true, fresh: false });
  assert.deepEqual(semanticFlags("submitted"), { pending: true, stale: true, fresh: false });
  assert.deepEqual(semanticFlags("visible"), { pending: false, stale: false, fresh: true });
});

integrationTest("real local DO commits exact content and immediately reads it as semantic-pending", async () => {
  const id = `exp13-test-${randomUUID()}`;
  const marker = `test-${randomUUID()}`;
  const content = `Synthetic exact test payload ${marker}\nsecond line preserved.`;
  const writeResponse = await fetch(`${base}/records`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, marker, content }),
  });
  assert.equal(writeResponse.status, 201);
  const receipt = await writeResponse.json();
  assert.equal(receipt.committed, true);
  assert.equal(receipt.authority, "durable-object-sqlite");
  assert.equal(receipt.record.content, content);
  assert.deepEqual(
    { state: receipt.record.semantic.state, pending: receipt.record.semantic.pending, stale: receipt.record.semantic.stale, fresh: receipt.record.semantic.fresh },
    { state: "pending", pending: true, stale: true, fresh: false },
  );

  // No Supermemory call occurs in this test, so any fresh result would be theater.
  const readResponse = await fetch(`${base}/records/${encodeURIComponent(id)}`);
  assert.equal(readResponse.status, 200);
  const read = await readResponse.json();
  assert.equal(read.record.content, content);
  assert.equal(read.record.marker, marker);
  assert.equal(read.record.semantic.state, "pending");
  assert.equal(read.record.semantic.fresh, false);
});

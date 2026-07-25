import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const worker = process.env.WORKER_URL ?? "http://127.0.0.1:8792";
const supermemory = process.env.SUPERMEMORY_URL ?? "http://127.0.0.1:6767";

async function jsonFetch(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}: ${text}`);
  return JSON.parse(text);
}

const home = await (await fetch(`${supermemory}/`)).text();
const apiKey = process.env.SUPERMEMORY_API_KEY ?? home.match(/apiKey: &quot;([^&]+)&quot;/)?.[1];
assert(apiKey, "could not discover local Supermemory API key; set SUPERMEMORY_API_KEY");
const marker = `exp12-${Date.now()}-${crypto.randomUUID().replaceAll("-", "")}`;
const health = await jsonFetch(`${worker}/health`);
console.log("worker", health);
const started = await jsonFetch(`${worker}/extractions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ marker, apiKey, baseUrl: supermemory, maxPolls: 45 })
});
console.log("started", started);

let inspection;
for (let attempt = 1; attempt <= 90; attempt++) {
  inspection = await jsonFetch(`${worker}${started.statusUrl}`);
  console.log(`workflow poll ${attempt}:`, inspection.status);
  if (["complete", "errored", "terminated"].includes(inspection.status)) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert(inspection, "workflow emitted no status");
assert.equal(inspection.status, "complete", JSON.stringify(inspection));
const receipt = inspection.output;
assert(receipt, `completed workflow did not expose output: ${JSON.stringify(inspection)}`);
assert.equal(receipt.marker, marker);
assert.equal(receipt.document.customId, marker);
assert.match(receipt.document.content, new RegExp(marker));
assert(["done", "completed", "failed"].includes(receipt.terminalStatus));
assert(receipt.polls.length > 0);

// Replay the exact idempotency key against the real API. A lost submit response can
// therefore be retried without creating a second document.
const replay = await jsonFetch(`${supermemory}/v3/documents`, {
  method: "POST",
  headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
  body: JSON.stringify({
    content: `Experiment 12 synthetic extraction. Unique marker: ${marker}. The durable receipt must preserve this exact marker.`,
    customId: marker,
    metadata: { experiment: "12", marker }
  })
});
assert.equal(replay.id, receipt.documentId, "customId replay created a duplicate document");
const artifact = {
  inspectedAt: new Date().toISOString(),
  health,
  idempotencyReplay: { documentId: replay.id, sameDocument: true },
  receipt
};
await writeFile(new URL("receipt.latest.json", import.meta.url), JSON.stringify(artifact, null, 2) + "\n");
console.log(JSON.stringify(artifact, null, 2));

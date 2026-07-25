import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export function semanticFlags(state) {
  const fresh = state === "visible";
  return {
    pending: state === "pending" || state === "submitted",
    stale: !fresh,
    fresh,
  };
}

async function requestJson(url, options = {}) {
  const started = performance.now();
  const response = await fetch(url, options);
  const elapsedMs = performance.now() - started;
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} -> ${response.status}: ${text}`);
  }
  return { body, elapsedMs, status: response.status };
}

function postJson(url, body) {
  return requestJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchJson(url, body) {
  return requestJson(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resultMarkdown(result) {
  const fmt = (n) => n == null ? "not observed" : `${n.toFixed(2)} ms`;
  const observed = result.semantic.observed;
  return `# Experiment 13 — RESULT

Generated at ${result.generatedAt} from synthetic data against:

- Durable Object: \`${result.doBase}\` (local \`wrangler dev\`, SQLite storage)
- Supermemory: \`${result.supermemoryBase}\` (real local server)
- continuity id: \`${result.id}\`
- synthetic marker: \`${result.marker}\`

## Observations

| event | elapsed / latency | observed state |
| --- | ---: | --- |
| DO write returned committed receipt | ${fmt(result.timings.writeReceiptMs)} | exact=available; semantic=\`pending\`, stale=true, fresh=false |
| immediate DO read-after-write | ${fmt(result.timings.immediateReadMs)} (${fmt(result.timings.readAfterStartMs)} after start) | exact byte-for-byte match=${result.exact.readMatched}; semantic=\`${result.exact.stateAtImmediateRead}\` |
| Supermemory accepted document | ${fmt(result.timings.submitMs)} (${fmt(result.timings.submittedAfterStartMs)} after start) | queued document \`${result.semantic.documentId ?? "none"}\`; semantic=\`submitted\`, stale=true, fresh=false |
| first search result containing that document id | ${fmt(result.timings.visibleAfterStartMs)} after start | ${observed ? "**observed**; semantic=`visible`, stale=false, fresh=true" : "**not observed before timeout**; semantic remains pending/stale and is not claimed fresh"} |

Search attempts: ${result.semantic.attempts}; poll interval: ${result.config.pollMs} ms; timeout: ${result.config.timeoutMs} ms.

## Verdict

${observed
    ? `**Supported in this local run.** The exact continuity path completed and passed read-after-write before semantic submission began. Semantic freshness was not asserted when Supermemory returned \`queued\`; it became fresh only after search returned document id \`${result.semantic.documentId}\`, ${fmt(result.timings.visibleAfterStartMs)} after the write began.`
    : `**Semantic catch-up was not proved in this run.** Exact DO continuity passed, but Supermemory did not return the submitted document in search within the timeout. The durable record remains explicitly \`submitted\` / stale; no freshness claim is made.`}

This proves a two-speed *interface observation*, not production Cloudflare durability or a bound on semantic lag. Local workerd, localhost networking, one record, model warmness, and machine load all affect these numbers.
`;
}

export async function runExperiment(options = {}) {
  const doBase = options.doBase ?? process.env.DO_BASE ?? "http://127.0.0.1:8913";
  const supermemoryBase = options.supermemoryBase ?? process.env.SUPERMEMORY_BASE ?? "http://127.0.0.1:6767";
  const timeoutMs = Number(options.timeoutMs ?? process.env.SEMANTIC_TIMEOUT_MS ?? 180_000);
  const pollMs = Number(options.pollMs ?? process.env.SEMANTIC_POLL_MS ?? 500);
  const out = options.out ?? process.env.RESULT_PATH ?? new URL("RESULT.md", import.meta.url);

  await requestJson(`${doBase}/health`);
  // A POST search verifies the actual API, not merely the Supermemory landing page.
  await postJson(`${supermemoryBase}/v3/search`, { q: `experiment 13 preflight ${randomUUID()}` });

  const id = `exp13-${randomUUID()}`;
  const marker = `semcatch-${randomUUID().replaceAll("-", "")}`;
  const content = `Synthetic continuity record ${marker}. The amber telescope release gate requires a cobalt otter approval. No user data.`;
  const wallStartedAt = new Date().toISOString();
  const started = performance.now();

  const write = await postJson(`${doBase}/records`, { id, marker, content });
  const receiptAt = performance.now();
  if (!write.body.committed || write.body.record.content !== content) throw new Error("DO did not return an exact committed receipt");
  if (write.body.record.semantic.state !== "pending" || write.body.record.semantic.fresh) {
    throw new Error("new DO record did not explicitly report pending/non-fresh semantics");
  }

  // This read intentionally occurs before any request is sent to Supermemory.
  const immediateRead = await requestJson(`${doBase}/records/${encodeURIComponent(id)}`);
  const readAt = performance.now();
  const readMatched = immediateRead.body.record.content === content && immediateRead.body.record.marker === marker;
  if (!readMatched) throw new Error("immediate DO read did not exactly match the committed content");
  if (immediateRead.body.record.semantic.state !== "pending" || !immediateRead.body.record.semantic.stale) {
    throw new Error("immediate read hid the pending/stale semantic state");
  }

  // The slow path starts only after exact read-after-write has been observed.
  const submit = await postJson(`${supermemoryBase}/v3/documents`, {
    content,
    metadata: { experiment: "13", continuityId: id, marker },
  });
  const submittedAt = performance.now();
  if (!submit.body.id) throw new Error(`Supermemory submission had no document id: ${JSON.stringify(submit.body)}`);
  const documentId = submit.body.id;
  const submitted = await patchJson(`${doBase}/records/${encodeURIComponent(id)}/semantic`, {
    state: "submitted",
    documentId,
  });
  if (submitted.body.record.semantic.fresh || !submitted.body.record.semantic.stale) {
    throw new Error("queued submission was incorrectly marked fresh");
  }

  let observed = false;
  let attempts = 0;
  let lastSearch = null;
  while (performance.now() - started < timeoutMs) {
    attempts++;
    const search = await postJson(`${supermemoryBase}/v3/search`, { q: marker });
    lastSearch = search.body;
    observed = Array.isArray(search.body.results) && search.body.results.some((entry) =>
      entry.documentId === documentId && Array.isArray(entry.chunks) &&
      entry.chunks.some((chunk) => typeof chunk.content === "string" && chunk.content.includes(marker))
    );
    if (observed) break;
    await sleep(pollMs);
  }

  let visibleAt = null;
  if (observed) {
    visibleAt = performance.now();
    const visible = await patchJson(`${doBase}/records/${encodeURIComponent(id)}/semantic`, {
      state: "visible",
      documentId,
    });
    if (!visible.body.record.semantic.fresh || visible.body.record.semantic.stale) {
      throw new Error("observed semantic record did not transition to fresh");
    }
  }

  const result = {
    generatedAt: new Date().toISOString(), wallStartedAt, doBase, supermemoryBase,
    id, marker,
    config: { timeoutMs, pollMs },
    exact: {
      committed: write.body.committed,
      readMatched,
      stateAtImmediateRead: immediateRead.body.record.semantic.state,
    },
    semantic: {
      submissionStatus: submit.body.status ?? null,
      documentId,
      observed,
      attempts,
      lastSearchTotal: lastSearch?.total ?? null,
      finalFlags: semanticFlags(observed ? "visible" : "submitted"),
    },
    timings: {
      writeReceiptMs: receiptAt - started,
      immediateReadMs: immediateRead.elapsedMs,
      readAfterStartMs: readAt - started,
      submitMs: submit.elapsedMs,
      submittedAfterStartMs: submittedAt - started,
      visibleAfterStartMs: visibleAt == null ? null : visibleAt - started,
    },
  };

  await writeFile(out, resultMarkdown(result));
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runExperiment().then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (!result.semantic.observed) process.exitCode = 2;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

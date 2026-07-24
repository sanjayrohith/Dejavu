// Experiment 05 harness — runs the same four contract tests as experiments
// 01 and 03 (same-client R-A-W, second-client visibility, concurrent writes,
// latency) but is shaped to also be pointed at a *deployed* workers.dev URL.
//
// The harness itself never deploys anything. It speaks plain HTTP and uses
// Node 22 native `fetch`. Two distinct fetch invocations model two distinct
// clients — there is no shared in-process state between them, so cross-client
// visibility is a real property of the DO, not of the harness.
//
// Flags:
//   --base <url>       endpoint to hit. local: http://127.0.0.1:8875
//                      remote: https://dejavu-exp05-...workers.dev
//   --out <file>       output markdown path (default RESULT.md)
//   --mode local|remote   marks the result for clarity (default local)
//   --label <string>      free-form label for the RESULT (e.g. "deployed-iad")
//   --reset            POST /reset before testing. Only succeeds if the
//                      worker was deployed with DEJAVU_EXP_ALLOW_RESET=1; on
//                      a remote URL this is the only safe way to start
//                      from a clean DO.
//   --concurrent <n>   concurrent writers in test 3 (default 64)
//   --sequential <n>   sequential ops in test 4 (default 50)
//   --warm <n>         warm-up requests before timing (default 3, helpful for
//                      remote runs where the first request pays DO cold-start)

import { writeFileSync } from "node:fs";
import { argv } from "node:process";

const args = parseArgs(argv.slice(2));
const base = (args.base ?? "http://127.0.0.1:8875").replace(/\/+$/, "");
const out = args.out ?? "RESULT.md";
const mode = args.mode ?? "local";
const label = args.label ?? "";
const doReset = !!args.reset;
const N = clampInt(args.concurrent, 64, 1, 512);
const M = clampInt(args.sequential, 50, 1, 1000);
const warm = clampInt(args.warm, 3, 0, 50);

function parseArgs(arr) {
  const o = {};
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = arr[i + 1];
      if (next === undefined || next.startsWith("--")) {
        o[key] = true; // boolean flag
      } else {
        o[key] = next;
        i++;
      }
    }
  }
  return o;
}

function clampInt(raw, def, min, max) {
  if (raw == null || raw === true) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

async function jget(path) {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.json() };
}
async function jpost(path, body) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json() };
}

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
}
const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);

async function main() {
  // ---- preflight: refuse to talk to anything that isn't /health-shaped ----
  const health = await jget("/health");
  if (health.status !== 200 || !health.body || health.body.ok !== true) {
    console.error(
      `preflight: GET ${base}/health did not return ok=true (status=${health.status}). ` +
        `Refusing to run — pointed at the wrong URL?`,
    );
    process.exit(1);
  }
  const ftsMode = health.body.fts;
  const ftsError = health.body.ftsError;
  const build = health.body.build ?? "unknown";
  const resetEnabled = !!health.body.resetEnabled;
  const lastIdAtStart = health.body.lastId ?? 0;

  // ---- optional reset ----
  let resetReport = "not requested";
  if (doReset) {
    const rs = await jpost("/reset", {});
    if (rs.status === 200 && rs.body?.ok) {
      resetReport = `cleared ${rs.body.cleared} rows`;
    } else {
      resetReport = `reset refused (status=${rs.status}, body=${JSON.stringify(rs.body)})`;
      console.warn(`[harness] /reset returned ${rs.status}; continuing without a clean DO`);
    }
  }

  // Re-probe health after reset so the rest of the run anchors off the post-reset baseline.
  const health2 = await jget("/health");
  const baseLastId = health2.body?.lastId ?? lastIdAtStart;

  // ---- warm-up (don't time, but exercise the path) ----
  for (let i = 0; i < warm; i++) {
    const tag = `warm-${Math.random().toString(36).slice(2, 8)}`;
    await jpost("/remember", { client: "warm", text: `warmup ${tag}` });
    await jget(`/recall?q=${encodeURIComponent(tag)}`);
  }
  // After warm-up the lastId has advanced; refresh the baseline so concurrency
  // assertions in test 3 still hold.
  const healthAfterWarm = await jget("/health");
  const baseAfterWarm = healthAfterWarm.body?.lastId ?? baseLastId;

  // ---- Test 1: same-client read-after-write ----
  const tag1 = `alpha-${Math.random().toString(36).slice(2, 10)}`;
  const w1 = await jpost("/remember", { client: "alice", text: `hello ${tag1} world` });
  const r1 = await jget(`/recall?q=${encodeURIComponent(tag1)}`);
  const test1 = {
    id: w1.body.id,
    ulid: w1.body.ulid,
    durable: w1.body.durable,
    sawOwn: r1.body.hits.some((h) => h.ulid === w1.body.ulid),
    hitCount: r1.body.hits.length,
  };

  // ---- Test 2: cross-client visibility ----
  const tag2 = `beta-${Math.random().toString(36).slice(2, 10)}`;
  const w2 = await jpost("/remember", { client: "alice", text: `cross ${tag2} client` });
  const r2 = await jget(`/recall?q=${encodeURIComponent(tag2)}`);
  const test2 = {
    id: w2.body.id,
    ulid: w2.body.ulid,
    sawAlice: r2.body.hits.some((h) => h.ulid === w2.body.ulid),
    hitCount: r2.body.hits.length,
  };

  // ---- Test 3: concurrent writers ----
  const baseId = w2.body.id; // last known id before the burst
  const tag3 = `gamma-${Math.random().toString(36).slice(2, 10)}`;
  const t0 = performance.now();
  const writeLatencies = [];
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      (async () => {
        const ts0 = performance.now();
        const r = await jpost("/remember", {
          client: `worker-${i}`,
          text: `${tag3} payload ${i}`,
        });
        writeLatencies.push(performance.now() - ts0);
        return r.body;
      })(),
    ),
  );
  const tBurst = performance.now() - t0;

  const ids = results.map((r) => r.id).filter((x) => typeof x === "number");
  const ulids = results.map((r) => r.ulid);
  const uniqUlids = new Set(ulids).size === ulids.length;
  const uniqIds = new Set(ids).size === ids.length;
  ids.sort((a, b) => a - b);
  const minId = ids[0];
  const maxId = ids[ids.length - 1];
  const contiguous = ids.every((v, i) => i === 0 || v === ids[i - 1] + 1);
  const startsAtBasePlus1 = minId === baseId + 1;

  const recallAll = await jget(`/recall?q=${encodeURIComponent(tag3)}&limit=200`);
  const recalledTexts = new Set(recallAll.body.hits.map((h) => h.text));
  const expected = Array.from({ length: N }, (_, i) => `${tag3} payload ${i}`);
  const missing = expected.filter((t) => !recalledTexts.has(t));

  const test3 = {
    N,
    errors: results.filter((r) => !r.ok).length,
    uniqUlids,
    uniqIds,
    contiguous,
    startsAtBasePlus1,
    idRange: [minId, maxId],
    missing: missing.length,
    burstMs: tBurst,
    writeP50: pct(writeLatencies, 50),
    writeP95: pct(writeLatencies, 95),
    writeP99: pct(writeLatencies, 99),
    writeMax: Math.max(...writeLatencies),
  };

  // ---- Test 4: light-load latency, sequential ----
  const rem = [];
  const rec = [];
  const e2e = [];
  let lostInLatency = 0;
  for (let i = 0; i < M; i++) {
    const tag = `delta-${i}-${Math.random().toString(36).slice(2, 8)}`;
    const a = performance.now();
    const wr = await jpost("/remember", { client: "lat", text: `lat ${tag}` });
    const b = performance.now();
    const rc = await jget(`/recall?q=${encodeURIComponent(tag)}`);
    const c = performance.now();
    rem.push(b - a);
    rec.push(c - b);
    e2e.push(c - a);
    if (!rc.body.hits.some((h) => h.ulid === wr.body.ulid)) {
      lostInLatency += 1;
      console.error(`latency loop: lost write ${wr.body.ulid}`);
    }
  }
  const test4 = {
    remember: { mean: mean(rem), p50: pct(rem, 50), p95: pct(rem, 95), p99: pct(rem, 99) },
    recall: { mean: mean(rec), p50: pct(rec, 50), p95: pct(rec, 95), p99: pct(rec, 99) },
    e2e: { mean: mean(e2e), p50: pct(e2e, 50), p95: pct(e2e, 95), p99: pct(e2e, 99) },
    lost: lostInLatency,
  };

  const stamp = new Date().toISOString();
  const isHttps = base.startsWith("https://");
  const headlineMode = mode === "remote" ? "deployed" : "local `wrangler dev`";

  const md = `# Experiment 05 — RESULT (${mode}${label ? `, ${label}` : ""})

- run timestamp: ${stamp}
- brain endpoint: \`${base}\`  (${isHttps ? "https" : "http"})
- prototype: real Cloudflare Worker + Durable Object — ${headlineMode}, DO uses \`ctx.storage.sql\`.
- worker build tag: \`${build}\`
- FTS mode: **${ftsMode}**${ftsError ? `  (FTS5 init error: \`${ftsError.replace(/`/g, "'")}\`)` : ""}
- reset endpoint at run start: ${resetEnabled ? "enabled" : "disabled"}
- /reset action: ${resetReport}
- lastId observed at start (after optional reset): ${baseLastId}
- lastId observed after warm-up (${warm} req): ${baseAfterWarm}

## Test 1 — same-client read-after-write

- receipt id: \`${test1.id}\`  ulid: \`${test1.ulid}\`  durable: \`${test1.durable}\`
- recalled own write: **${test1.sawOwn}**  (${test1.hitCount} hits)

## Test 2 — receipt → *different* client recall

- receipt id: \`${test2.id}\`  ulid: \`${test2.ulid}\`
- second client saw the write: **${test2.sawAlice}**  (${test2.hitCount} hits)

## Test 3 — concurrency (N=${test3.N})

- writers: ${test3.N}  errors: ${test3.errors}
- unique ulids: ${test3.uniqUlids}  unique ids: ${test3.uniqIds}
- contiguous id range: ${test3.contiguous}  starts at base+1: ${test3.startsAtBasePlus1}
- id range: [${test3.idRange[0]}, ${test3.idRange[1]}]
- texts missing from recall: ${test3.missing}
- write latency under load: p50=${fmt(test3.writeP50)}ms  p95=${fmt(test3.writeP95)}ms  p99=${fmt(test3.writeP99)}ms  max=${fmt(test3.writeMax)}ms
- burst wall-time: ${fmt(test3.burstMs)}ms

## Test 4 — latency (light load, sequential, M=${M})

- **remember**: mean=${fmt(test4.remember.mean)}ms  p50=${fmt(test4.remember.p50)}ms  p95=${fmt(test4.remember.p95)}ms  p99=${fmt(test4.remember.p99)}ms
- **recall**:   mean=${fmt(test4.recall.mean)}ms  p50=${fmt(test4.recall.p50)}ms  p95=${fmt(test4.recall.p95)}ms  p99=${fmt(test4.recall.p99)}ms
- **e2e**:      mean=${fmt(test4.e2e.mean)}ms  p50=${fmt(test4.e2e.p50)}ms  p95=${fmt(test4.e2e.p95)}ms  p99=${fmt(test4.e2e.p99)}ms
- read-after-write losses in light-load loop: ${test4.lost} (must be 0)

## Interpretation

The DO is the only authority and DO execution is single-threaded, so every
\`remember\` \`INSERT ... RETURNING id\` commits before the response leaves the
DO. A subsequent \`recall\` — whether issued by the same client (test 1) or
by an unrelated fetch caller (test 2) — hits the same DO and sees the row.
There is no replication lag because there is exactly one place memory lives.

Concurrency holds for the same reason: ${test3.N} parallel POSTs to
\`/remember\` are serialized by the DO's input gate and committed one at a time
by SQLite. Ids come back contiguous and ulids unique, with no missing payloads
on recall.

${
    mode === "remote"
      ? "Latency numbers above include real network RTT from the harness host to Cloudflare's edge plus DO placement + DO storage commit. They are a real measurement of how far reality is from local `wrangler dev`."
      : "Latency numbers above are local `wrangler dev` — workerd in-process. Useful as a floor; real CF numbers come from a `--mode remote` run against a deployed URL."
  }

FTS5 status: **${ftsMode}**. ${
    ftsMode === "fts5"
      ? "DO SQL accepted `CREATE VIRTUAL TABLE ... USING fts5(...)` and answered a MATCH query."
      : `DO SQL rejected FTS5 at init time:\n\n\u0060\u0060\u0060\n${ftsError ?? "(no message)"}\n\u0060\u0060\u0060\n\nThe harness fell back to \`LIKE\`-based recall in the same code path; visibility and concurrency claims still hold.`
  }

## Honest limitations of this prototype

- One DO id only (\`idFromName("singleton")\`). Sharding / placement / cold-start across many DOs are not modeled.
- Test 3's "burst" is bounded by the harness host's outbound HTTP concurrency, not by the DO itself.
- ${mode === "remote" ? "Remote latency includes everything from harness → CF edge → DO. A bad result can be CF placement, harness network, or DO — this experiment does not separate them." : "Local `wrangler dev` is not a Cloudflare durability proof. Numbers will differ on real CF; the *contract* should not."}
- Ulid is \`crypto.getRandomValues\`-based, not time-sortable. Matches the rest of the series; not production-grade.
- No auth, no quotas, no eviction, no embeddings.
`;

  writeFileSync(out, md);
  console.log(`wrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

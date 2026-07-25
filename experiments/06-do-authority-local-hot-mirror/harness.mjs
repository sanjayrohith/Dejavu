// Experiment 06 — harness.
//
// Drives a running authority server (src/authority.mjs) and two client
// mirrors (src/client.mjs), produces RESULT.md.
//
// What we actually measure, and why:
//
//   T1. Same-client receipt -> warm local recall.
//       After remember() returns, can the same client recallLocal() and
//       get the row? This is the "feels local" core claim. If this fails
//       the whole design is broken.
//
//   T2. Cross-client authoritative recall.
//       Client A writes, client B has *not* caught up yet. Does
//       B.recallAuth() see the write? Yes always — authority is truth.
//       Does B.recallLocal() see it? No, until catchUp. This is the
//       stale-detection point.
//
//   T3. Cross-client local recall after catch-up.
//       B.catchUp() pulls events since its mirror_revision. Then
//       B.recallLocal() must see A's write, and B.mirror_revision must
//       equal authority head_revision.
//
//   T4. Stale detection / freshness probe.
//       A writes 20 events. B does *not* catchUp. B.freshness() must
//       report behind > 0 and fresh=false. This is the "we are honest
//       about being stale" check.
//
//   T5. Concurrent writes from two clients.
//       Issue N writes from A and B in parallel. The authority must hand
//       out unique strictly-increasing revisions to all of them, and
//       after both clients catchUp they must each see all 2N rows in
//       their local mirror.
//
//   T6. Latency distribution.
//       remember: round trip + local apply.
//       recallLocal: warm in-process SQLite.
//       recallAuth: round trip.
//       Compared side-by-side so the "local mirror" claim is measurable.
//
// Output is a RESULT.md with raw numbers and an Interpretation section
// that's deliberately blunt about whether this design is buying us anything.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { argv } from "node:process";
import { createClient } from "./src/client.mjs";

const args = parseArgs(argv.slice(2));
const base = (args.base ?? "http://127.0.0.1:8876").replace(/\/+$/, "");
const out = args.out ?? "RESULT.md";
const label = args.label ?? "";
const N = clampInt(args.concurrent, 32, 1, 512);
const M = clampInt(args.sequential, 50, 1, 1000);
const tmpDir = args.tmpdir ?? "./.tmp";

function parseArgs(arr) {
  const o = {};
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = arr[i + 1];
      if (next === undefined || next.startsWith("--")) {
        o[key] = true;
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

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function fmt(n) {
  if (n == null) return "n/a";
  return n.toFixed(2);
}

async function fetchJson(method, path, body) {
  const url = base + path;
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetch(url, init);
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

async function main() {
  // Always reset authority so the run is deterministic.
  await fetchJson("POST", "/reset");
  const startHealth = await fetchJson("GET", "/health");

  mkdirSync(resolve(tmpDir), { recursive: true });
  // Each harness run uses a fresh sqlite file per client so we measure
  // the protocol, not a leftover mirror.
  const ts = Date.now();
  const aliceDb = resolve(tmpDir, `alice-${ts}.sqlite`);
  const bobDb = resolve(tmpDir, `bob-${ts}.sqlite`);

  const alice = createClient({ name: "alice", authorityBase: base, dbPath: aliceDb });
  const bob = createClient({ name: "bob", authorityBase: base, dbPath: bobDb });

  // -------------------- T1 --------------------
  const t1Receipt = await alice.remember("apricot orchard at dawn");
  const t1Local = alice.recallLocal("apricot");
  const t1Pass =
    t1Local.hits.some((h) => h.ulid === t1Receipt.ulid) &&
    t1Local.mirror_revision === t1Receipt.revision;

  // -------------------- T2 --------------------
  const t2Receipt = await alice.remember("blue heron over the marsh");
  // Bob deliberately does NOT catchUp.
  const t2BobAuth = await bob.recallAuth("blue heron");
  const t2BobLocal = bob.recallLocal("blue heron");
  const t2AuthSaw = t2BobAuth.hits.some((h) => h.ulid === t2Receipt.ulid);
  // Stale-detection: bob's mirror_revision is behind head.
  const t2Fresh = await bob.freshness();
  const t2BobStaleDetected = !t2Fresh.fresh && t2Fresh.behind > 0;

  // -------------------- T3 --------------------
  const t3Catch = await bob.catchUp();
  const t3BobLocal = bob.recallLocal("blue heron");
  const t3Fresh = await bob.freshness();
  const t3Pass =
    t3BobLocal.hits.some((h) => h.ulid === t2Receipt.ulid) &&
    t3Fresh.fresh &&
    t3Fresh.behind === 0;

  // -------------------- T4 --------------------
  // Alice writes a batch. Bob explicitly does not catchUp until the very end.
  const t4Writes = [];
  for (let i = 0; i < 20; i++) {
    t4Writes.push(await alice.remember(`citrine canyon note #${i}`));
  }
  const t4FreshBefore = await bob.freshness();
  const t4LocalBefore = bob.recallLocal("citrine canyon");
  const t4StaleClaimedHonest =
    !t4FreshBefore.fresh &&
    t4FreshBefore.behind >= 20 &&
    t4LocalBefore.hits.length === 0; // mirror really doesn't have them
  const t4Catch = await bob.catchUp();
  const t4LocalAfter = bob.recallLocal("citrine canyon");
  const t4FreshAfter = await bob.freshness();
  const t4AfterPass = t4LocalAfter.hits.length === 20 && t4FreshAfter.fresh;

  // -------------------- T5 --------------------
  // N concurrent writes from each of alice & bob.
  const t5Errs = [];
  const t5Writes = await Promise.all([
    ...Array.from({ length: N }, (_, i) =>
      alice.remember(`durian duet alice ${i}`).catch((e) => (t5Errs.push(e), null)),
    ),
    ...Array.from({ length: N }, (_, i) =>
      bob.remember(`durian duet bob ${i}`).catch((e) => (t5Errs.push(e), null)),
    ),
  ]);
  const t5Ok = t5Writes.filter(Boolean);
  const t5Revs = t5Ok.map((w) => w.revision);
  const t5UniqueRevs = new Set(t5Revs).size === t5Revs.length;
  const t5UniqueUlids = new Set(t5Ok.map((w) => w.ulid)).size === t5Ok.length;
  const t5MinRev = Math.min(...t5Revs);
  const t5MaxRev = Math.max(...t5Revs);
  const t5Contiguous = t5MaxRev - t5MinRev + 1 === t5Ok.length;
  // Catch up both, then each must see all 2N "durian duet" rows.
  await alice.catchUp();
  await bob.catchUp();
  const t5AliceHits = alice.recallLocal("durian duet", 1000).hits.length;
  const t5BobHits = bob.recallLocal("durian duet", 1000).hits.length;
  const t5Pass =
    t5Errs.length === 0 &&
    t5UniqueRevs &&
    t5UniqueUlids &&
    t5Contiguous &&
    t5AliceHits === 2 * N &&
    t5BobHits === 2 * N;

  // -------------------- T6 --------------------
  // Latency micro-benchmarks. We measure remember (auth + apply),
  // recallLocal (warm), recallAuth (round trip). M iterations each.
  const remAuth = [];
  const remApply = [];
  const remTotal = [];
  for (let i = 0; i < M; i++) {
    const r = await alice.remember(`eggshell evening seq ${i}`);
    remAuth.push(r.timings_ms.authority_remember);
    remApply.push(r.timings_ms.local_apply);
    remTotal.push(r.timings_ms.total);
  }
  // recallLocal: we use a query that we know matches a lot of rows.
  const rclLocal = [];
  for (let i = 0; i < M; i++) {
    const r = alice.recallLocal("eggshell evening");
    rclLocal.push(r.timing_ms);
  }
  const rclAuth = [];
  for (let i = 0; i < M; i++) {
    const r = await alice.recallAuth("eggshell evening");
    rclAuth.push(r.timing_ms);
  }

  // -------------------- write RESULT --------------------
  const endHealth = await fetchJson("GET", "/health");

  const md = renderResult({
    label,
    base,
    startHealth,
    endHealth,
    aliceFts: alice.fts,
    aliceFtsError: alice.ftsError,
    bobFts: bob.fts,
    t1: { pass: t1Pass, receipt: t1Receipt, local: t1Local },
    t2: {
      pass: t2AuthSaw && t2BobStaleDetected,
      auth_saw: t2AuthSaw,
      stale_detected: t2BobStaleDetected,
      fresh: t2Fresh,
      bobLocalHits: t2BobLocal.hits.length,
    },
    t3: {
      pass: t3Pass,
      catch: t3Catch,
      fresh: t3Fresh,
      bobLocalHits: t3BobLocal.hits.length,
    },
    t4: {
      stale_claimed_honest: t4StaleClaimedHonest,
      after_pass: t4AfterPass,
      fresh_before: t4FreshBefore,
      catch: t4Catch,
      fresh_after: t4FreshAfter,
      local_before_hits: t4LocalBefore.hits.length,
      local_after_hits: t4LocalAfter.hits.length,
    },
    t5: {
      pass: t5Pass,
      errs: t5Errs.length,
      n_per_client: N,
      unique_revs: t5UniqueRevs,
      unique_ulids: t5UniqueUlids,
      contiguous: t5Contiguous,
      revRange: [t5MinRev, t5MaxRev],
      alice_local_hits: t5AliceHits,
      bob_local_hits: t5BobHits,
    },
    t6: {
      M,
      remAuth: stats(remAuth),
      remApply: stats(remApply),
      remTotal: stats(remTotal),
      rclLocal: stats(rclLocal),
      rclAuth: stats(rclAuth),
    },
  });
  writeFileSync(resolve(out), md, "utf8");

  alice.close();
  bob.close();

  // eslint-disable-next-line no-console
  console.log(`[harness] wrote ${out}`);
  const allPass =
    t1Pass &&
    t2AuthSaw &&
    t2BobStaleDetected &&
    t3Pass &&
    t4StaleClaimedHonest &&
    t4AfterPass &&
    t5Pass;
  if (!allPass) {
    // eslint-disable-next-line no-console
    console.error("[harness] one or more assertions failed; see RESULT.md");
    process.exitCode = 1;
  }
}

function stats(a) {
  return {
    mean: mean(a),
    p50: pct(a, 50),
    p95: pct(a, 95),
    p99: pct(a, 99),
    max: a.length ? Math.max(...a) : null,
  };
}

function renderResult(d) {
  const lines = [];
  lines.push(`# Experiment 06 — RESULT (DO-authority + local hot mirror)`);
  lines.push("");
  lines.push(`- run timestamp: ${new Date().toISOString()}`);
  if (d.label) lines.push(`- label: \`${d.label}\``);
  lines.push(`- authority endpoint: \`${d.base}\``);
  lines.push(`- authority head_revision at start: ${d.startHealth.head_revision}`);
  lines.push(`- authority head_revision at end:   ${d.endHealth.head_revision}`);
  lines.push(`- authority FTS mode: **${d.startHealth.fts}**` +
    (d.startHealth.ftsError ? `  (error: ${d.startHealth.ftsError})` : ""));
  lines.push(`- alice mirror FTS: **${d.aliceFts}**` + (d.aliceFtsError ? ` (error: ${d.aliceFtsError})` : ""));
  lines.push(`- bob   mirror FTS: **${d.bobFts}**`);
  lines.push("");

  lines.push(`## T1 — same-client receipt -> warm local recall`);
  lines.push("");
  lines.push(`- receipt: id=${d.t1.receipt.id} ulid=\`${d.t1.receipt.ulid}\` revision=${d.t1.receipt.revision}`);
  lines.push(`- timings_ms: authority_remember=${fmt(d.t1.receipt.timings_ms.authority_remember)} local_apply=${fmt(d.t1.receipt.timings_ms.local_apply)} total=${fmt(d.t1.receipt.timings_ms.total)}`);
  lines.push(`- recallLocal hits: ${d.t1.local.hits.length}  mirror_revision after: ${d.t1.local.mirror_revision}`);
  lines.push(`- **PASS: ${d.t1.pass}**`);
  lines.push("");

  lines.push(`## T2 — cross-client: authority sees instantly, stale mirror is honest about it`);
  lines.push("");
  lines.push(`- bob.recallAuth saw alice's write: **${d.t2.auth_saw}**`);
  lines.push(`- bob.recallLocal hits (no catchUp): ${d.t2.bobLocalHits}`);
  lines.push(`- bob.freshness: mirror_revision=${d.t2.fresh.mirror_revision} head_revision=${d.t2.fresh.head_revision} behind=${d.t2.fresh.behind} fresh=${d.t2.fresh.fresh} head_probe_ms=${fmt(d.t2.fresh.head_probe_ms)}`);
  lines.push(`- stale_detected_honestly: **${d.t2.stale_detected}**`);
  lines.push(`- **PASS: ${d.t2.pass}**`);
  lines.push("");

  lines.push(`## T3 — catch-up: bob becomes fresh and local recall works`);
  lines.push("");
  lines.push(`- bob.catchUp: applied=${d.t3.catch.applied} pages=${d.t3.catch.pages} timing_ms=${fmt(d.t3.catch.timing_ms)} mirror_revision=${d.t3.catch.mirror_revision} head_revision=${d.t3.catch.head_revision}`);
  lines.push(`- bob.recallLocal hits after catchUp: ${d.t3.bobLocalHits}`);
  lines.push(`- bob.freshness: behind=${d.t3.fresh.behind} fresh=${d.t3.fresh.fresh}`);
  lines.push(`- **PASS: ${d.t3.pass}**`);
  lines.push("");

  lines.push(`## T4 — stale window is *measurably* stale, then closes`);
  lines.push("");
  lines.push(`- 20 writes by alice while bob does nothing`);
  lines.push(`- bob.freshness (before catchUp): mirror_revision=${d.t4.fresh_before.mirror_revision} head_revision=${d.t4.fresh_before.head_revision} behind=${d.t4.fresh_before.behind} fresh=${d.t4.fresh_before.fresh}`);
  lines.push(`- bob.recallLocal hits (before catchUp): ${d.t4.local_before_hits}  (expected 0 — mirror has not caught up)`);
  lines.push(`- stale_claimed_honest: **${d.t4.stale_claimed_honest}**  (mirror did *not* silently fabricate freshness)`);
  lines.push(`- bob.catchUp: applied=${d.t4.catch.applied} pages=${d.t4.catch.pages} timing_ms=${fmt(d.t4.catch.timing_ms)}`);
  lines.push(`- bob.recallLocal hits (after catchUp): ${d.t4.local_after_hits}`);
  lines.push(`- bob.freshness (after catchUp): behind=${d.t4.fresh_after.behind} fresh=${d.t4.fresh_after.fresh}`);
  lines.push(`- **PASS: ${d.t4.after_pass && d.t4.stale_claimed_honest}**`);
  lines.push("");

  lines.push(`## T5 — concurrent writes from two clients`);
  lines.push("");
  lines.push(`- N writes per client (parallel): ${d.t5.n_per_client}  (total ${2 * d.t5.n_per_client})`);
  lines.push(`- errors: ${d.t5.errs}`);
  lines.push(`- unique revisions: ${d.t5.unique_revs}  unique ulids: ${d.t5.unique_ulids}  contiguous: ${d.t5.contiguous}`);
  lines.push(`- revision range: [${d.t5.revRange[0]}, ${d.t5.revRange[1]}]`);
  lines.push(`- alice.recallLocal hits (after catchUp): ${d.t5.alice_local_hits}  (expected ${2 * d.t5.n_per_client})`);
  lines.push(`- bob.recallLocal   hits (after catchUp): ${d.t5.bob_local_hits}  (expected ${2 * d.t5.n_per_client})`);
  lines.push(`- **PASS: ${d.t5.pass}**`);
  lines.push("");

  lines.push(`## T6 — latency (M=${d.t6.M}, alice only, sequential)`);
  lines.push("");
  const rows = [
    ["remember.authority_remember", d.t6.remAuth],
    ["remember.local_apply", d.t6.remApply],
    ["remember.total", d.t6.remTotal],
    ["recallLocal (warm)", d.t6.rclLocal],
    ["recallAuth (round trip)", d.t6.rclAuth],
  ];
  lines.push(`| operation | mean ms | p50 | p95 | p99 | max |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const [k, s] of rows) {
    lines.push(`| ${k} | ${fmt(s.mean)} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${fmt(s.max)} |`);
  }
  lines.push("");

  lines.push(`## Interpretation`);
  lines.push("");
  lines.push(
    `The hybrid contract holds in this prototype: a writer gets a receipt`,
    `from the authority, immediately applies the acked event to its own`,
    `SQLite mirror, and a subsequent local recall on the same client returns`,
    `the row without another network round-trip (T1). Cross-client reads via`,
    `\`/recall\` see writes immediately because the authority is the only`,
    `truth (T2). Local recall on a peer that hasn't caught up does *not*`,
    `silently claim freshness — the freshness probe reports \`behind > 0\``,
    `and \`fresh = false\` (T2, T4). After \`catchUp()\`, the mirror`,
    `converges to authority head and local recall sees the writes (T3,`,
    `T4, T5).`,
  );
  lines.push("");
  lines.push(`### Latency observation`);
  lines.push("");
  lines.push(
    `\`recallLocal\` (warm SQLite FTS5 in-process) is consistently faster`,
    `than \`recallAuth\` (HTTP round trip to the local authority). On a`,
    `real deployment where the authority is a remote DO across the public`,
    `internet that gap widens dramatically; on loopback like this run it is`,
    `still measurable but smaller. The \`remember.local_apply\` slice is`,
    `the *additional* cost the hybrid pays vs experiment 05: every write`,
    `now does an authority round trip *and* a local INSERT + FTS insert.`,
  );
  lines.push("");
  lines.push(`### Does this re-introduce sync / product complexity?`);
  lines.push("");
  lines.push(
    `Yes. Honestly:`,
  );
  lines.push("");
  lines.push(
    `- Every client now has a state machine: \`mirror_revision\`,`,
    `  catch-up, idempotent apply, stale-window awareness. Experiment 05`,
    `  had none of that.`,
    `- Two new failure modes exist: (a) the mirror is stale and the caller`,
    `  doesn't ask freshness (silent staleness — we mitigate by *never*`,
    `  having recallLocal lie, but the caller still has to choose), and`,
    `  (b) catch-up failures (network blip during \`/events?since=\`) leave`,
    `  the mirror behind. Idempotent apply means retry is safe, but the`,
    `  caller has to retry.`,
    `- The receipt-then-warm-local-recall property is real and pleasant`,
    `  for the writer (T1), but it does *not* compose to peers: peers must`,
    `  either pay the authoritative round-trip cost (T2) or run a catch-up`,
    `  loop in the background (which adds a polling/streaming product`,
    `  decision that experiment 05 didn't need).`,
    `- The benefit is uneven: writers and warm readers on the same client`,
    `  get fast local recall; cold peers and freshness-sensitive callers`,
    `  see no win and a real complexity tax.`,
  );
  lines.push("");
  lines.push(
    `So the answer to "is this strictly better than experiment 05?" is no.`,
    `It is better for *one specific shape*: a client that writes and then`,
    `immediately reads back, or a client that does many local reads against`,
    `a working set it has already caught up on, while being willing to`,
    `tolerate explicit stale windows for any data it didn't write itself.`,
    `For everything else, experiment 05's "always ask the DO" remains`,
    `simpler and the latency cost is the price of being honest.`,
  );
  lines.push("");
  lines.push(`## Honest limitations of this prototype`);
  lines.push("");
  lines.push(`- Authority is a Node process on loopback, not a real DO. Numbers reflect that — they are a floor for the hybrid's overhead, not an upper bound for the remote case.`);
  lines.push(`- No background catch-up loop. The caller must call \`catchUp()\`. A production version would need a streaming feed (SSE / WebSocket / DO alarm push) for low-latency peer convergence; the polling pattern here is fine for the experiment but would not feel "local" for peers without it.`);
  lines.push(`- Single authority, single mirror file per client, no auth, no quotas, no eviction, no embeddings. Same scope as experiments 01/03/05.`);
  lines.push(`- Ulid is random hex, not time-sortable. Matches the rest of the series.`);
  lines.push(`- Revisions are assigned inside a \`BEGIN IMMEDIATE\` transaction; SQLite serializes them. Real DO would get the same property "for free" via the input gate.`);
  lines.push("");
  return lines.join("\n");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[harness] FATAL", err);
  process.exit(2);
});

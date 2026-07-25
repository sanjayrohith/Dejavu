import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const base = arg("--base", "http://127.0.0.1:8897").replace(/\/$/, "");
const out = arg("--out", "RESULT.md");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function json(method, path, body) {
  const t0 = performance.now();
  const res = await fetch(base + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${JSON.stringify(data)}`);
  return { data, ms: performance.now() - t0 };
}
const includesText = (hits, needle) => hits.some((hit) => hit.text.includes(needle));
const fmt = (n) => `${n.toFixed(2)} ms`;
const line = [];
function section(title) { line.push(`\n## ${title}\n`); }

class CheapClient {
  constructor({ ttlMs = 250, recentsLimit = 8 } = {}) {
    this.ttlMs = ttlMs;
    this.recentsLimit = recentsLimit;
    this.memo = new Map();
    this.recentPrefetch = null;
    this.recentWrites = [];
  }
  now() { return performance.now(); }
  fresh(entry) { return entry && entry.expiresAt > this.now(); }
  localSearch(hits, q) {
    const tokens = q.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
    return hits.filter((hit) => tokens.every((token) => hit.text.toLowerCase().includes(token) || (hit.tags || []).join(" ").toLowerCase().includes(token)));
  }
  async remember(text, tags = []) {
    const remember = await json("POST", "/remember", { text, tags });
    const slip = remember.data.slip;
    this.recentWrites.unshift(slip);
    this.recentWrites = this.recentWrites.slice(0, 8);
    return { ...remember, slip };
  }
  async recallBaseline(q) {
    const result = await json("GET", `/recall?q=${encodeURIComponent(q)}`);
    return { source: "remote", ...result, hits: result.data.hits };
  }
  async recallMemo(q) {
    const key = q.toLowerCase();
    const cached = this.memo.get(key);
    if (this.fresh(cached)) return { source: "memo", ms: 0, hits: cached.hits, age: this.now() - cached.storedAt };
    const remote = await this.recallBaseline(q);
    this.memo.set(key, { hits: remote.hits, storedAt: this.now(), expiresAt: this.now() + this.ttlMs });
    return { ...remote, source: "remote-fill" };
  }
  async prefetchRecents() {
    const result = await json("GET", `/recents?limit=${this.recentsLimit}`);
    this.recentPrefetch = { hits: result.data.hits, storedAt: this.now(), expiresAt: this.now() + this.ttlMs, headSeq: result.data.headSeq };
    return { ...result, hits: result.data.hits };
  }
  recallPrefetchedRecents(q) {
    if (!this.fresh(this.recentPrefetch)) return { source: "prefetch-expired", hits: [], ms: 0, freshness: "expired" };
    return { source: "prefetch", hits: this.localSearch(this.recentPrefetch.hits, q), ms: 0, freshness: "bounded-recents" };
  }
  recallRecentWrites(q) {
    return { source: "recent-write", hits: this.localSearch(this.recentWrites, q), ms: 0, freshness: "own-acked-writes-only" };
  }
}

const c = new CheapClient({ ttlMs: 120, recentsLimit: 8 });
const checks = [];
const ok = (name, value) => checks.push([name, !!value]);
const health = await json("GET", "/health");

// Seed durable truth.
await c.remember("Decision: alpha recall should stay visible", ["alpha"]);
await c.remember("Handoff: beta work is ready", ["beta", "handoff"]);
await c.remember("Preference: gamma summaries should be terse", ["gamma"]);

section("T1 — baseline remote recall cost");
const baseline = await c.recallBaseline("alpha recall");
ok("baseline finds alpha", includesText(baseline.hits, "alpha"));
line.push(`- source: ${baseline.source}`);
line.push(`- latency: ${fmt(baseline.ms)}`);
line.push(`- hits: ${baseline.hits.length}`);
line.push(`- PASS: ${includesText(baseline.hits, "alpha")}`);

section("T2 — exact query memoization helps repeats, TTL expiry falls back honestly");
const memoFill = await c.recallMemo("gamma summaries");
const memoHit = await c.recallMemo("gamma summaries");
await sleep(150);
const memoExpired = await c.recallMemo("gamma summaries");
ok("memo first fill remote", memoFill.source === "remote-fill");
ok("memo repeat local", memoHit.source === "memo" && includesText(memoHit.hits, "gamma"));
ok("memo expired refetches remote", memoExpired.source === "remote-fill");
line.push(`- first recall: ${memoFill.source}, ${fmt(memoFill.ms)}`);
line.push(`- repeated recall: ${memoHit.source}, effectively ~0 client RTT`);
line.push(`- after TTL: ${memoExpired.source}, ${fmt(memoExpired.ms)}`);
line.push(`- PASS: ${memoHit.source === "memo" && memoExpired.source === "remote-fill"}`);

section("T3 — startup recents prefetch answers bounded recent/handoff-like query locally");
const prefetch = await c.prefetchRecents();
const preHit = c.recallPrefetchedRecents("beta work");
const preMiss = c.recallPrefetchedRecents("zeta never cached");
ok("prefetch fetched recent slips", prefetch.hits.length >= 3);
ok("prefetch hits beta", includesText(preHit.hits, "beta"));
ok("prefetch miss stays miss", preMiss.hits.length === 0);
line.push(`- startup prefetch latency: ${fmt(prefetch.ms)} (can be hidden at session boot)`);
line.push(`- beta local hits: ${preHit.hits.length}, freshness=${preHit.freshness}`);
line.push(`- out-of-cache query hits: ${preMiss.hits.length}; client must authority-fallback for completeness`);
line.push(`- PASS: ${includesText(preHit.hits, "beta") && preMiss.hits.length === 0}`);

section("T4 — just-written read-after-write cache avoids second recall RTT, without claiming peer freshness");
const write = await c.remember("Just wrote delta receipt memory", ["delta"]);
const recentHit = c.recallRecentWrites("delta receipt");
const authorityDelta = await c.recallBaseline("delta receipt");
ok("write committed", write.data.receipt.committed);
ok("recent write cache hits", includesText(recentHit.hits, "delta"));
ok("authority also hits delta", includesText(authorityDelta.hits, "delta"));
line.push(`- authority remember receipt latency: ${fmt(write.ms)}`);
line.push(`- local recent-write read: ${recentHit.hits.length} hit(s), effectively ~0 client RTT`);
line.push(`- authoritative recall would have cost: ${fmt(authorityDelta.ms)}`);
line.push(`- cache scope: ${recentHit.freshness}`);
line.push(`- PASS: ${includesText(recentHit.hits, "delta") && includesText(authorityDelta.hits, "delta")}`);

section("T5 — cache staleness is real: another writer invalidates truth but memo does not know");
const staleClient = new CheapClient({ ttlMs: 400, recentsLimit: 8 });
const staleFill = await staleClient.recallMemo("omega peer"); // empty result cached
const peerWrite = await c.remember("Peer later writes omega peer fact", ["omega"]);
const staleMemo = await staleClient.recallMemo("omega peer");
const truthOmega = await staleClient.recallBaseline("omega peer");
ok("stale memo remains cached empty", staleMemo.source === "memo" && staleMemo.hits.length === 0);
ok("authority truth sees peer write", includesText(truthOmega.hits, "omega"));
line.push(`- initial empty memo fill: ${staleFill.source}, ${fmt(staleFill.ms)}`);
line.push(`- peer write latency: ${fmt(peerWrite.ms)}`);
line.push(`- cached repeat before TTL: source=${staleMemo.source}, hits=${staleMemo.hits.length} (stale)`);
line.push(`- authority truth: hits=${truthOmega.hits.length}, ${fmt(truthOmega.ms)}`);
line.push(`- PASS (staleness detected by experiment): ${staleMemo.hits.length === 0 && includesText(truthOmega.hits, "omega")}`);

section("Conclusion");
const pass = checks.every(([, value]) => value);
line.push(`- checks: ${checks.map(([name, value]) => `${value ? "✅" : "❌"} ${name}`).join("; ")}`);
line.push(`- verdict: **${pass ? "PASS" : "FAIL"}**`);
line.push("");
line.push("Cheap local-feel tricks do help, but only in bounded places:");
line.push("- repeated identical recalls become instant until TTL; startup recents can hide one remote RTT; read-after-write for this client's own committed writes can avoid a second remote recall.");
line.push("- none of these caches are complete shared memory. Peer writes make memoized negatives stale until TTL/invalidation. Prefetched recents only answer within their bounded window.");
line.push("- recommendation: use these as UX optimizations around a DO authority, not as a consistency substrate. If product demands fresh arbitrary cross-agent recalls at local speed, these do not replace experiment 06's mirror/stream complexity.");

const header = [`# Experiment 07 — RESULT`, "", `- base: \`${base}\``, `- authority simulated delays: remember=${health.data.rememberMs}ms recall=${health.data.recallMs}ms`, `- final authority count: ${(await json("GET", "/health")).data.count}`, ""];
writeFileSync(out, header.concat(line).join("\n") + "\n");
console.log(`wrote ${out} verdict=${pass ? "PASS" : "FAIL"}`);
if (!pass) process.exitCode = 1;

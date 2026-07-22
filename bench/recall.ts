#!/usr/bin/env bun
/**
 * Recall benchmark.
 *
 * Plants a corpus of slips, runs queries against it, measures how often
 * the "right" slip appears in the top-1 / top-3 hits. Run after any
 * change to the tokenizer, FTS query construction, or trust thresholds.
 *
 *   bun run bench/recall.ts
 *
 * Cases come in two flavors:
 *   - direct: query shares vocabulary with the target slip
 *   - oblique: query is paraphrased — tests stemming / token coverage
 *
 * A passing benchmark means: when an agent asks the natural question,
 * dejavu surfaces the slip the user actually wrote down.
 */

import { Dejavu } from "../src/index.ts";

interface Case {
  /** Human label for the report. */
  label: string;
  /** "direct" = vocabulary overlap; "oblique" = paraphrased. */
  kind: "direct" | "oblique";
  /** What the user/agent jotted in a previous session. */
  slip: { text: string; tags?: string[] };
  /** What a future agent might naturally ask. */
  query: string;
  /** Decoy slips to plant alongside; the right answer must outrank them. */
  decoys?: string[];
}

const CASES: Case[] = [
  {
    label: "preference: test runner",
    kind: "oblique",
    slip: { text: "The user prefers vitest over jest. Migrated all repos in early 2026.", tags: ["preference", "testing"] },
    query: "preferred test runner",
    decoys: ["The user runs macOS with zsh as their default shell."],
  },
  {
    label: "decision: deployment",
    kind: "oblique",
    slip: { text: "Decision: deploy via wrangler tail-then-promote, NOT blue-green. Blue-green added too much config surface for the team size.", tags: ["decision", "deployment"] },
    query: "deployment strategy",
    decoys: ["The repo uses bun for tests and TypeScript strict mode."],
  },
  {
    label: "naming: pronunciation",
    kind: "direct",
    slip: { text: 'User pronounces it "DAY-zha", not "DEH-ja". Came up while naming the project.', tags: ["preference", "naming"] },
    query: "how to pronounce dejavu",
    decoys: ["User runs macOS, uses zsh."],
  },
  {
    label: "architecture: storage backend",
    kind: "direct",
    slip: { text: "dejavu v0.0.2 uses bun:sqlite + FTS5. No hosted Worker. Local-only.", tags: ["architecture", "dejavu"] },
    query: "what does dejavu use for storage",
    decoys: ["Cloudflare DurableObjects use SQLite under the hood."],
  },
  {
    label: "gotcha: bm25 sign",
    kind: "oblique",
    slip: { text: "Sharp edge: bun:sqlite returns NEGATIVE bm25 scores. Lower is better. Trust thresholds in lifecycle.ts depend on this.", tags: ["gotcha", "dejavu"] },
    query: "ranking score sign",
    decoys: ["Use FTS5 porter tokenizer for stemming."],
  },
  {
    label: "fact: durable object",
    kind: "direct",
    slip: { text: "DurableObject SQLite storage gives strongly-consistent transactional writes per object instance.", tags: ["cloudflare", "fact"] },
    query: "DurableObject storage consistency",
    decoys: ["dejavu uses bun:sqlite locally."],
  },
  {
    label: "env: shell",
    kind: "oblique",
    slip: { text: "User runs macOS, uses zsh, default shell config in ~/.zshrc.", tags: ["env"] },
    query: "what shell does the user use",
    decoys: ["User prefers vitest over jest."],
  },
  {
    label: "decoy: nothing relevant",
    kind: "oblique",
    slip: { text: "Sharp edge: bun:sqlite returns NEGATIVE bm25 scores.", tags: ["gotcha"] },
    query: "what is the capital of france",
    decoys: ["User prefers vitest over jest.", "Deploy via wrangler tail-then-promote."],
  },
];

interface CaseResult {
  label: string;
  kind: Case["kind"];
  query: string;
  topIsTarget: boolean;
  targetInTop3: boolean;
  topTrust: string;
  hitCount: number;
}

function runCase(c: Case): CaseResult {
  const d = new Dejavu({ path: ":memory:", skipGc: true });
  const target = d.remember(c.slip.text, { tags: c.slip.tags });
  d.keep([target.id]);
  for (const decoy of c.decoys ?? []) {
    const ds = d.remember(decoy);
    d.keep([ds.id]);
  }

  const r = d.recall(c.query, 5);
  const hits = r.hits;
  const topIsTarget = hits[0]?.slip.id === target.id;
  const targetInTop3 = hits.slice(0, 3).some((h) => h.slip.id === target.id);
  const topTrust = hits[0]?.trust ?? "(no hit)";

  // For the decoy case, "passing" means the target should NOT be the
  // top hit (or there should be no high/medium-trust hits at all).
  const isDecoyCase = c.label.startsWith("decoy:");
  const actualTopIsTarget = isDecoyCase ? !topIsTarget : topIsTarget;
  const actualTargetInTop3 = isDecoyCase ? !targetInTop3 : targetInTop3;

  d.close();
  return {
    label: c.label,
    kind: c.kind,
    query: c.query,
    topIsTarget: actualTopIsTarget,
    targetInTop3: actualTargetInTop3,
    topTrust,
    hitCount: hits.length,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

const results = CASES.map(runCase);

console.log("\n=== dejavu recall benchmark ===\n");
console.log(
  pad("case", 32) +
    pad("kind", 9) +
    pad("query", 36) +
    pad("top1", 6) +
    pad("top3", 6) +
    pad("trust", 8) +
    "hits",
);
console.log("-".repeat(100));
for (const r of results) {
  console.log(
    pad(r.label, 32) +
      pad(r.kind, 9) +
      pad(r.query, 36) +
      pad(r.topIsTarget ? "✓" : "✗", 6) +
      pad(r.targetInTop3 ? "✓" : "✗", 6) +
      pad(r.topTrust, 8) +
      String(r.hitCount),
  );
}

const r1 = results.filter((r) => r.topIsTarget).length;
const r3 = results.filter((r) => r.targetInTop3).length;
const total = results.length;
console.log("-".repeat(100));
console.log(
  `recall@1: ${r1}/${total} (${((100 * r1) / total).toFixed(0)}%)   recall@3: ${r3}/${total} (${((100 * r3) / total).toFixed(0)}%)`,
);
console.log();

// Exit non-zero if recall@1 drops below 70% — protects future changes.
const PASS_THRESHOLD = 0.7;
if (r1 / total < PASS_THRESHOLD) {
  console.error(`FAIL: recall@1 ${((100 * r1) / total).toFixed(0)}% < ${PASS_THRESHOLD * 100}% threshold`);
  process.exit(1);
}

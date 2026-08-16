#!/usr/bin/env bun
/**
 * Anchor drift overhead benchmark.
 *
 * Drift checking runs on the agent's critical path: every recall that
 * returns anchored memory hashes the anchored files. The release gate
 * says warm local recall stays under 20 ms p95, so the honest question is
 * how much of that budget this feature spends.
 *
 *   bun run bench/anchors.ts
 *
 * Three arms, all against the same planted corpus:
 *   - unanchored: the pre-anchor baseline, and the cost every existing
 *     database pays after upgrading (one indexed query, no rows)
 *   - anchored:   a realistic packet where each hit points at its own file
 *   - shared:     several hits pointing at one file, exercising the cache
 *
 * The corpus is written to a temporary directory and removed afterwards.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dejavu } from "../src/index.ts";

const SLIPS = 8;
const FILE_LINES = 200;
const ITERATIONS = 200;

function plant(distinctFiles: number | null): { root: string; dejavu: Dejavu } {
  const root = mkdtempSync(join(tmpdir(), "dejavu-bench-anchor-"));
  mkdirSync(join(root, "src"), { recursive: true });

  const files = distinctFiles ?? 0;
  for (let i = 0; i < Math.max(files, 1); i += 1) {
    const body = Array.from(
      { length: FILE_LINES },
      (_, line) => `export const value${line} = ${line}; // module ${i}`,
    ).join("\n");
    writeFileSync(join(root, "src", `module${i}.ts`), `${body}\n`);
  }

  const dejavu = new Dejavu({
    path: ":memory:",
    skipGc: true,
    scope: "repo:bench",
    anchorRoot: root,
  });

  for (let i = 0; i < SLIPS; i += 1) {
    const anchors = distinctFiles === null
      ? []
      : [`src/module${i % Math.max(files, 1)}.ts:${(i % FILE_LINES) + 1}`];
    const slip = dejavu.remember(
      `benchmark memory ${i}: the retry budget interacts with the request timeout`,
      { anchors },
    );
    dejavu.keep([slip.id], { noChainRollup: true });
  }
  return { root, dejavu };
}

function measure(label: string, distinctFiles: number | null): { label: string; p50: number; p95: number } {
  const { root, dejavu } = plant(distinctFiles);
  try {
    // Warm the FTS index and the filesystem cache before timing.
    for (let i = 0; i < 20; i += 1) dejavu.recall("retry budget timeout");

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const started = performance.now();
      dejavu.recall("retry budget timeout");
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    return {
      label,
      p50: samples[Math.floor(samples.length * 0.5)] ?? 0,
      p95: samples[Math.floor(samples.length * 0.95)] ?? 0,
    };
  } finally {
    dejavu.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

const results = [
  measure("unanchored (baseline)", null),
  measure(`anchored, ${SLIPS} distinct files`, SLIPS),
  measure("anchored, 1 shared file", 1),
];

console.log("\n=== dejavu anchor drift overhead ===\n");
console.log(`${SLIPS} kept slips per arm · ${FILE_LINES}-line files · ${ITERATIONS} timed recalls\n`);
console.log(pad("arm", 32) + pad("p50 ms", 10) + "p95 ms");
console.log("-".repeat(56));
for (const r of results) {
  console.log(pad(r.label, 32) + pad(r.p50.toFixed(3), 10) + r.p95.toFixed(3));
}

const baseline = results[0]!;
const worst = results.reduce((a, b) => (b.p95 > a.p95 ? b : a));
console.log("-".repeat(56));
console.log(
  `overhead at p95: +${(worst.p95 - baseline.p95).toFixed(3)} ms (${worst.label})`,
);
console.log();

// The release scorecard budgets warm local recall at 20 ms p95. Drift
// checking is one feature inside that budget, so cap it well below.
const BUDGET_MS = 5;
if (worst.p95 - baseline.p95 > BUDGET_MS) {
  console.error(
    `FAIL: drift checking adds ${(worst.p95 - baseline.p95).toFixed(3)} ms at p95, over the ${BUDGET_MS} ms budget`,
  );
  process.exit(1);
}

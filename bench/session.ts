#!/usr/bin/env bun
/**
 * Session hook latency benchmark.
 *
 * Session hooks are not library calls. Claude Code spawns them as
 * processes on the session's critical path and gives session-end hooks a
 * 1.5-second shared budget across every hook registered — so the number
 * that matters is wall-clock for a cold process, including interpreter
 * startup and module loading, not the microseconds the operation itself
 * takes.
 *
 *   bun run bench/session.ts
 *
 * Measured against a planted corpus, spawning the real CLI exactly the
 * way an installed hook does, with the payload on stdin.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dejavu } from "../src/index.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const ITERATIONS = 12;
const CORPUS = 40;

/**
 * Claude Code's documented budget for session-end hooks, shared across
 * every registered hook. Dejavu is one of them, so it should be using a
 * small fraction rather than most of it.
 */
const SESSION_END_BUDGET_MS = 1500;
const SHARE_OF_BUDGET = 0.4;

function plant(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "dejavu-bench-session-"));
  const dbPath = join(root, "dejavu.db");
  const dejavu = new Dejavu({ path: dbPath, skipGc: true, scope: "repo:bench", sessionId: "prior" });
  for (let i = 0; i < CORPUS; i += 1) {
    dejavu.keep([dejavu.remember(`benchmark memory ${i} about the deployment pipeline`).id], {
      noChainRollup: true,
    });
  }
  dejavu.handoff({
    sessionId: "prior-handoff",
    summary: "prior session left the canary half-deployed",
    next: ["verify the canary", "roll forward or back"],
  });
  dejavu.close();
  return { root, dbPath };
}

function run(phase: string, root: string, dbPath: string): number {
  const payload = JSON.stringify({ session_id: "bench-session", cwd: root });
  const started = performance.now();
  const proc = Bun.spawnSync(["bun", "run", CLI, "session", phase, "--harness=bench"], {
    cwd: root,
    stdin: new TextEncoder().encode(payload),
    env: { ...process.env, DEJAVU_DB: dbPath, DEJAVU_SCOPE: "repo:bench" },
  });
  const elapsed = performance.now() - started;
  if (!proc.success) {
    console.error(`FAIL: session ${phase} exited ${proc.exitCode}`);
    console.error(new TextDecoder().decode(proc.stderr));
    process.exit(1);
  }
  return elapsed;
}

function measure(phase: string, root: string, dbPath: string): { phase: string; p50: number; worst: number } {
  run(phase, root, dbPath); // warm the module cache and the page cache
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) samples.push(run(phase, root, dbPath));
  samples.sort((a, b) => a - b);
  return {
    phase,
    p50: samples[Math.floor(samples.length * 0.5)] ?? 0,
    worst: samples.at(-1) ?? 0,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

const { root, dbPath } = plant();
let results: Array<{ phase: string; p50: number; worst: number }> = [];
try {
  results = ["start", "checkpoint", "end"].map((phase) => measure(phase, root, dbPath));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("\n=== dejavu session hook latency ===\n");
console.log(
  `cold process per invocation · ${CORPUS} kept memories · ${ITERATIONS} runs per phase\n`,
);
console.log(pad("phase", 14) + pad("p50 ms", 10) + "worst ms");
console.log("-".repeat(40));
for (const r of results) {
  console.log(pad(r.phase, 14) + pad(r.p50.toFixed(0), 10) + r.worst.toFixed(0));
}

const cap = SESSION_END_BUDGET_MS * SHARE_OF_BUDGET;
const worst = results.reduce((a, b) => (b.worst > a.worst ? b : a));
console.log("-".repeat(40));
console.log(
  `worst: ${worst.worst.toFixed(0)} ms (${worst.phase}) · session-end budget ${SESSION_END_BUDGET_MS} ms shared across all hooks`,
);
console.log();

if (worst.worst > cap) {
  console.error(
    `FAIL: ${worst.phase} took ${worst.worst.toFixed(0)} ms, over the ${cap} ms share of the session-end budget`,
  );
  process.exit(1);
}

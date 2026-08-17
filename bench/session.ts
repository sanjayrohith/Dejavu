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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dejavu } from "../src/index.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const ITERATIONS = 12;
const CORPUS = 40;
/** Files in the planted checkout, half of them left dirty. */
const FILES = 12;
/** How many of the corpus memories are anchored to those files. */
const ANCHORED = 12;

/**
 * Claude Code's documented budget for session-end hooks, shared across
 * every registered hook. Dejavu is one of them, so it should be using a
 * small fraction rather than most of it.
 */
const SESSION_END_BUDGET_MS = 1500;
const SHARE_OF_BUDGET = 0.4;

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "bench",
      GIT_AUTHOR_EMAIL: "bench@example.com",
      GIT_COMMITTER_NAME: "bench",
      GIT_COMMITTER_EMAIL: "bench@example.com",
    },
  });
  if (!result.success) {
    console.error(`FAIL: git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
    process.exit(1);
  }
}

/**
 * A real checkout with a dirty working tree and anchored memory.
 *
 * The start hook now reads the branch, shells out for the diff, and
 * drift-checks whatever memory is anchored to the changed files — so a
 * plain temporary directory would make this benchmark measure the cheap
 * path and report a number that never happens in practice. Half the
 * files are left modified, and a third of the corpus is anchored to
 * them, which is a deliberately unkind ratio.
 */
function plant(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "dejavu-bench-session-"));
  const dbPath = join(root, "dejavu.db");

  mkdirSync(join(root, "src"), { recursive: true });
  for (let i = 0; i < FILES; i += 1) {
    writeFileSync(join(root, "src", `module${i}.ts`), `export const value${i} = ${i};\n`.repeat(40));
  }
  git(root, "init", "--initial-branch=main");
  git(root, "add", ".");
  git(root, "commit", "-m", "planted corpus");

  const dejavu = new Dejavu({
    path: dbPath,
    skipGc: true,
    scope: "repo:bench",
    sessionId: "prior",
    anchorRoot: root,
  });
  for (let i = 0; i < CORPUS; i += 1) {
    const anchors = i < ANCHORED ? [`src/module${i % FILES}.ts`] : undefined;
    dejavu.keep([
      dejavu.remember(`benchmark memory ${i} about the deployment pipeline`, { anchors }).id,
    ], { noChainRollup: true });
  }
  dejavu.handoff({
    sessionId: "prior-handoff",
    summary: "prior session left the canary half-deployed",
    next: ["verify the canary", "roll forward or back"],
  });
  dejavu.close();

  // Dirty half the tree, after capture, so the anchors actually drift.
  for (let i = 0; i < FILES / 2; i += 1) {
    writeFileSync(join(root, "src", `module${i}.ts`), `export const value${i} = ${i + 1};\n`.repeat(41));
  }
  return { root, dbPath };
}

function run(phase: string, root: string, dbPath: string, flags: string[] = []): number {
  const payload = JSON.stringify({ session_id: "bench-session", cwd: root });
  const started = performance.now();
  const proc = Bun.spawnSync(["bun", "run", CLI, "session", phase, "--harness=bench", ...flags], {
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

/**
 * Prove the fixture still exercises the expensive path before timing it.
 *
 * A benchmark that quietly stops measuring the thing it claims to
 * measure is worse than no benchmark: it keeps publishing a
 * reassuring number. If the planted checkout ever stops producing
 * hazards — a broken fixture, a changed default, git unavailable —
 * this fails instead of reporting the cheap path as the real cost.
 */
function verifyFixture(root: string, dbPath: string): void {
  const payload = JSON.stringify({ session_id: "bench-session", cwd: root });
  const proc = Bun.spawnSync(["bun", "run", CLI, "session", "start", "--harness=bench"], {
    cwd: root,
    stdin: new TextEncoder().encode(payload),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DEJAVU_DB: dbPath, DEJAVU_SCOPE: "repo:bench" },
  });
  const out = new TextDecoder().decode(proc.stdout);
  for (const expected of ["# hazards", "CODE CHANGED", "changed file(s)"]) {
    if (!out.includes(expected)) {
      console.error(`FAIL: the planted fixture no longer produces "${expected}" at session start.`);
      console.error(out.slice(0, 800) || new TextDecoder().decode(proc.stderr));
      process.exit(1);
    }
  }
}

function measure(
  phase: string,
  root: string,
  dbPath: string,
  flags: string[] = [],
  label = phase,
): { phase: string; p50: number; worst: number } {
  run(phase, root, dbPath, flags); // warm the module cache and the page cache
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) samples.push(run(phase, root, dbPath, flags));
  samples.sort((a, b) => a - b);
  return {
    phase: label,
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
  verifyFixture(root, dbPath);
  results = [
    // Control arm first: the same start hook with the working-tree read
    // switched off. Cross-machine comparison against a previously
    // recorded run proves nothing, so the cost of reading the tree is
    // measured against itself, here, on whatever box this is.
    measure("start", root, dbPath, ["--no-worktree"], "start (no tree)"),
    measure("start", root, dbPath),
    measure("checkpoint", root, dbPath),
    measure("end", root, dbPath),
  ];
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("\n=== dejavu session hook latency ===\n");
console.log(
  `cold process per invocation · ${CORPUS} kept memories · ${ANCHORED} anchored · ` +
    `${FILES} files, ${FILES / 2} dirty · ${ITERATIONS} runs per phase\n`,
);
console.log(pad("phase", 18) + pad("p50 ms", 10) + "worst ms");
console.log("-".repeat(44));
for (const r of results) {
  console.log(pad(r.phase, 18) + pad(r.p50.toFixed(0), 10) + r.worst.toFixed(0));
}

const cap = SESSION_END_BUDGET_MS * SHARE_OF_BUDGET;
const worst = results.reduce((a, b) => (b.worst > a.worst ? b : a));
const control = results.find((r) => r.phase === "start (no tree)");
const withTree = results.find((r) => r.phase === "start");
console.log("-".repeat(44));
if (control && withTree) {
  // Signed, because run-to-run noise on a small delta genuinely produces
  // negatives and "+-1 ms" reads like a bug in the benchmark.
  const signed = (value: number) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(0)}`;
  console.log(
    `working-tree read: ${signed(withTree.p50 - control.p50)} ms p50, ` +
      `${signed(withTree.worst - control.worst)} ms worst`,
  );
}
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

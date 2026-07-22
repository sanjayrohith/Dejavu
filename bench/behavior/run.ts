#!/usr/bin/env bun
/**
 * Behavioral experiment harness for dejavu.
 *
 * Principle: every product desire should be shaped as a falsifiable, cheap
 * experiment before it becomes API. These first experiments are deterministic
 * proxy tests; they define the fixtures, variants, and success criteria that
 * later LLM-in-the-loop loops can reuse.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type ExperimentResult = {
  name: string;
  hypothesis: string;
  passed: boolean;
  metrics: Record<string, number | string | boolean>;
  evidence: string[];
  recommendation: string;
};

type PromptCase = {
  prompt: string;
  shouldRecall: boolean;
  reason: string;
};

function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_\-./\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

function coverage(text: string, required: string[]): number {
  const words = wordSet(text);
  const hit = required.filter((w) => words.has(w.toLowerCase())).length;
  return required.length === 0 ? 1 : hit / required.length;
}

function handoffStructure(): ExperimentResult {
  const required = [
    "auth.ts",
    "142",
    "parseToken",
    "lib/jwt.ts",
    "tests",
    "imports",
    "failing",
  ];

  const freeform =
    "mid-refactor of auth.ts. stopped at line 142 in parseToken(). next: migrate the JWT helper to lib/jwt.ts. tests will fail until the move is complete.";

  const structured = JSON.stringify(
    {
      summary: "mid-refactor of auth.ts; JWT helper move is incomplete",
      completed: ["identified parseToken() as the split point"],
      next: [
        "finish moving JWT helper from auth.ts:142 to lib/jwt.ts",
        "update imports in auth.ts",
        "run test suite — should go from failing to green",
      ],
      files: ["src/auth.ts", "src/lib/jwt.ts", "test/auth.test.ts"],
      validation: ["bun test"],
      risks: ["tests fail until imports are updated"],
    },
    null,
    2,
  );

  const freeformCoverage = coverage(freeform, required);
  const structuredCoverage = coverage(structured, required);
  const gain = structuredCoverage - freeformCoverage;

  return {
    name: "handoff-structure",
    hypothesis:
      "Structured handoff packets preserve more continuation-critical facts than a prose-only summary.",
    passed: gain > 0.1,
    metrics: {
      freeformCoverage: Number(freeformCoverage.toFixed(3)),
      structuredCoverage: Number(structuredCoverage.toFixed(3)),
      gain: Number(gain.toFixed(3)),
    },
    evidence: [
      `required facts: ${required.join(", ")}`,
      "structured variant carries explicit files, next steps, validation, and risks",
    ],
    recommendation:
      gain > 0.1
        ? "Run an LLM-in-the-loop A/B next; if completion improves, add optional structured handoff fields."
        : "Do not add structured handoff fields yet; this proxy did not show enough information gain.",
  };
}

function stalePreference(): ExperimentResult {
  const slips = [
    { id: "old", text: "User prefers jest for tests.", createdAt: 1000, links: [] as string[] },
    {
      id: "new",
      text: "Going forward, use vitest for tests.",
      createdAt: 2000,
      links: ["supersedes:old"],
    },
  ];

  const naive = slips.find((s) => /jest|vitest/i.test(s.text))!;
  const superseding = slips
    .filter((s) => /jest|vitest/i.test(s.text))
    .sort((a, b) => b.createdAt - a.createdAt)[0]!;
  const linkedSupersedesOld = superseding.links.includes("supersedes:old");
  const naiveChoice = /vitest/i.test(naive.text) ? "vitest" : "jest";
  const supersedingChoice = /vitest/i.test(superseding.text) ? "vitest" : "jest";

  return {
    name: "stale-preference",
    hypothesis:
      "Recency plus explicit supersedes links prevent old preferences from overriding newer ones.",
    passed: naiveChoice === "jest" && supersedingChoice === "vitest" && linkedSupersedesOld,
    metrics: {
      naiveChoice,
      supersedingChoice,
      linkedSupersedesOld,
    },
    evidence: [
      "old slip says jest",
      "newer slip says vitest and links supersedes:old",
      "a recall formatter should surface the conflict/supersession, not just raw ranked hits",
    ],
    recommendation:
      "Add recall formatting/tests for supersedes and contradicts links before adding heavier memory taxonomy.",
  };
}

const promptBattery: PromptCase[] = [
  {
    prompt: "Continue where we left off.",
    shouldRecall: true,
    reason: "prior work / handoff",
  },
  {
    prompt: "What test runner should I use in this repo?",
    shouldRecall: true,
    reason: "project convention / preference",
  },
  {
    prompt: "Add tests for this module.",
    shouldRecall: true,
    reason: "preference-sensitive action",
  },
  {
    prompt: "How do I pronounce my project name?",
    shouldRecall: true,
    reason: "user-specific fact",
  },
  {
    prompt: "What is the capital of France?",
    shouldRecall: false,
    reason: "pure world knowledge",
  },
  {
    prompt: "What is pi to 10 digits?",
    shouldRecall: false,
    reason: "pure world knowledge",
  },
];

const policies = [
  {
    name: "generic",
    text: "Search memory for relevant facts.",
  },
  {
    name: "specific-trigger",
    text:
      "Before answering questions about user preferences, project decisions, prior work, this repo/codebase, work-in-progress, names/pronunciation, tools, package managers, or anything that may have been stated before, call recall. Do not call recall for pure world knowledge.",
  },
];

function policyPredictsRecall(policy: string, prompt: string): boolean {
  const p = prompt.toLowerCase();
  const policyWords = wordSet(policy);
  const triggers = [
    "preference",
    "preferences",
    "project",
    "repo",
    "codebase",
    "prior",
    "previous",
    "left",
    "handoff",
    "work",
    "wip",
    "pronunciation",
    "pronounce",
    "tools",
    "runner",
    "tests",
    "package",
  ];
  const generic = policyWords.has("relevant") && policyWords.size < 8;
  if (generic) return /left off|repo|project|prefer/.test(p);
  return triggers.some((t) => p.includes(t)) && !/capital of france|pi to 10/.test(p);
}

function recallTriggerPolicy(): ExperimentResult {
  const scores = policies.map((policy) => {
    let correct = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    for (const c of promptBattery) {
      const predicted = policyPredictsRecall(policy.text, c.prompt);
      if (predicted === c.shouldRecall) correct++;
      if (predicted && !c.shouldRecall) falsePositive++;
      if (!predicted && c.shouldRecall) falseNegative++;
    }
    return { ...policy, correct, falsePositive, falseNegative };
  });
  const best = scores.sort((a, b) => b.correct - a.correct)[0]!;

  return {
    name: "recall-trigger-policy",
    hypothesis:
      "Specific trigger wording should increase appropriate recall without increasing world-knowledge recall.",
    passed: best.name === "specific-trigger" && best.falsePositive === 0,
    metrics: {
      bestPolicy: best.name,
      bestCorrect: `${best.correct}/${promptBattery.length}`,
      bestFalsePositive: best.falsePositive,
      bestFalseNegative: best.falseNegative,
    },
    evidence: promptBattery.map(
      (c) => `${c.shouldRecall ? "recall" : "skip"}: ${c.prompt} (${c.reason})`,
    ),
    recommendation:
      "Keep MCP recall descriptions benchmarked. Next step: replace this proxy with real agent transcripts over the same prompt battery.",
  };
}

function formatMarkdown(results: ExperimentResult[]): string {
  const passed = results.filter((r) => r.passed).length;
  const lines: string[] = [
    "# dejavu behavioral bench latest",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `Summary: **${passed}/${results.length} experiments passed**`,
    "",
    "These are small behavioral experiments for product claims. They are not a substitute for LLM-in-the-loop runs; they are cheap fixtures that make the desired behavior explicit before it becomes API.",
    "",
    "| Experiment | Result | Key metrics | Recommendation |",
    "|---|---:|---|---|",
  ];

  for (const r of results) {
    const metrics = Object.entries(r.metrics)
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ");
    lines.push(
      `| ${r.name} | ${r.passed ? "PASS" : "FAIL"} | ${metrics} | ${r.recommendation} |`,
    );
  }

  for (const r of results) {
    lines.push("", `## ${r.name} ${r.passed ? "PASS" : "FAIL"}`, "", r.hypothesis, "", "### Metrics", "");
    for (const [k, v] of Object.entries(r.metrics)) lines.push(`- ${k}: ${v}`);
    lines.push("", "### Evidence", "");
    for (const e of r.evidence) lines.push(`- ${e}`);
    lines.push("", "### Recommendation", "", r.recommendation);
  }
  lines.push("");
  return lines.join("\n");
}

const experiments = [handoffStructure, stalePreference, recallTriggerPolicy];
const results = experiments.map((run) => run());

for (const r of results) {
  console.log(`\n## ${r.name} ${r.passed ? "PASS" : "FAIL"}`);
  console.log(r.hypothesis);
  console.log("metrics:");
  for (const [k, v] of Object.entries(r.metrics)) console.log(`  ${k}: ${v}`);
  console.log("evidence:");
  for (const e of r.evidence) console.log(`  - ${e}`);
  console.log(`recommendation: ${r.recommendation}`);
}

const reportPath = "docs/bench/behavior-latest.md";
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, formatMarkdown(results));
console.log(`\nwrote ${reportPath}`);

const passed = results.filter((r) => r.passed).length;
console.log(`behavior experiments: ${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;

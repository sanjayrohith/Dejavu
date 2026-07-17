import type { NextAgentHit, NextAgentHint, NextAgentPenalty, NextAgentRead, NextAgentReason, RecallHit } from "./types.ts";

export interface RankForNextAgentOptions {
  maxReadFirst?: number;
  minReadFirstScore?: number;
}

const DEFAULT_MAX_READ_FIRST = 5;
const DEFAULT_MIN_READ_FIRST_SCORE = 3;

export function rankForNextAgent(
  query: string,
  hits: RecallHit[],
  options: RankForNextAgentOptions = {}
): { hits: NextAgentHit[]; readFirst: NextAgentHit[] } {
  const seen = new Set<string>();
  const ranked = hits.map((hit) => {
    const normalized = normalize(hit.slip.text);
    const hint = hintFor(query, hit, seen.has(normalized));
    seen.add(normalized);
    return { ...hit, nextAgent: hint };
  });

  const minScore = options.minReadFirstScore ?? DEFAULT_MIN_READ_FIRST_SCORE;
  const max = options.maxReadFirst ?? DEFAULT_MAX_READ_FIRST;
  const readFirst = [...ranked]
    .filter((hit) => hit.nextAgent.read === "first" && hit.nextAgent.score >= minScore)
    .sort((a, b) => b.nextAgent.score - a.nextAgent.score || a.score - b.score)
    .slice(0, max);

  return { hits: ranked, readFirst };
}

export function hintFor(query: string, hit: RecallHit, duplicate = false): NextAgentHint {
  const text = hit.slip.text;
  const reasons = reasonsFor(query, text);
  const penalties = penaltiesFor(text, duplicate);
  const score = scoreHint(reasons, penalties, hit.trust);
  return { read: readFor(score), score, reasons, penalties };
}

function reasonsFor(query: string, text: string): NextAgentReason[] {
  const t = text.toLowerCase();
  const reasons: NextAgentReason[] = [];
  if (queryMatch(query, text)) reasons.push("query_match");
  if (/\bpreference\b/.test(t)) reasons.push("explicit_preference");
  if (/\bdecision\b|\bnew decision\b/.test(t)) reasons.push("decision");
  if (/\bsecurity invariant\b|\baccess before\b|\bsecret-before-code\b|\bsecrets before code\b/.test(t)) reasons.push("security_invariant");
  if (/\bincident\b|\bbroke\b|\boutage\b|\brepro\b/.test(t)) reasons.push("incident");
  if (/\bwip\b|\bcurrent\b|\bnext\b/.test(t)) reasons.push("current_wip");
  if (/\bfinding\b|\bhypothesis\b|\bobservation\b|\bconfirmed\b/.test(t)) reasons.push("finding");
  if (/\brequirement\b|\buser requirement\b/.test(t)) reasons.push("requirement");
  if (/\brelease gate\b|\brelease bar\b/.test(t)) reasons.push("release_gate");
  return reasons;
}

function penaltiesFor(text: string, duplicate: boolean): NextAgentPenalty[] {
  const t = text.toLowerCase();
  const penalties: NextAgentPenalty[] = [];
  if (/\bold plan\b|\bsuggestion\b|\bstale\b|\bsuperseded\b/.test(t)) penalties.push("stale_plan");
  if (/\bold assumption\b/.test(t)) penalties.push("stale_assumption");
  if (/\brandom\b|\blunch\b|\btacos\b|\bcoffee\b/.test(t)) penalties.push("random_note");
  if (/\broutine\b|\bdocs note\b|\breadme wording\b/.test(t)) penalties.push("routine_note");
  if (duplicate) penalties.push("duplicate");
  return penalties;
}

function scoreHint(reasons: NextAgentReason[], penalties: NextAgentPenalty[], trust: RecallHit["trust"]): number {
  let score = trust === "high" ? 1 : trust === "medium" ? 0.5 : 0;
  for (const reason of reasons) {
    if (reason === "query_match") score += 2;
    else if (reason === "security_invariant") score += 5;
    else if (reason === "explicit_preference" || reason === "decision" || reason === "incident") score += 4;
    else if (reason === "requirement" || reason === "release_gate") score += 3;
    else score += 2;
  }
  for (const penalty of penalties) {
    if (penalty === "stale_plan" || penalty === "stale_assumption") score -= 6;
    else if (penalty === "random_note") score -= 4;
    else if (penalty === "routine_note") score -= 3;
    else score -= 1;
  }
  return score;
}

function readFor(score: number): NextAgentRead {
  if (score >= DEFAULT_MIN_READ_FIRST_SCORE) return "first";
  if (score >= 1) return "maybe";
  return "skip";
}

function queryMatch(query: string, text: string): boolean {
  const queryTokens = tokenSet(query);
  if (queryTokens.size === 0) return false;
  const textTokens = tokenSet(text);
  let matches = 0;
  for (const token of queryTokens) if (textTokens.has(token)) matches += 1;
  return matches / queryTokens.size >= 0.34;
}

function tokenSet(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
  );
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s_-]/g, " ").replace(/\s+/g, " ").trim();
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "what",
  "were",
  "was",
  "are",
  "you",
  "use",
  "uses",
  "using",
  "next",
  "agent",
  "agents",
  "should",
  "before",
  "after"
]);

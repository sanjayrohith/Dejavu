import type { Candidate, EvalSlip } from "./types.ts";

type Reason = "preference" | "decision" | "security" | "incident" | "wip" | "finding" | "requirement" | "release_gate";
type Penalty = "stale" | "random" | "routine" | "duplicate";

export interface Hint { score: number; read: "skip" | "maybe" | "first"; reasons: Reason[]; penalties: Penalty[]; }

export function reasons(text: string): Reason[] {
  const t = text.toLowerCase(); const out: Reason[] = [];
  if (/\bpreference\b/.test(t)) out.push("preference");
  if (/\bdecision\b|\bnew decision\b/.test(t)) out.push("decision");
  if (/\bsecurity invariant\b|\baccess before\b|\bsecret\b/.test(t)) out.push("security");
  if (/\bincident\b|\bbroke\b|\boutage\b/.test(t)) out.push("incident");
  if (/\bwip\b|\bcurrent\b|\bnext\b/.test(t)) out.push("wip");
  if (/\bfinding\b|\bhypothesis\b|\bobservation\b/.test(t)) out.push("finding");
  if (/\brequirement\b|\buser requirement\b/.test(t)) out.push("requirement");
  if (/\brelease gate\b|\brelease bar\b/.test(t)) out.push("release_gate");
  return out;
}

export function penalties(text: string, duplicate: boolean): Penalty[] {
  const t = text.toLowerCase(); const out: Penalty[] = [];
  if (/\bold assumption\b|\bold plan\b|\bsuggestion\b|\bstale\b|\bsuperseded\b/.test(t)) out.push("stale");
  if (/\brandom\b|\blunch\b|\bcoffee\b|\btacos\b/.test(t)) out.push("random");
  if (/\broutine\b|\bdocs note\b|\breadme wording\b/.test(t)) out.push("routine");
  if (duplicate) out.push("duplicate");
  return out;
}

function norm(text: string) { return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(); }
function tokens(text: string) { return new Set(norm(text).split(" ").filter(Boolean)); }
function jaccard(a: string, b: string) { const A=tokens(a), B=tokens(b); let hit=0; for (const x of A) if (B.has(x)) hit++; return hit / Math.max(1, new Set([...A,...B]).size); }
function diffBoost(slip: EvalSlip, prior: EvalSlip[]) { if (!prior.length) return 0; const sim = Math.max(...prior.map(p => jaccard(slip.text, p.text))); const diff = 1 - sim; return diff > .78 ? 1 : diff > .55 ? .5 : 0; }

export function hintFor(slip: EvalSlip, prior: EvalSlip[]): Hint {
  const seen = new Set(prior.map(p => norm(p.text))).has(norm(slip.text));
  const rs = reasons(slip.text); const ps = penalties(slip.text, seen);
  let score = diffBoost(slip, prior);
  for (const r of rs) score += r === "security" ? 5 : ["preference","decision","incident"].includes(r) ? 4 : ["requirement","release_gate"].includes(r) ? 3 : 2;
  for (const p of ps) score -= p === "stale" ? 6 : p === "random" ? 4 : p === "routine" ? 3 : 1;
  return { score, read: score >= 4 ? "first" : score >= 1 ? "maybe" : "skip", reasons: rs, penalties: ps };
}

export function rank(slips: EvalSlip[], candidate: Candidate, query = ""): EvalSlip[] {
  if (candidate === "full_raw" || candidate === "full_ranked") return slips;
  if (candidate === "current") return [...slips].sort((a,b) => jaccard(b.text, query) - jaccard(a.text, query));
  if (candidate === "rules") return [...slips].sort((a,b) => ruleScore(b) - ruleScore(a));
  const prior: EvalSlip[] = [];
  const rows = slips.map(s => { const h = hintFor(s, prior); prior.push(s); return { s, h }; });
  return rows.sort((a,b) => b.h.score - a.h.score).map(r => r.s);
}

export function ruleScore(slip: EvalSlip): number {
  return reasons(slip.text).reduce((sum, r) => sum + (r === "security" ? 5 : ["preference","decision","incident"].includes(r) ? 4 : ["requirement","release_gate"].includes(r) ? 3 : 2), 0) - penalties(slip.text, false).reduce((sum,p)=>sum+(p==="stale"?6:p==="random"?4:p==="routine"?3:1),0);
}

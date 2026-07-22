import { mkdirSync, writeFileSync } from "node:fs";
import { datasets } from "./datasets/index.ts";
import { hintFor, rank, ruleScore } from "./candidates.ts";
for (const d of datasets) {
  mkdirSync(`eval/next-agent/prompts-cutoff/${d.id}`, { recursive: true });
  for (const cond of ["rules_cutoff", "ranker_cutoff"] as const) {
    const ranked = rank(d.slips, cond === "rules_cutoff" ? "rules" : "ranker", d.query);
    const rows = ranked.filter(s => cond === "rules_cutoff" ? ruleScore(s) > 0 : hintFor(s, []).score >= 1).slice(0, 12);
    const prior: typeof d.slips = [];
    const lines = rows.map(s => {
      if (cond === "rules_cutoff") return `${s.id}: ${s.text}`;
      const h = hintFor(s, prior); prior.push(s);
      return `${s.id} [read ${h.read} score ${h.score} reasons ${h.reasons.join("+")||"none"} penalties ${h.penalties.join("+")||"none"}]: ${s.text}`;
    });
    writeFileSync(`eval/next-agent/prompts-cutoff/${d.id}/${cond}.txt`, `You are a fresh coding agent using Dejavu memory. ${d.task}\nPick every slip the next agent should read first. Return only comma-separated IDs. It is OK to return fewer than 8 IDs.\n\nSLIPS:\n${lines.join("\n")}\n`);
  }
}

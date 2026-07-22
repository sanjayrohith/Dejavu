import { mkdirSync, writeFileSync } from "node:fs";
import { datasets } from "./datasets/index.ts";
import { hintFor, rank } from "./candidates.ts";
import type { Candidate, EvalSlip } from "./types.ts";
const conditions: Candidate[] = ["full_raw","full_ranked","current","rules","ranker"];
for (const d of datasets) {
  mkdirSync(`eval/next-agent/prompts/${d.id}`, { recursive: true });
  for (const c of conditions) {
    const rows = c === "full_raw" || c === "full_ranked" ? d.slips : rank(d.slips, c, d.query).slice(0, Math.min(25, d.slips.length));
    const prior: EvalSlip[] = [];
    const lines = rows.map(s => {
      if (c !== "full_ranked" && c !== "ranker") return `${s.id}: ${s.text}`;
      const h = hintFor(s, prior); prior.push(s);
      return `${s.id} [read ${h.read} score ${h.score} reasons ${h.reasons.join("+")||"none"} penalties ${h.penalties.join("+")||"none"}]: ${s.text}`;
    });
    writeFileSync(`eval/next-agent/prompts/${d.id}/${c}.txt`, `You are a fresh coding agent using Dejavu memory. ${d.task}\nReturn exactly 8 IDs, comma-separated, and nothing else.\n\nSLIPS:\n${lines.join("\n")}\n`);
  }
}

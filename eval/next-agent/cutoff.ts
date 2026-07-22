import { datasets } from "./datasets/index.ts";
import { hintFor, rank, ruleScore } from "./candidates.ts";
import { scoreSelection } from "./score.ts";

for (const d of datasets) {
  console.log(`\n${d.id}`);
  const rulesAll = rank(d.slips, "rules", d.query);
  const rankerAll = rank(d.slips, "ranker", d.query);
  for (const [name, ids] of [
    ["rules8", rulesAll.slice(0,8).map(s=>s.id)],
    ["ranker8", rankerAll.slice(0,8).map(s=>s.id)],
    ["rulesCut", rulesAll.filter(s=>ruleScore(s) > 0).slice(0,12).map(s=>s.id)],
    ["rankerCut", rankerAll.filter(s=>hintFor(s, []).score >= 1).slice(0,12).map(s=>s.id)],
  ] as const) {
    const sc = scoreSelection(d.slips, ids);
    console.log(`${name.padEnd(9)} n=${sc.selected} score=${String(sc.score).padStart(3)} recall=${sc.mustRecall.toFixed(2)} precision=${sc.precisionGood.toFixed(2)} noise=${sc.noiseRate.toFixed(2)} harmful=${sc.harmfulSelected} ids=${ids.join(",")}`);
  }
}

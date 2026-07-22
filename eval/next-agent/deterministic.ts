import { datasets } from "./datasets/index.ts";
import { rank } from "./candidates.ts";
import { scoreSelection } from "./score.ts";
for (const d of datasets) {
  console.log(`\n${d.id}`);
  for (const c of ["current","rules","ranker"] as const) {
    const ids = rank(d.slips, c, d.query).slice(0,8).map(s => s.id);
    const s = scoreSelection(d.slips, ids);
    console.log(`${c.padEnd(8)} score=${String(s.score).padStart(3)} recall=${s.mustRecall.toFixed(2)} precision=${s.precisionGood.toFixed(2)} noise=${s.noiseRate.toFixed(2)} harmful=${s.harmfulSelected} ids=${ids.join(",")}`);
  }
}

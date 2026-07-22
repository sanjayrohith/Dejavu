import { existsSync, readdirSync, readFileSync } from "node:fs";
import { datasets } from "./datasets/index.ts";
import { parseIds, scoreSelection } from "./score.ts";
const model = "cloudflare-workers-ai_cf_moonshotai_kimi-k2.6";
for (const d of datasets) {
  const dir = `eval/next-agent/results/${model}/${d.id}`; if (!existsSync(dir)) continue; console.log(`\n${d.id}`);
  for (const f of ["rules_cutoff.out","ranker_cutoff.out"]) if (existsSync(`${dir}/${f}`)) { const ids=parseIds(readFileSync(`${dir}/${f}`,"utf8")); const s=scoreSelection(d.slips,ids); console.log(`${f.replace('.out','').padEnd(14)} n=${s.selected} score=${s.score} recall=${s.mustRecall.toFixed(2)} precision=${s.precisionGood.toFixed(2)} noise=${s.noiseRate.toFixed(2)} harmful=${s.harmfulSelected} ids=${ids.join(',')}`); }
}

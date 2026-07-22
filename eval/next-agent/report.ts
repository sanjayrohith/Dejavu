import { existsSync, readdirSync, readFileSync } from "node:fs";
import { datasets } from "./datasets/index.ts";
import { scoreSelection } from "./score.ts";
const parse = (s:string) => [...s.matchAll(/[a-z]\d{2}/gi)].map(m=>m[0]);
for (const model of readdirSync("eval/next-agent/results")) {
  console.log(`\nMODEL ${model}`);
  for (const d of datasets) {
    const dir = `eval/next-agent/results/${model}/${d.id}`; if (!existsSync(dir)) continue; console.log(`\n ${d.id}`);
    for (const f of readdirSync(dir).filter(f=>f.endsWith(".out")).sort()) { const ids = parse(readFileSync(`${dir}/${f}`,"utf8")); const s=scoreSelection(d.slips,ids); console.log(`${f.replace('.out','').padEnd(14)} score=${String(s.score).padStart(3)} recall=${s.mustRecall.toFixed(2)} precision=${s.precisionGood.toFixed(2)} noise=${s.noiseRate.toFixed(2)} harmful=${s.harmfulSelected} ids=${ids.join(',')}`); }
  }
}

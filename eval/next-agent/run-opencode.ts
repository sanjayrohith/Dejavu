import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { $ } from "bun";
const model = process.argv[2]; const files = process.argv.slice(3); if (!model || !files.length) throw new Error("usage: bun run run-opencode.ts <model> <prompts...>");
const safe = model.replace(/[^a-z0-9_.-]+/gi,"_").replace(/^_+|_+$/g,"");
for (const f of files) {
  const dataset = basename(dirname(f)); const cond = basename(f, ".txt"); const dir = `eval/next-agent/results/${safe}/${dataset}`; mkdirSync(dir,{recursive:true});
  const prompt = readFileSync(f,"utf8"); const res = await $`opencode run --model ${model} --agent build ${prompt}`.quiet().nothrow();
  writeFileSync(`${dir}/${cond}.out`, res.stdout.toString()); if (res.stderr.length) writeFileSync(`${dir}/${cond}.err`, res.stderr.toString());
  console.error(`${safe} ${dataset}/${cond} ${res.exitCode} ${res.stdout.toString().trim().slice(0,120)}`);
}

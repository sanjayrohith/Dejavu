import { Database } from "bun:sqlite";
import { writeFileSync, mkdirSync } from "node:fs";
import { rank } from "./candidates.ts";
const db = new Database(`${process.env.HOME}/.dejavu/dejavu.db`, { readonly: true });
const rows = db.query("select id, text, state, created_at from slips where state='kept' order by created_at desc limit 80").all() as any[];
const slips = rows.map((r,i)=>({ id: `x${String(i+1).padStart(2,'0')}`, text: r.text, label: 'noise' as const, realId: r.id }));
mkdirSync('eval/next-agent/real', { recursive: true });
for (const c of ['current','rules','ranker'] as const) {
  const selected = rank(slips, c, 'what should next agent know about current Dejavu work').slice(0,15);
  writeFileSync(`eval/next-agent/real/${c}.md`, selected.map(s=>`- ${s.id} ${s.text}`).join('\n'));
}
console.log(JSON.stringify({ count: slips.length, files: ['current','rules','ranker'].map(c=>`eval/next-agent/real/${c}.md`) }, null, 2));

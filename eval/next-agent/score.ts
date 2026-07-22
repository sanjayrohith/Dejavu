import type { EvalSlip } from "./types.ts";
export function labelValue(label: EvalSlip["label"]) { return label === "must" ? 3 : label === "useful" ? 1 : label === "noise" ? -1 : -3; }
export function scoreSelection(slips: EvalSlip[], ids: string[]) {
  const byId = new Map(slips.map(s => [s.id, s]));
  const selected = ids.map(id => byId.get(id)).filter((s): s is EvalSlip => Boolean(s));
  const must = slips.filter(s => s.label === "must");
  const mustSelected = selected.filter(s => s.label === "must").length;
  const usefulSelected = selected.filter(s => s.label === "useful").length;
  const noiseSelected = selected.filter(s => s.label === "noise").length;
  const harmfulSelected = selected.filter(s => s.label === "harmful").length;
  const selectedScore = selected.reduce((sum, s) => sum + labelValue(s.label), 0);
  return { score: selectedScore - (must.length - mustSelected) * 2, selected: selected.length, mustTotal: must.length, mustRecall: must.length ? mustSelected / must.length : 1, precisionGood: (mustSelected + usefulSelected) / Math.max(1, selected.length), noiseRate: (noiseSelected + harmfulSelected) / Math.max(1, selected.length), harmfulSelected, ids };
}
export function parseIds(s: string) { return [...s.matchAll(/[a-z]\d{2}/gi)].map(m=>m[0]); }

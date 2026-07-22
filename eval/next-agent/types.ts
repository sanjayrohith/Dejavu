export type Label = "must" | "useful" | "noise" | "harmful";
export type Candidate = "current" | "rules" | "ranker" | "full_raw" | "full_ranked";
export interface EvalSlip { id: string; text: string; label: Label; }
export interface Dataset { id: string; task: string; query: string; slips: EvalSlip[]; }

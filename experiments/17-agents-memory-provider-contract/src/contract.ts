/**
 * Proposed product API. These types are NOT exported by agents@0.15.0.
 * The contract describes observable memory behavior, not its storage/index.
 */
export interface MemoryScope {
  tenant: string;
  workspace?: string;
  agent?: string;
  session?: string;
}

export interface ContextBudget {
  maxTokens: number;
  maxItems?: number;
}

export interface MemoryProvenance {
  source: "user" | "agent" | "tool" | "import";
  actor?: string;
  ref?: string;
  authoredAt: string;
}

export type PendingWork = {
  kind: string;
  receiptId: string;
};

export type Freshness = {
  state: "fresh" | "pending" | "stale";
  observedAt: string;
  pending: PendingWork[];
};

export interface MemoryWrite {
  content: string;
  scope: MemoryScope;
  provenance: MemoryProvenance;
}

export interface WriteReceipt {
  id: string;
  receiptId: string;
  acceptedAt: string;
  durability: "committed" | "accepted";
  scope: MemoryScope;
  freshness: Freshness;
}

export interface RecallRequest {
  query: string;
  scope: MemoryScope;
  budget: ContextBudget;
}

export interface Resolution {
  state: "active" | "deleted" | "superseded";
  replacedBy?: string;
  reason?: string;
}

export interface MemoryHit {
  id: string;
  content: string;
  scope: MemoryScope;
  provenance: MemoryProvenance;
  resolution: Resolution;
  /** Provider-defined score. No embedding or vector semantics are implied. */
  score?: number;
}

export interface RecallResult {
  hits: MemoryHit[];
  freshness: Freshness;
  budget: ContextBudget & { usedTokens: number; truncated: boolean };
}

export interface MutationReceipt {
  id: string;
  receiptId: string;
  committedAt: string;
  scope: MemoryScope;
  resolution: Resolution;
  freshness: Freshness;
}

export interface MemoryProvider {
  readonly name: string;
  write(input: MemoryWrite): Promise<WriteReceipt>;
  recall(input: RecallRequest): Promise<RecallResult>;
  freshness(scope: MemoryScope): Promise<Freshness>;
  delete(id: string, scope: MemoryScope): Promise<MutationReceipt>;
  resolve(
    id: string,
    scope: MemoryScope,
    resolution: { replacedBy: string; reason?: string },
  ): Promise<MutationReceipt>;
}

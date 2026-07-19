/**
 * Local mirror types. Protocol shapes come from the canonical shared contract;
 * this module adds local materialization/query seams only.
 */

export type {
  SharedAuthorityStatus,
  SharedDeletePayload,
  SharedEventsResponse,
  SharedHandoffPayload,
  SharedMemoryEvent,
  SharedMemoryEventType,
  SharedPurgedRememberPayload,
  SharedRememberPayload,
  SharedSignalAction,
  SharedSignalPayload,
  SharedWriteReceipt,
} from "../shared-contract.ts";

import type {
  SharedEventsResponse,
} from "../shared-contract.ts";

export interface ApplyResult {
  applied: boolean;
  /** Contiguous applied watermark after the event is recorded. */
  mirrorRevision: number;
}

export interface CatchUpResult {
  applied: number;
  mirrorRevision: number;
  headRevision: number;
}

export interface FreshnessReport {
  mirrorRevision: number;
  headRevision: number;
  behind: number;
  fresh: boolean;
}

export interface LocalRecallQuery {
  query?: string;
  tags?: string[];
  limit?: number;
}

export interface SharedLocalHandoff {
  handoffId: string;
  summary: string;
  next: string[];
  kept: string[];
  authoredBy: string;
  sessionId: string;
  revision: number;
  committedAt: string;
}

export interface LocalRecallHit {
  slipId: string;
  text: string;
  tags: string[];
  authoredBy: string;
  sessionId: string;
  revision: number;
  committedAt: string;
  state?: string;
  usedCount?: number;
  wrongCount?: number;
  score: number | null;
}

export interface LocalRecallResult {
  hits: LocalRecallHit[];
  mirrorRevision: number;
  latestHandoff?: SharedLocalHandoff | null;
}

export type FetchEventsFn = (
  since: number,
  limit: number,
) => Promise<SharedEventsResponse>;

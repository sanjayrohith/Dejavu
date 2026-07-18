/**
 * Shared memory protocol contract.
 *
 * Authority and mirror use these types across the live-feed/catch-up seam.
 * See docs/shared-memory-implementation-contract.md.
 */

export type SharedMemoryEventType = "remember" | "handoff" | "signal" | "delete" | "link";

export interface SharedMemoryEvent<T = unknown> {
  /** Per-authority strictly increasing integer revision. */
  revision: number;
  /** Unique delivery/dedupe id. */
  eventId: string;
  type: SharedMemoryEventType;
  /** Opaque owner authority id. */
  authority: string;
  committedAt: string;
  payload: T;
}

export interface SharedRememberPayload {
  slipId: string;
  text: string;
  tags: string[];
  authoredBy: string;
  sessionId: string;
  /** Shared v1 publishes deliberate memories only. */
  state: "kept";
}

/** Redacted historical remember event returned after a server-side delete purge. */
export interface SharedPurgedRememberPayload {
  slipId: string;
  purged: true;
}

export interface RememberWriteInput {
  slipId: string;
  text: string;
  tags?: string[];
  authoredBy: string;
  sessionId: string;
}

export interface SharedHandoffPayload {
  handoffId: string;
  summary: string;
  next: string[];
  authoredBy: string;
  sessionId: string;
  kept: string[];
}

export interface HandoffWriteInput {
  handoffId: string;
  summary: string;
  next?: string[];
  authoredBy: string;
  sessionId: string;
  kept?: string[];
}

export type SharedSignalAction = "used" | "wrong" | "forget";

export interface SharedSignalPayload {
  signalId: string;
  slipId: string;
  action: SharedSignalAction;
  authoredBy: string;
  sessionId: string;
}

export interface SignalWriteInput {
  signalId: string;
  slipId: string;
  action: SharedSignalAction;
  authoredBy: string;
  sessionId: string;
}

/** Hard deletion request. Unlike `signal(..., "forget")`, this removes local copy content. */
export interface SharedDeletePayload {
  deleteId: string;
  slipId: string;
  authoredBy: string;
  sessionId: string;
}

export interface DeleteWriteInput {
  deleteId: string;
  slipId: string;
  authoredBy: string;
  sessionId: string;
}

export interface SharedWriteReceipt<T = unknown> {
  ok: true;
  /** Domain id, e.g. slip id. */
  id: string;
  /** Canonical committed event; safe for writer mirror to apply immediately. */
  event: SharedMemoryEvent<T>;
  receipt: {
    authority: string;
    revision: number;
    committedAt: string;
  };
  recallable: true;
}

export interface SharedEventsResponse {
  ok: true;
  authority: string;
  headRevision: number;
  /** Strictly revision ascending. */
  events: SharedMemoryEvent[];
}

export interface SharedAuthorityStatus {
  ok: true;
  authority: string;
  headRevision: number;
}

export type SharedEventListener = (event: SharedMemoryEvent) => void;

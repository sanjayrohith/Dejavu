/**
 * SharedAuthority — wave-1 Slice A core.
 *
 * Invariants enforced here (see docs/shared-memory-implementation-contract.md):
 *
 *  1. Authority is truth: `remember` commits to in-memory event log *before*
 *     returning the receipt. The included event is safe to apply immediately
 *     to the caller's local mirror.
 *  2. Monotonic revision order: each commit assigns the next strictly
 *     increasing per-owner integer revision starting at 1.
 *  3. Fanout never blocks commits: listener invocation is fire-and-forget via
 *     queueMicrotask, wrapped in try/catch so a bad listener cannot wedge
 *     remember/handoff/signal/delete.
 *
 * Persistence is in-memory for now — the contract calls out that Slice A may
 * use "SQL-ish persistence abstraction or in-memory test authority for now".
 * The shape of `remember` / `eventsSince` / `status` is what matters; storage
 * can be swapped behind these methods later.
 */

import { ulid } from "../ulid.ts";
import type {
  DeleteWriteInput,
  HandoffWriteInput,
  RememberWriteInput,
  SharedAuthorityStatus,
  SharedEventListener,
  SharedEventsResponse,
  SharedDeletePayload,
  SharedHandoffPayload,
  SharedMemoryEvent,
  SharedPurgedRememberPayload,
  SharedRememberPayload,
  SharedSignalPayload,
  SharedWriteReceipt,
  SignalWriteInput,
} from "./types.ts";

export interface SharedAuthorityOptions {
  /** Opaque per-owner authority id/slug surfaced in every event/receipt. */
  authority: string;
  /** Override clock for deterministic tests. Returns ms epoch. */
  now?: () => number;
  /** Override event id generator for deterministic tests. */
  newEventId?: () => string;
}

export class SharedAuthority {
  readonly authority: string;
  private readonly now: () => number;
  private readonly newEventId: () => string;
  private readonly log: SharedMemoryEvent[] = [];
  private headRevision = 0;
  private readonly listeners = new Set<SharedEventListener>();

  constructor(opts: SharedAuthorityOptions) {
    if (!opts.authority || !opts.authority.trim()) {
      throw new Error("SharedAuthority requires a non-empty authority id");
    }
    this.authority = opts.authority;
    this.now = opts.now ?? (() => Date.now());
    this.newEventId = opts.newEventId ?? (() => ulid());
  }

  /**
   * Commit a remember write. The receipt is only returned *after* the event
   * is durably appended to the log (in-memory here). The returned event is
   * the canonical event — writer mirrors can apply it directly.
   */
  remember(input: RememberWriteInput): SharedWriteReceipt<SharedRememberPayload> {
    if (!input || typeof input !== "object") {
      throw new Error("remember requires an input object");
    }
    if (!input.slipId || !input.slipId.trim()) {
      throw new Error("remember requires slipId");
    }
    if (!input.text || !input.text.trim()) {
      throw new Error("remember requires non-empty text");
    }
    if (!input.authoredBy || !input.authoredBy.trim()) {
      throw new Error("remember requires authoredBy");
    }
    if (!input.sessionId || !input.sessionId.trim()) {
      throw new Error("remember requires sessionId");
    }

    const payload: SharedRememberPayload = {
      slipId: input.slipId,
      text: input.text,
      tags: Array.isArray(input.tags) ? [...input.tags] : [],
      authoredBy: input.authoredBy,
      sessionId: input.sessionId,
      state: "kept",
    };

    const event = this.commit("remember", payload);

    const receipt: SharedWriteReceipt<SharedRememberPayload> = {
      ok: true,
      id: input.slipId,
      event,
      receipt: {
        authority: this.authority,
        revision: event.revision,
        committedAt: event.committedAt,
      },
      recallable: true,
    };

    // Commit has returned semantically — fan out best-effort, non-blocking.
    this.fanout(event);

    return receipt;
  }

  handoff(input: HandoffWriteInput): SharedWriteReceipt<SharedHandoffPayload> {
    if (!input.handoffId?.trim()) throw new Error("handoff requires handoffId");
    if (!input.summary?.trim()) throw new Error("handoff requires non-empty summary");
    if (!input.authoredBy?.trim()) throw new Error("handoff requires authoredBy");
    if (!input.sessionId?.trim()) throw new Error("handoff requires sessionId");
    const payload: SharedHandoffPayload = {
      handoffId: input.handoffId,
      summary: input.summary.trim(),
      next: input.next ?? [],
      authoredBy: input.authoredBy,
      sessionId: input.sessionId,
      kept: input.kept ?? [],
    };
    const event = this.commit("handoff", payload);
    const receipt = { ok: true, id: input.handoffId, event, receipt: { authority: this.authority, revision: event.revision, committedAt: event.committedAt }, recallable: true } as const;
    this.fanout(event);
    return receipt;
  }

  signal(input: SignalWriteInput): SharedWriteReceipt<SharedSignalPayload> {
    if (!input.signalId?.trim()) throw new Error("signal requires signalId");
    if (!input.slipId?.trim()) throw new Error("signal requires slipId");
    if (!(["used", "wrong", "forget"] as string[]).includes(input.action)) throw new Error("signal requires used | wrong | forget");
    if (!input.authoredBy?.trim()) throw new Error("signal requires authoredBy");
    if (!input.sessionId?.trim()) throw new Error("signal requires sessionId");
    const payload: SharedSignalPayload = { signalId: input.signalId, slipId: input.slipId, action: input.action, authoredBy: input.authoredBy, sessionId: input.sessionId };
    const event = this.commit("signal", payload);
    const receipt = { ok: true, id: input.signalId, event, receipt: { authority: this.authority, revision: event.revision, committedAt: event.committedAt }, recallable: true } as const;
    this.fanout(event);
    return receipt;
  }

  delete(input: DeleteWriteInput): SharedWriteReceipt<SharedDeletePayload> {
    if (!input.deleteId?.trim()) throw new Error("delete requires deleteId");
    if (!input.slipId?.trim()) throw new Error("delete requires slipId");
    if (!input.authoredBy?.trim()) throw new Error("delete requires authoredBy");
    if (!input.sessionId?.trim()) throw new Error("delete requires sessionId");
    const payload: SharedDeletePayload = { deleteId: input.deleteId, slipId: input.slipId, authoredBy: input.authoredBy, sessionId: input.sessionId };
    const event = this.commit("delete", payload);
    // Redact prior remembered content while retaining its revision position so
    // a new/offline mirror can replay the ordered log then apply the delete.
    for (let i = 0; i < this.log.length - 1; i++) {
      const prior = this.log[i]!;
      if (prior.type !== "remember") continue;
      const remembered = prior.payload as SharedRememberPayload;
      if (remembered.slipId !== input.slipId) continue;
      prior.payload = { slipId: input.slipId, purged: true } satisfies SharedPurgedRememberPayload;
    }
    const receipt = { ok: true, id: input.slipId, event, receipt: { authority: this.authority, revision: event.revision, committedAt: event.committedAt }, recallable: true } as const;
    this.fanout(event);
    return receipt;
  }

  /**
   * Strictly revision-ascending events with `revision > since`. `limit`
   * defaults to 1000 to keep responses bounded.
   */
  eventsSince(since: number = 0, limit: number = 1000): SharedEventsResponse {
    const safeSince = Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1000;

    // Log is already revision-ascending because we only append after assigning
    // the next revision; binary search for the first element with revision > since.
    const start = this.firstIndexAfter(safeSince);
    const slice = start < 0 ? [] : this.log.slice(start, start + safeLimit);

    return {
      ok: true,
      authority: this.authority,
      headRevision: this.headRevision,
      events: slice,
    };
  }

  status(): SharedAuthorityStatus {
    return {
      ok: true,
      authority: this.authority,
      headRevision: this.headRevision,
    };
  }

  /**
   * Register a live-feed listener. Returns an unsubscribe function. Listener
   * invocation is fire-and-forget (queueMicrotask + try/catch) so a slow or
   * throwing subscriber cannot block a future commit. The contract allows the
   * authority to drop a misbehaving subscriber; here we simply isolate
   * failures and continue.
   */
  subscribe(listener: SharedEventListener): () => void {
    if (typeof listener !== "function") {
      throw new Error("subscribe requires a function listener");
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- internals ----

  private commit<T>(type: SharedMemoryEvent["type"], payload: T): SharedMemoryEvent<T> {
    const revision = this.headRevision + 1;
    const event: SharedMemoryEvent<T> = {
      revision,
      eventId: this.newEventId(),
      type,
      authority: this.authority,
      committedAt: new Date(this.now()).toISOString(),
      payload,
    };
    // Append + bump head atomically from the caller's perspective. JS is
    // single-threaded so these two statements are effectively a transaction.
    this.log.push(event as SharedMemoryEvent);
    this.headRevision = revision;
    return event;
  }

  private fanout(event: SharedMemoryEvent): void {
    if (this.listeners.size === 0) return;
    // Snapshot listeners so unsubscribe during fanout is safe.
    const snapshot = [...this.listeners];
    for (const l of snapshot) {
      queueMicrotask(() => {
        try {
          l(event);
        } catch {
          // Swallow — fanout must never wedge commits, and a thrown listener
          // is the listener's problem, not the authority's.
        }
      });
    }
  }

  private firstIndexAfter(since: number): number {
    // The log is ascending by revision and we always append at the end.
    // Use a simple linear scan from the end-anchored estimate, falling back
    // to binary search when the log is large.
    if (this.log.length === 0) return -1;
    const last = this.log[this.log.length - 1]!;
    if (last.revision <= since) return -1;
    const first = this.log[0]!;
    if (first.revision > since) return 0;

    let lo = 0;
    let hi = this.log.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.log[mid]!.revision <= since) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }
}

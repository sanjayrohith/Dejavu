/**
 * Wave 2 slice D — client-side connection/feed manager around LocalMirror.
 *
 * Provides a generic abstraction over the live-feed + catch-up seam described
 * in docs/shared-memory-implementation-contract.md. This module does NO actual
 * networking: callers inject:
 *
 *   - a FetchEventsFn for catch-up (and reconnect repair);
 *   - a SubscribeFn that wires up live delivery and returns an unsubscribe;
 *   - optionally a FetchStatusFn so the manager can refresh authority head
 *     without piggybacking on catch-up.
 *
 * Lifecycle:
 *
 *   start():       transition idle  -> connecting, run catchUp, then subscribe
 *                  to live events, becoming "live" once subscribed.
 *   stop():        unsubscribe, mark "stopped". Mirror is preserved.
 *   reconnect():   stop the existing subscription (if any) and re-run start(),
 *                  which catches up across whatever gap the disconnect created.
 *
 * Status / freshness:
 *
 *   - The manager tracks the last known authority head from any source:
 *     the latest catchUp response, the latest live event's revision, or an
 *     explicit fetchStatus() call.
 *   - freshness() compares mirror.mirrorRevision to that head.
 *   - "fresh" is the boolean Slice B already exposes; this manager just
 *     surfaces the same shape with the head we've learned of.
 *
 * The class is intentionally generic and synchronous-friendly: live event
 * application is synchronous against the mirror so a writer's read-after-
 * write semantics are preserved.
 */

import { LocalMirror } from "./mirror.ts";
import type {
  CatchUpResult,
  FetchEventsFn,
  FreshnessReport,
  SharedAuthorityStatus,
  SharedMemoryEvent,
} from "./types.ts";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "live"
  | "stopped"
  | "error";

/**
 * Caller-supplied live subscribe. Implementations might wrap SSE, a
 * WebSocket, or an in-process event emitter. The manager passes a listener
 * that MUST be invoked for every live event the transport delivers; the
 * returned function MUST tear down the subscription synchronously.
 *
 * `since` is the mirror's contiguous watermark at subscribe time, exposed
 * so the transport may opt to replay from there. The manager itself does
 * NOT rely on the transport replaying — catch-up handles that — but real
 * SSE servers usually accept a `since` query param so we plumb it through.
 */
export type SubscribeFn = (
  listener: (event: SharedMemoryEvent) => void,
  since: number,
) => Unsubscribe | Promise<Unsubscribe>;

export type Unsubscribe = () => void | Promise<void>;

export type FetchStatusFn = () => Promise<SharedAuthorityStatus>;

export interface SharedConnectionOptions {
  mirror: LocalMirror;
  fetchEvents: FetchEventsFn;
  subscribe: SubscribeFn;
  /** Optional explicit status probe. Falls back to catchUp's headRevision. */
  fetchStatus?: FetchStatusFn;
  /** catchUp batch size (default 200). */
  catchUpBatchSize?: number;
  /** catchUp max batches per attempt (default 100). */
  catchUpMaxBatches?: number;
  /** Invoked when the connection enters error state. */
  onError?: (err: unknown, phase: "catchUp" | "subscribe" | "live") => void;
}

export interface ConnectionSnapshot {
  status: ConnectionStatus;
  mirrorRevision: number;
  /** Highest authority head this manager has observed from any source. */
  knownHeadRevision: number;
  freshness: FreshnessReport;
  lastError: string | null;
}

/**
 * Client-side manager. Owns the live subscription handle and the freshness
 * accounting; defers persistence/apply logic to the injected LocalMirror.
 */
export class SharedConnection {
  private readonly mirror: LocalMirror;
  private readonly fetchEvents: FetchEventsFn;
  private readonly subscribe: SubscribeFn;
  private readonly fetchStatus: FetchStatusFn | null;
  private readonly catchUpBatchSize: number;
  private readonly catchUpMaxBatches: number;
  private readonly onError: SharedConnectionOptions["onError"];

  private _status: ConnectionStatus = "idle";
  private _knownHead = 0;
  private _lastError: string | null = null;
  private _unsubscribe: Unsubscribe | null = null;
  /**
   * Monotonic generation token. Bumped on every stop()/reconnect()/error so
   * an in-flight async start() can detect it has been superseded and refuse
   * to wire up a stale subscription.
   */
  private _gen = 0;

  constructor(opts: SharedConnectionOptions) {
    this.mirror = opts.mirror;
    this.fetchEvents = opts.fetchEvents;
    this.subscribe = opts.subscribe;
    this.fetchStatus = opts.fetchStatus ?? null;
    this.catchUpBatchSize = opts.catchUpBatchSize ?? 200;
    this.catchUpMaxBatches = opts.catchUpMaxBatches ?? 100;
    this.onError = opts.onError;
    // Seed knownHead from whatever the mirror has applied locally so the
    // first freshness() call before start() is sane.
    this._knownHead = this.mirror.getMirrorRevision();
  }

  // ---- public lifecycle ----

  get status(): ConnectionStatus {
    return this._status;
  }

  /**
   * Start the connection. Runs catchUp first so the mirror reaches the
   * authority head, then subscribes for live delivery. Becomes "live" only
   * after both succeed. Safe to call repeatedly: if already live, returns
   * the current snapshot. If currently stopped/error, behaves as a fresh
   * start.
   */
  async start(): Promise<ConnectionSnapshot> {
    if (this._status === "live" || this._status === "connecting") {
      return this.snapshot();
    }

    const myGen = ++this._gen;
    this._status = "connecting";
    this._lastError = null;

    // 1. catch up so mirror reaches the head we currently know about.
    let catchUp: CatchUpResult;
    try {
      catchUp = await this.mirror.catchUp(this.fetchEvents, {
        batchSize: this.catchUpBatchSize,
        maxBatches: this.catchUpMaxBatches,
      });
    } catch (err) {
      return this.failWith(err, "catchUp", myGen);
    }
    if (myGen !== this._gen) {
      // Superseded by stop()/reconnect() during catchUp. Don't overwrite
      // status — whatever bumped the gen owns it.
      return this.snapshot();
    }
    this._knownHead = Math.max(this._knownHead, catchUp.headRevision);

    // 2. wire up live subscription. The listener applies events to the
    // mirror synchronously and updates known head.
    let unsub: Unsubscribe;
    try {
      const listener = (event: SharedMemoryEvent) => {
        // Guard against stale events arriving after stop()/error.
        if (myGen !== this._gen) return;
        try {
          this.mirror.apply(event);
          if (event.revision > this._knownHead) {
            this._knownHead = event.revision;
          }
        } catch (err) {
          this.onError?.(err, "live");
        }
      };
      unsub = await this.subscribe(listener, this.mirror.getMirrorRevision());
    } catch (err) {
      return this.failWith(err, "subscribe", myGen);
    }
    if (myGen !== this._gen) {
      // Stopped while subscribing. Tear down the brand-new subscription
      // immediately to avoid leaks.
      await this.safeUnsub(unsub);
      return this.snapshot();
    }

    this._unsubscribe = unsub;
    this._status = "live";
    return this.snapshot();
  }

  /**
   * Tear down the live subscription. The local mirror is preserved so any
   * already-applied events remain locally recallable; freshness will report
   * stale relative to the last known head because new events stop landing.
   */
  async stop(): Promise<ConnectionSnapshot> {
    // Bump gen so any pending start() bails before flipping us back.
    this._gen++;

    const unsub = this._unsubscribe;
    this._unsubscribe = null;
    if (unsub) {
      await this.safeUnsub(unsub);
    }
    this._status = "stopped";
    return this.snapshot();
  }

  /**
   * Disconnect (if currently live) and re-run start(). Used to repair gaps
   * after a transport hiccup: catchUp will pull every event the live feed
   * missed during the dead window.
   */
  async reconnect(): Promise<ConnectionSnapshot> {
    if (this._status === "live" || this._unsubscribe) {
      await this.stop();
    }
    return this.start();
  }

  /**
   * Probe the authority for its current head (when caller supplied a
   * fetchStatus). Useful for surfacing freshness without forcing a full
   * catch-up.
   */
  async refreshStatus(): Promise<ConnectionSnapshot> {
    if (!this.fetchStatus) return this.snapshot();
    try {
      const s = await this.fetchStatus();
      if (s.headRevision > this._knownHead) {
        this._knownHead = s.headRevision;
      }
    } catch (err) {
      // Don't flip status on status probe failure — it's diagnostic.
      this._lastError = errToString(err);
      this.onError?.(err, "catchUp");
    }
    return this.snapshot();
  }

  /**
   * Synchronous freshness report against the last known authority head.
   * Equivalent to LocalMirror.freshness(knownHead) but uses the head this
   * manager has been tracking from live events / status / catchUp.
   */
  freshness(headOverride?: number): FreshnessReport {
    const head = headOverride ?? this._knownHead;
    return this.mirror.freshness(head);
  }

  snapshot(): ConnectionSnapshot {
    return {
      status: this._status,
      mirrorRevision: this.mirror.getMirrorRevision(),
      knownHeadRevision: this._knownHead,
      freshness: this.freshness(),
      lastError: this._lastError,
    };
  }

  // ---- internals ----

  private failWith(
    err: unknown,
    phase: "catchUp" | "subscribe",
    myGen: number,
  ): ConnectionSnapshot {
    if (myGen !== this._gen) {
      // Already superseded; don't clobber.
      return this.snapshot();
    }
    this._gen++;
    this._status = "error";
    this._lastError = errToString(err);
    this.onError?.(err, phase);
    return this.snapshot();
  }

  private async safeUnsub(unsub: Unsubscribe): Promise<void> {
    try {
      await unsub();
    } catch {
      // Unsubscribe errors are non-fatal; transport already dead.
    }
  }
}

function errToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

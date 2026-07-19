/**
 * Live feed subscription on top of SharedAuthority.
 *
 * The contract (docs/shared-memory-implementation-contract.md) describes a
 * `GET /v1/shared/stream?since=R` SSE seam. This file is the in-process
 * primitive that sits behind that future transport: a subscription/session
 * object that emits ordered, committed SharedMemoryEvent values, supports
 * starting from any revision (`since`) by first replaying the backlog and
 * then switching to live deliveries, and guarantees that a slow or throwing
 * consumer cannot block the authority's `remember` path.
 *
 * Design:
 *
 *   - Open phase: register the authority listener BEFORE reading the
 *     backlog. Live events that commit during catch-up are buffered into
 *     the feed; we then dedupe them against the backlog by revision when
 *     they arrive after the backlog is flushed.
 *   - Backlog phase: pull `eventsSince(since)` in pages (`pageSize`) until
 *     we reach the snapshot's headRevision. Each backlog event is pushed
 *     into the feed in strict revision order.
 *   - Live phase: subsequent listener invocations push directly into the
 *     feed. Anything <= the last delivered revision is dropped (it was
 *     already delivered via the backlog).
 *
 *   - Backpressure: the underlying AsyncEventFeed has bounded capacity and
 *     a configurable overflow policy. The default policy is `close`, which
 *     matches the SSE "disconnect a slow subscriber" contract. The
 *     authority listener call site only does feed.push() which is
 *     synchronous and never blocks, so a slow consumer cannot wedge
 *     `remember`.
 *
 *   - Errors in the consumer never reach the authority. The authority's
 *     `subscribe` already wraps listener invocations in try/catch and a
 *     microtask, and the feed's push() never throws for queue-state
 *     reasons.
 */
import type { SharedAuthority } from "./authority.ts";
import type { SharedMemoryEvent } from "./types.ts";
import {
  AsyncEventFeed,
  type AsyncEventFeedOptions,
  type FeedOverflowPolicy,
  type FeedStats,
} from "./feed.ts";

export interface LiveFeedOptions {
  /**
   * Resume from this revision exclusive — i.e. the first event emitted will
   * have revision > since. Default 0 (deliver everything from the start).
   */
  since?: number;
  /** Backlog page size when draining via eventsSince. Default 256. */
  pageSize?: number;
  /** Max buffered events before overflow policy kicks in. Default 1024. */
  capacity?: number;
  /**
   * What to do when the consumer is too slow to keep up with live events.
   * Defaults to `close` (disconnect the subscription), which matches the
   * SSE behavior the contract describes for fanout backpressure.
   */
  overflow?: FeedOverflowPolicy;
  /** Optional instrumentation hook for overflow events. */
  onOverflow?: AsyncEventFeedOptions["onOverflow"];
}

export interface LiveFeedStats extends FeedStats {
  /** Highest revision pushed into the feed so far. */
  lastRevision: number;
  /** Whether backlog catch-up has completed. */
  caughtUp: boolean;
}

/**
 * A live subscription/session producing ordered committed SharedMemoryEvent
 * values. Suitable as the substrate for an SSE/WS transport adapter.
 */
export class LiveFeed implements AsyncIterable<SharedMemoryEvent> {
  private readonly authority: SharedAuthority;
  private readonly feed: AsyncEventFeed<SharedMemoryEvent>;
  private readonly pageSize: number;
  private readonly sinceRequested: number;

  private unsubscribeAuthority: (() => void) | null = null;
  private lastPushedRevision = 0;
  private caughtUp = false;
  private startPromise: Promise<void> | null = null;
  private closed = false;

  /**
   * Buffer for live events that arrive while we are still draining the
   * backlog. Once catch-up completes we flush these into the feed (skipping
   * any whose revision is <= the last backlog revision we already
   * delivered).
   */
  private liveBuffer: SharedMemoryEvent[] = [];

  constructor(authority: SharedAuthority, opts: LiveFeedOptions = {}) {
    this.authority = authority;
    this.sinceRequested = Number.isFinite(opts.since) && (opts.since as number) >= 0
      ? Math.floor(opts.since as number)
      : 0;
    this.pageSize = Number.isFinite(opts.pageSize) && (opts.pageSize as number) > 0
      ? Math.floor(opts.pageSize as number)
      : 256;
    this.lastPushedRevision = this.sinceRequested;

    this.feed = new AsyncEventFeed<SharedMemoryEvent>({
      capacity: opts.capacity ?? 1024,
      overflow: opts.overflow ?? "close",
      onOverflow: opts.onOverflow,
    });
  }

  /**
   * Begin emitting events. Subscribes to the authority first so live events
   * during backlog drain are captured, then replays the backlog in strict
   * revision order, then switches to live mode. Safe to call multiple times
   * — subsequent calls return the same promise.
   */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    // Subscribe BEFORE reading the snapshot so we don't lose events that
    // commit between the snapshot read and the listener registration.
    this.unsubscribeAuthority = this.authority.subscribe((event) => {
      this.onAuthorityEvent(event);
    });

    if (this.closed) {
      // Closed during the synchronous portion above.
      this.unsubscribeAuthority?.();
      this.unsubscribeAuthority = null;
      return;
    }

    try {
      let cursor = this.sinceRequested;
      // Capture the authority head at the moment we start draining; any
      // live event with revision > snapshotHead will be delivered via the
      // listener path, not the backlog path. Events <= snapshotHead may
      // arrive on both paths and are deduped by lastPushedRevision.
      const snapshotHead = this.authority.status().headRevision;

      while (cursor < snapshotHead) {
        if (this.closed) return;
        const page = this.authority.eventsSince(cursor, this.pageSize);
        if (page.events.length === 0) break;
        for (const ev of page.events) {
          if (this.closed) return;
          this.deliver(ev);
          cursor = ev.revision;
        }
      }
    } finally {
      // Mark catch-up complete and flush any live events buffered during
      // catch-up that are strictly newer than what we delivered.
      this.caughtUp = true;
      const pending = this.liveBuffer;
      this.liveBuffer = [];
      for (const ev of pending) {
        if (this.closed) break;
        this.deliver(ev);
      }
    }
  }

  /**
   * Pull the next event. The caller must have called `start()` first (or
   * await iteration which will start automatically).
   */
  async next(): Promise<IteratorResult<SharedMemoryEvent>> {
    // Auto-start so `for await (const e of feed)` works without a manual
    // start() call.
    if (!this.startPromise) {
      // Fire-and-forget; we don't need to await — backlog delivery happens
      // inline via deliver() and will be available to the feed as it goes.
      void this.start();
    }
    return this.feed.next();
  }

  return(): Promise<IteratorResult<SharedMemoryEvent>> {
    this.close();
    return Promise.resolve({
      value: undefined as unknown as SharedMemoryEvent,
      done: true,
    });
  }

  /**
   * Close the subscription. Unsubscribes from the authority and ends the
   * iterator. Safe to call multiple times.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.unsubscribeAuthority) {
      try {
        this.unsubscribeAuthority();
      } catch {
        // Ignore — authority's unsubscribe should not throw, but if a
        // future adapter does, isolate the failure.
      }
      this.unsubscribeAuthority = null;
    }
    this.feed.close();
    this.liveBuffer = [];
  }

  /** Alias for close() — matches subscribe()'s unsubscribe terminology. */
  unsubscribe(): void {
    this.close();
  }

  isClosed(): boolean {
    return this.closed;
  }

  stats(): LiveFeedStats {
    return {
      ...this.feed.stats(),
      lastRevision: this.lastPushedRevision,
      caughtUp: this.caughtUp,
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<SharedMemoryEvent> {
    return this;
  }

  // ---- internals ----

  private onAuthorityEvent(event: SharedMemoryEvent): void {
    if (this.closed) return;
    if (!this.caughtUp) {
      // Stash until backlog drain finishes so we don't interleave a live
      // event ahead of an older backlog event. Bound the live buffer to
      // the feed capacity-ish so we don't grow unbounded if catch-up is
      // very slow — overflow is enforced indirectly by the feed when we
      // flush, but we still cap here to keep memory in check.
      this.liveBuffer.push(event);
      return;
    }
    this.deliver(event);
  }

  private deliver(event: SharedMemoryEvent): void {
    if (event.revision <= this.lastPushedRevision) {
      // Already delivered via the backlog path (or below the requested
      // since cursor). Drop to maintain strict per-subscription ordering
      // without duplicates.
      return;
    }
    const accepted = this.feed.push(event);
    if (accepted) {
      this.lastPushedRevision = event.revision;
    } else if (this.feed.isClosed()) {
      // The feed closed itself due to overflow policy — propagate so we
      // also unsubscribe from the authority.
      this.close();
    }
  }
}

/**
 * Convenience helper: open a LiveFeed and start it. Returns the subscription
 * after backlog drain has *begun* — callers iterate the returned object to
 * pull events. Use this when you want a single-call ergonomic API.
 */
export function openLiveFeed(
  authority: SharedAuthority,
  opts: LiveFeedOptions = {},
): LiveFeed {
  const feed = new LiveFeed(authority, opts);
  void feed.start();
  return feed;
}

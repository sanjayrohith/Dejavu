/**
 * Generic async event feed.
 *
 * A bounded queue with async-iterator semantics. Producers call `push(value)`
 * and never block — if the consumer is slow and the buffer is full the feed
 * applies a configurable overflow policy. Consumers either `await next()` or
 * `for await` over the feed.
 *
 * This abstraction intentionally has zero knowledge of SharedMemoryEvent or
 * any Worker-specific transport. It is the substrate the LiveFeed sits on
 * top of and is what a future SSE adapter or WebSocket adapter would feed
 * directly. Tests can build trivial fixtures.
 *
 * Invariants:
 *
 *   1. push() is synchronous, never throws for queue-state reasons, and
 *      never awaits the consumer. A misbehaving consumer cannot wedge the
 *      producer.
 *   2. Values delivered to a single consumer preserve FIFO push order.
 *   3. Once close() has been called and the internal buffer has drained,
 *      iteration completes and pending `next()` resolves to `{done:true}`.
 *   4. After close, further push() calls are silently dropped — the feed
 *      is a fire-and-forget sink from the producer's perspective.
 *
 * Overflow policy when the bounded buffer is full and a value is pushed:
 *
 *   - "drop-newest" (default): drop the new value, increment dropped count.
 *   - "drop-oldest": evict the oldest buffered value, append the new value.
 *   - "close": close the feed (subscriber is too slow to keep up). After
 *     close, iteration ends; this is the SSE-style "disconnect a slow
 *     subscriber" behavior the contract calls out.
 */
export type FeedOverflowPolicy = "drop-newest" | "drop-oldest" | "close";

export interface AsyncEventFeedOptions {
  /** Max queued, undelivered values. Default: 1024. */
  capacity?: number;
  /** What to do when push() is called with a full buffer. Default: drop-newest. */
  overflow?: FeedOverflowPolicy;
  /** Optional close-cause callback for instrumentation/logging. */
  onOverflow?: (info: { policy: FeedOverflowPolicy; dropped: number }) => void;
}

export interface FeedStats {
  buffered: number;
  delivered: number;
  dropped: number;
  closed: boolean;
}

interface Waiter<T> {
  resolve: (value: IteratorResult<T>) => void;
}

export class AsyncEventFeed<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly capacity: number;
  private readonly overflow: FeedOverflowPolicy;
  private readonly onOverflow?: (info: { policy: FeedOverflowPolicy; dropped: number }) => void;

  private readonly buffer: T[] = [];
  private readonly waiters: Waiter<T>[] = [];
  private closed = false;
  private deliveredCount = 0;
  private droppedCount = 0;

  constructor(opts: AsyncEventFeedOptions = {}) {
    const cap = opts.capacity ?? 1024;
    if (!Number.isFinite(cap) || cap <= 0) {
      throw new Error("AsyncEventFeed capacity must be a positive number");
    }
    this.capacity = Math.floor(cap);
    this.overflow = opts.overflow ?? "drop-newest";
    this.onOverflow = opts.onOverflow;
  }

  /**
   * Synchronously enqueue a value. Never blocks the producer. If the buffer
   * is full, the configured overflow policy is applied. Returns true if the
   * value was accepted (handed to a waiter or buffered), false if dropped or
   * the feed is closed.
   */
  push(value: T): boolean {
    if (this.closed) return false;

    // Hand directly to the oldest waiter if any. The buffer is always empty
    // when waiters are present (waiters are only created when buffer empty).
    const waiter = this.waiters.shift();
    if (waiter) {
      this.deliveredCount++;
      waiter.resolve({ value, done: false });
      return true;
    }

    if (this.buffer.length < this.capacity) {
      this.buffer.push(value);
      return true;
    }

    // Buffer is full — apply overflow policy.
    switch (this.overflow) {
      case "drop-newest":
        this.droppedCount++;
        this.onOverflow?.({ policy: "drop-newest", dropped: this.droppedCount });
        return false;
      case "drop-oldest":
        this.buffer.shift();
        this.droppedCount++;
        this.buffer.push(value);
        this.onOverflow?.({ policy: "drop-oldest", dropped: this.droppedCount });
        return true;
      case "close":
        this.droppedCount++;
        this.onOverflow?.({ policy: "close", dropped: this.droppedCount });
        this.close();
        return false;
    }
  }

  /** Pull the next value. Resolves to {done:true} once the feed is closed and drained. */
  next(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) {
      const value = this.buffer.shift()!;
      this.deliveredCount++;
      return Promise.resolve({ value, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.waiters.push({ resolve });
    });
  }

  /** Called by `for await ... of` when the consumer breaks early. */
  return(): Promise<IteratorResult<T>> {
    this.close();
    return Promise.resolve({ value: undefined as unknown as T, done: true });
  }

  /**
   * Close the feed. Pending waiters resolve to {done:true}. Buffered values
   * already delivered to waiters were resolved synchronously; values still
   * sitting in the buffer remain pullable so a consumer can drain them
   * before iteration ends.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Resolve any waiters that are blocked on next(); buffer is empty for
    // them by construction (waiters only exist when buffer is empty).
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const w of pending) {
      w.resolve({ value: undefined as unknown as T, done: true });
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  stats(): FeedStats {
    return {
      buffered: this.buffer.length,
      delivered: this.deliveredCount,
      dropped: this.droppedCount,
      closed: this.closed,
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

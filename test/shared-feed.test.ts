import { describe, expect, test } from "bun:test";
import { SharedAuthority } from "../src/shared-authority/authority.ts";
import { AsyncEventFeed } from "../src/shared-authority/feed.ts";
import { LiveFeed, openLiveFeed } from "../src/shared-authority/subscription.ts";

function makeAuthority(opts?: { authority?: string }) {
  let n = 0;
  let t = 1_700_000_000_000;
  return new SharedAuthority({
    authority: opts?.authority ?? "test-authority",
    now: () => t++,
    newEventId: () => `EVT${(++n).toString().padStart(4, "0")}`,
  });
}

const baseInput = {
  slipId: "slip-1",
  text: "hello",
  tags: [] as string[],
  authoredBy: "agent-a",
  sessionId: "sess-1",
};

async function tick(times: number = 3): Promise<void> {
  // Drain any queued microtasks. The authority fan-out uses
  // queueMicrotask, so a couple of awaits ensures delivery.
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function collect<T>(
  it: AsyncIterable<T>,
  n: number,
  timeoutMs: number = 100,
): Promise<T[]> {
  const out: T[] = [];
  const iter = it[Symbol.asyncIterator]();
  for (let i = 0; i < n; i++) {
    const result = await Promise.race([
      iter.next(),
      new Promise<IteratorResult<T>>((_, reject) =>
        setTimeout(() => reject(new Error(`collect timed out waiting for value ${i + 1}/${n}`)), timeoutMs),
      ),
    ]);
    if (result.done) break;
    out.push(result.value);
  }
  return out;
}

describe("AsyncEventFeed", () => {
  test("delivers pushed values in FIFO order", async () => {
    const feed = new AsyncEventFeed<number>();
    feed.push(1);
    feed.push(2);
    feed.push(3);
    feed.close();
    const got = await collect(feed, 3);
    expect(got).toEqual([1, 2, 3]);
  });

  test("push hands directly to a pending waiter", async () => {
    const feed = new AsyncEventFeed<string>();
    const p = feed.next();
    feed.push("hi");
    const result = await p;
    expect(result).toEqual({ value: "hi", done: false });
  });

  test("close ends iteration after buffer drains", async () => {
    const feed = new AsyncEventFeed<number>();
    feed.push(7);
    feed.close();
    expect(await feed.next()).toEqual({ value: 7, done: false });
    expect(await feed.next()).toEqual({ value: undefined as unknown as number, done: true });
  });

  test("close resolves pending waiter to done", async () => {
    const feed = new AsyncEventFeed<number>();
    const p = feed.next();
    feed.close();
    expect(await p).toEqual({ value: undefined as unknown as number, done: true });
  });

  test("push after close is dropped and returns false", () => {
    const feed = new AsyncEventFeed<number>();
    feed.close();
    expect(feed.push(1)).toBe(false);
    expect(feed.stats().closed).toBe(true);
  });

  test("drop-newest overflow drops new values when full", () => {
    const feed = new AsyncEventFeed<number>({ capacity: 2, overflow: "drop-newest" });
    expect(feed.push(1)).toBe(true);
    expect(feed.push(2)).toBe(true);
    expect(feed.push(3)).toBe(false); // dropped
    expect(feed.stats().buffered).toBe(2);
    expect(feed.stats().dropped).toBe(1);
  });

  test("drop-oldest overflow evicts oldest", async () => {
    const feed = new AsyncEventFeed<number>({ capacity: 2, overflow: "drop-oldest" });
    feed.push(1);
    feed.push(2);
    feed.push(3); // evicts 1
    feed.close();
    const got = await collect(feed, 2);
    expect(got).toEqual([2, 3]);
  });

  test("close overflow disconnects on backpressure", () => {
    const feed = new AsyncEventFeed<number>({ capacity: 1, overflow: "close" });
    expect(feed.push(1)).toBe(true);
    expect(feed.push(2)).toBe(false);
    expect(feed.isClosed()).toBe(true);
  });
});

describe("LiveFeed — backlog + live ordering", () => {
  test("emits backlog from since=0 then live events in order", async () => {
    const a = makeAuthority();
    a.remember({ ...baseInput, slipId: "s1" });
    a.remember({ ...baseInput, slipId: "s2" });

    const feed = openLiveFeed(a, { since: 0 });

    // After start, two backlog events should be available; then commit live.
    const backlog = await collect(feed, 2);
    expect(backlog.map((e) => e.revision)).toEqual([1, 2]);

    a.remember({ ...baseInput, slipId: "s3" });
    a.remember({ ...baseInput, slipId: "s4" });
    await tick();

    const live = await collect(feed, 2);
    expect(live.map((e) => e.revision)).toEqual([3, 4]);
    expect(live.map((e) => e.payload && (e.payload as { slipId: string }).slipId)).toEqual([
      "s3",
      "s4",
    ]);

    feed.close();
  });

  test("since=N skips backlog at or below N", async () => {
    const a = makeAuthority();
    a.remember({ ...baseInput, slipId: "s1" });
    a.remember({ ...baseInput, slipId: "s2" });
    a.remember({ ...baseInput, slipId: "s3" });

    const feed = openLiveFeed(a, { since: 2 });
    const backlog = await collect(feed, 1);
    expect(backlog.map((e) => e.revision)).toEqual([3]);

    a.remember({ ...baseInput, slipId: "s4" });
    await tick();
    const live = await collect(feed, 1);
    expect(live[0]!.revision).toBe(4);

    feed.close();
  });

  test("live event committed during catch-up is delivered exactly once", async () => {
    const a = makeAuthority();
    // Pre-load enough backlog to force more than one page.
    for (let i = 0; i < 5; i++) {
      a.remember({ ...baseInput, slipId: `pre-${i}` });
    }

    const feed = new LiveFeed(a, { since: 0, pageSize: 2 });
    const startP = feed.start();

    // Commit a live event while start() is mid-drain. Because doStart() is
    // async, we await the microtask queue first so the subscribe() call has
    // completed but backlog drain is still in-flight.
    await Promise.resolve();
    a.remember({ ...baseInput, slipId: "during-drain" });

    await startP;
    await tick();

    const all = await collect(feed, 6);
    const revisions = all.map((e) => e.revision);
    // Strictly ascending, no duplicates, all 6 events.
    expect(revisions).toEqual([1, 2, 3, 4, 5, 6]);
    // No duplicates in revisions.
    expect(new Set(revisions).size).toBe(revisions.length);

    feed.close();
  });

  test("backlog respects pageSize boundary", async () => {
    const a = makeAuthority();
    for (let i = 0; i < 7; i++) {
      a.remember({ ...baseInput, slipId: `s${i}` });
    }

    const feed = openLiveFeed(a, { since: 0, pageSize: 3 });
    const all = await collect(feed, 7);
    expect(all.map((e) => e.revision)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    feed.close();
  });
});

describe("LiveFeed — close / lifecycle", () => {
  test("close ends iteration and unsubscribes from the authority", async () => {
    const a = makeAuthority();
    a.remember({ ...baseInput, slipId: "s1" });

    const feed = openLiveFeed(a, { since: 0 });
    const got = await collect(feed, 1);
    expect(got).toHaveLength(1);

    feed.close();
    expect(feed.isClosed()).toBe(true);

    // After close, further authority commits must not appear and must not
    // cause errors. We also want the iterator to be done.
    a.remember({ ...baseInput, slipId: "s2" });
    await tick();
    const done = await feed.next();
    expect(done.done).toBe(true);
  });

  test("unsubscribe is an alias for close", async () => {
    const a = makeAuthority();
    const feed = openLiveFeed(a, { since: 0 });
    feed.unsubscribe();
    expect(feed.isClosed()).toBe(true);
    const r = await feed.next();
    expect(r.done).toBe(true);
  });

  test("close is idempotent", () => {
    const a = makeAuthority();
    const feed = openLiveFeed(a, { since: 0 });
    feed.close();
    feed.close();
    expect(feed.isClosed()).toBe(true);
  });

  test("iterator return() (early break) closes the feed", async () => {
    const a = makeAuthority();
    a.remember({ ...baseInput, slipId: "s1" });
    a.remember({ ...baseInput, slipId: "s2" });

    const feed = openLiveFeed(a, { since: 0 });
    const collected: number[] = [];
    for await (const ev of feed) {
      collected.push(ev.revision);
      if (collected.length === 1) break;
    }
    expect(collected).toEqual([1]);
    expect(feed.isClosed()).toBe(true);
  });
});

describe("LiveFeed — nonblocking / backpressure isolation", () => {
  test("a never-consumed feed does not block authority.remember", async () => {
    const a = makeAuthority();
    // capacity:1 + overflow:drop-newest so the feed never closes itself but
    // also never grows unbounded; we never read from it.
    const feed = new LiveFeed(a, {
      since: 0,
      capacity: 1,
      overflow: "drop-newest",
    });
    await feed.start();

    // 1000 commits, no consumer. Authority must remain responsive and head
    // must advance to 1000.
    for (let i = 0; i < 1000; i++) {
      a.remember({ ...baseInput, slipId: `s${i}` });
    }
    await tick();
    expect(a.status().headRevision).toBe(1000);

    // Stats should reflect drops, not unbounded buffering.
    const stats = feed.stats();
    expect(stats.buffered).toBeLessThanOrEqual(1);
    expect(stats.dropped).toBeGreaterThan(0);

    feed.close();
  });

  test("overflow=close disconnects a slow subscriber without affecting the authority", async () => {
    const a = makeAuthority();
    const feed = new LiveFeed(a, {
      since: 0,
      capacity: 2,
      overflow: "close",
    });
    await feed.start();

    // Three live events with no consumer — third should trip the close
    // policy and disconnect the subscription.
    a.remember({ ...baseInput, slipId: "s1" });
    a.remember({ ...baseInput, slipId: "s2" });
    a.remember({ ...baseInput, slipId: "s3" });
    await tick();

    expect(feed.isClosed()).toBe(true);

    // Authority remains writable after the subscriber disconnects.
    const r = a.remember({ ...baseInput, slipId: "s4" });
    expect(r.event.revision).toBe(4);
    expect(a.status().headRevision).toBe(4);
  });

  test("throwing consumer cannot wedge other subscribers or the authority", async () => {
    const a = makeAuthority();

    // Bad subscriber: a raw authority.subscribe listener that throws. The
    // authority already isolates this in fanout(), but we re-verify here
    // alongside a LiveFeed running in parallel.
    a.subscribe(() => {
      throw new Error("boom from raw listener");
    });

    const feed = openLiveFeed(a, { since: 0 });

    a.remember({ ...baseInput, slipId: "s1" });
    a.remember({ ...baseInput, slipId: "s2" });
    await tick();

    const got = await collect(feed, 2);
    expect(got.map((e) => e.revision)).toEqual([1, 2]);
    expect(a.status().headRevision).toBe(2);

    feed.close();
  });

  test("multiple LiveFeeds receive independent ordered streams", async () => {
    const a = makeAuthority();
    a.remember({ ...baseInput, slipId: "s1" });

    const f1 = openLiveFeed(a, { since: 0 });
    const f2 = openLiveFeed(a, { since: 0 });

    const b1 = await collect(f1, 1);
    const b2 = await collect(f2, 1);
    expect(b1.map((e) => e.revision)).toEqual([1]);
    expect(b2.map((e) => e.revision)).toEqual([1]);

    a.remember({ ...baseInput, slipId: "s2" });
    a.remember({ ...baseInput, slipId: "s3" });
    await tick();

    const live1 = await collect(f1, 2);
    const live2 = await collect(f2, 2);
    expect(live1.map((e) => e.revision)).toEqual([2, 3]);
    expect(live2.map((e) => e.revision)).toEqual([2, 3]);

    f1.close();
    f2.close();
  });
});

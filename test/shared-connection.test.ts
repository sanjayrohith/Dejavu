/**
 * Tests for wave 2 slice D — SharedConnection (client-side feed manager).
 *
 * These tests don't touch the network. They simulate the live feed with an
 * in-process pub/sub harness (`makeFakeFeed`) that lets the test drive
 * authority head, emit live events, and force disconnects deterministically.
 *
 * Coverage matches the slice D contract:
 *
 *   - start(): catchUp + subscribe -> mirror reaches head, status becomes
 *     "live", a subsequent live event is locally recallable;
 *   - stop()/disconnect: events emitted while stopped do NOT land in the
 *     mirror; freshness goes stale against the last known head;
 *   - reconnect(): catchUp repairs the gap created by the disconnect;
 *   - out-of-order delivery during live: watermark advances only across the
 *     contiguous prefix (delegating to LocalMirror), and a later infill via
 *     reconnect/catchUp closes the gap.
 */

import { describe, expect, test } from "bun:test";
import { LocalMirror } from "../src/shared-mirror/mirror.ts";
import { SharedConnection } from "../src/shared-mirror/connection.ts";
import type {
  FetchEventsFn,
  SharedAuthorityStatus,
  SharedMemoryEvent,
  SharedRememberPayload,
} from "../src/shared-mirror/types.ts";
import type {
  SubscribeFn,
  Unsubscribe,
} from "../src/shared-mirror/connection.ts";

// ---------- helpers ----------

function makeRememberEvent(
  revision: number,
  overrides: Partial<SharedMemoryEvent<SharedRememberPayload>> = {},
): SharedMemoryEvent<SharedRememberPayload> {
  const slipId = overrides.payload?.slipId ?? `slip-${revision}`;
  return {
    revision,
    eventId: overrides.eventId ?? `evt-${revision}`,
    type: overrides.type ?? "remember",
    authority: overrides.authority ?? "auth-test",
    committedAt:
      overrides.committedAt ??
      new Date(1700000000000 + revision * 1000).toISOString(),
    payload: {
      slipId,
      text: overrides.payload?.text ?? `slip text for revision ${revision}`,
      tags: overrides.payload?.tags ?? [],
      authoredBy: overrides.payload?.authoredBy ?? "agent-a",
      sessionId: overrides.payload?.sessionId ?? "session-1",
      state: "kept",
    },
  };
}

/**
 * An in-process simulated authority + live feed.
 *
 *   commit(event):   make the event part of the durable backlog, fanout to
 *                    any currently-connected listener.
 *   commitOffline(): commit to the backlog only — listener is NOT notified.
 *                    Simulates events the live feed missed during a dead
 *                    transport window.
 *   listeners:       reflects whether anyone is currently subscribed.
 */
interface FakeFeed {
  fetchEvents: FetchEventsFn;
  fetchStatus: () => Promise<SharedAuthorityStatus>;
  subscribe: SubscribeFn;
  commit: (event: SharedMemoryEvent) => void;
  commitOffline: (event: SharedMemoryEvent) => void;
  emit: (event: SharedMemoryEvent) => void;
  head: () => number;
  events: () => SharedMemoryEvent[];
  listenerCount: () => number;
  /** Force the current subscription to detach (transport hiccup). */
  forceDisconnect: () => void;
}

function makeFakeFeed(authority = "auth-test"): FakeFeed {
  const backlog: SharedMemoryEvent[] = [];
  const listeners = new Set<(event: SharedMemoryEvent) => void>();

  const head = () => {
    let max = 0;
    for (const e of backlog) if (e.revision > max) max = e.revision;
    return max;
  };

  const fetchEvents: FetchEventsFn = async (since, limit) => {
    const slice = backlog
      .filter((e) => e.revision > since)
      .sort((a, b) => a.revision - b.revision)
      .slice(0, limit);
    return {
      ok: true,
      authority,
      headRevision: head(),
      events: slice,
    };
  };

  const fetchStatus = async (): Promise<SharedAuthorityStatus> => ({
    ok: true,
    authority,
    headRevision: head(),
  });

  const subscribe: SubscribeFn = (listener, _since): Unsubscribe => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const commit = (event: SharedMemoryEvent): void => {
    backlog.push(event);
    for (const l of listeners) l(event);
  };

  const commitOffline = (event: SharedMemoryEvent): void => {
    backlog.push(event);
    // no fanout
  };

  const emit = (event: SharedMemoryEvent): void => {
    // emit without commit — useful only if you want to test that the
    // listener path applies. Tests below mostly use commit().
    for (const l of listeners) l(event);
  };

  const forceDisconnect = (): void => {
    listeners.clear();
  };

  return {
    fetchEvents,
    fetchStatus,
    subscribe,
    commit,
    commitOffline,
    emit,
    head,
    events: () => backlog.slice(),
    listenerCount: () => listeners.size,
    forceDisconnect,
  };
}

function makeMirror() {
  return new LocalMirror({ path: ":memory:", authority: "auth-test" });
}

// ---------- tests ----------

describe("SharedConnection.start", () => {
  test("catches up backlog then subscribes; status becomes live", async () => {
    const mirror = makeMirror();
    const feed = makeFakeFeed();
    feed.commit(makeRememberEvent(1));
    feed.commit(makeRememberEvent(2));

    const conn = new SharedConnection({
      mirror,
      fetchEvents: feed.fetchEvents,
      subscribe: feed.subscribe,
      fetchStatus: feed.fetchStatus,
    });

    expect(conn.status).toBe("idle");
    const snap = await conn.start();
    expect(snap.status).toBe("live");
    expect(snap.mirrorRevision).toBe(2);
    expect(snap.knownHeadRevision).toBe(2);
    expect(snap.freshness.fresh).toBe(true);
    expect(feed.listenerCount()).toBe(1);

    await conn.stop();
    mirror.close();
  });

  test("live event after start lands in the mirror and is locally recallable", async () => {
    const mirror = makeMirror();
    const feed = makeFakeFeed();

    const conn = new SharedConnection({
      mirror,
      fetchEvents: feed.fetchEvents,
      subscribe: feed.subscribe,
    });
    await conn.start();
    expect(conn.status).toBe("live");

    // Live commit while connected.
    feed.commit(
      makeRememberEvent(1, {
        eventId: "evt-live-1",
        payload: {
          slipId: "slip-live",
          text: "live event prefers feature flags over forks",
          tags: ["live"],
          authoredBy: "agent-a",
          sessionId: "session-1",
          state: "kept",
        },
      }),
    );

    // Synchronous apply path means the recall sees it immediately.
    const hits = mirror.recallLocal({ query: "feature flags forks" });
    expect(hits.hits.length).toBe(1);
    expect(hits.hits[0]!.slipId).toBe("slip-live");

    const snap = conn.snapshot();
    expect(snap.mirrorRevision).toBe(1);
    expect(snap.knownHeadRevision).toBe(1);
    expect(snap.freshness.fresh).toBe(true);

    await conn.stop();
    mirror.close();
  });

  test("start() is idempotent while already live", async () => {
    const mirror = makeMirror();
    const feed = makeFakeFeed();
    const conn = new SharedConnection({
      mirror,
      fetchEvents: feed.fetchEvents,
      subscribe: feed.subscribe,
    });
    await conn.start();
    await conn.start(); // no-op
    expect(feed.listenerCount()).toBe(1);
    await conn.stop();
    mirror.close();
  });
});

describe("SharedConnection — disconnect produces stale freshness", () => {
  test("events committed while stopped do not land; freshness goes stale once head is known", async () => {
    const mirror = makeMirror();
    const feed = makeFakeFeed();
    feed.commit(makeRememberEvent(1));

    const conn = new SharedConnection({
      mirror,
      fetchEvents: feed.fetchEvents,
      subscribe: feed.subscribe,
      fetchStatus: feed.fetchStatus,
    });
    await conn.start();
    expect(conn.snapshot().freshness.fresh).toBe(true);

    await conn.stop();
    expect(conn.status).toBe("stopped");
    expect(feed.listenerCount()).toBe(0);

    // While stopped, peers commit events. Since we're not subscribed they
    // never reach the mirror.
    feed.commit(makeRememberEvent(2));
    feed.commit(makeRememberEvent(3));
    expect(mirror.getMirrorRevision()).toBe(1);

    // Pulling status surfaces that we are behind.
    const snap = await conn.refreshStatus();
    expect(snap.mirrorRevision).toBe(1);
    expect(snap.knownHeadRevision).toBe(3);
    expect(snap.freshness.fresh).toBe(false);
    expect(snap.freshness.behind).toBe(2);

    mirror.close();
  });

  test("reconnect catchUp heals the disconnected gap", async () => {
    const mirror = makeMirror();
    const feed = makeFakeFeed();
    feed.commit(makeRememberEvent(1));

    const conn = new SharedConnection({
      mirror,
      fetchEvents: feed.fetchEvents,
      subscribe: feed.subscribe,
      fetchStatus: feed.fetchStatus,
    });
    await conn.start();
    expect(mirror.getMirrorRevision()).toBe(1);

    // Simulate a transport hiccup: server force-drops the listener but
    // keeps committing events. The connection still thinks it's live;
    // those events never arrive.
    feed.forceDisconnect();
    feed.commitOffline(makeRememberEvent(2));
    feed.commitOffline(makeRememberEvent(3));
    feed.commitOffline(makeRememberEvent(4));

    // From the mirror's POV, watermark is still 1.
    expect(mirror.getMirrorRevision()).toBe(1);

    // Reconnect — should catchUp through fetchEvents and pull 2,3,4.
    const snap = await conn.reconnect();
    expect(snap.status).toBe("live");
    expect(snap.mirrorRevision).toBe(4);
    expect(snap.knownHeadRevision).toBe(4);
    expect(snap.freshness.fresh).toBe(true);
    expect(feed.listenerCount()).toBe(1);

    await conn.stop();
    mirror.close();
  });
});

describe("SharedConnection — out-of-order live events", () => {
  test("a live event arriving ahead of a gap does NOT advance watermark past the gap; reconnect heals it", async () => {
    const mirror = makeMirror();
    const feed = makeFakeFeed();
    feed.commit(makeRememberEvent(1));
    feed.commit(makeRememberEvent(2));

    const conn = new SharedConnection({
      mirror,
      fetchEvents: feed.fetchEvents,
      subscribe: feed.subscribe,
      fetchStatus: feed.fetchStatus,
    });
    await conn.start();
    expect(mirror.getMirrorRevision()).toBe(2);

    // Peers commit 3..9 OFFLINE — listener never sees them. Then event 10
    // is committed and fanned out live. This models a stretched live feed
    // where the transport delivers a newer event before the missing ones
    // can be backfilled (e.g., reorder across a partition).
    for (let r = 3; r <= 9; r++) feed.commitOffline(makeRememberEvent(r));
    feed.commit(
      makeRememberEvent(10, {
        eventId: "evt-future-10",
        payload: {
          slipId: "slip-future",
          text: "future event jumping the queue",
          tags: ["future"],
          authoredBy: "agent-a",
          sessionId: "session-1",
          state: "kept",
        },
      }),
    );

    // The live event was APPLIED (writer-style read-after-write semantics):
    // it is locally recallable...
    const hits = mirror.recallLocal({ query: "future jumping queue" });
    expect(hits.hits.some((h) => h.slipId === "slip-future")).toBe(true);
    expect(mirror.getHighestKnownRevision()).toBe(10);

    // ...but the contiguous watermark must NOT have crossed the 3..9 gap.
    expect(mirror.getMirrorRevision()).toBe(2);
    const stale = conn.snapshot();
    expect(stale.mirrorRevision).toBe(2);
    expect(stale.knownHeadRevision).toBe(10);
    expect(stale.freshness.fresh).toBe(false);
    expect(stale.freshness.behind).toBe(8);

    // Reconnect runs catchUp; that pulls revisions 3..9 (and 10 is a no-op
    // dedupe) and the watermark sweeps the buffered future event.
    const healed = await conn.reconnect();
    expect(healed.status).toBe("live");
    expect(healed.mirrorRevision).toBe(10);
    expect(healed.knownHeadRevision).toBe(10);
    expect(healed.freshness.fresh).toBe(true);

    await conn.stop();
    mirror.close();
  });

  test("knownHeadRevision tracks the highest revision learned from any source", async () => {
    const mirror = makeMirror();
    const feed = makeFakeFeed();
    // Seed contiguous 1..6 in the backlog so a live event at 7 advances
    // the watermark too — but a later out-of-order event at 20 only moves
    // knownHead, not the watermark.
    for (let r = 1; r <= 6; r++) feed.commitOffline(makeRememberEvent(r));

    const conn = new SharedConnection({
      mirror,
      fetchEvents: feed.fetchEvents,
      subscribe: feed.subscribe,
      fetchStatus: feed.fetchStatus,
    });
    await conn.start();
    // catchUp pulled 1..6.
    expect(conn.snapshot().knownHeadRevision).toBe(6);
    expect(mirror.getMirrorRevision()).toBe(6);

    // Live event sets the head and advances the watermark contiguously.
    feed.commit(makeRememberEvent(7));
    expect(conn.snapshot().knownHeadRevision).toBe(7);
    expect(mirror.getMirrorRevision()).toBe(7);

    // An out-of-order higher event still advances knownHead even though
    // the watermark won't move.
    feed.commit(makeRememberEvent(20, { eventId: "evt-20" }));
    expect(conn.snapshot().knownHeadRevision).toBe(20);
    // Watermark stalls at 7 because 8..19 are missing.
    expect(mirror.getMirrorRevision()).toBe(7);

    await conn.stop();
    mirror.close();
  });
});

describe("SharedConnection — error handling", () => {
  test("catchUp failure surfaces as error status and onError callback", async () => {
    const mirror = makeMirror();
    const errors: Array<{ phase: string; msg: string }> = [];
    const conn = new SharedConnection({
      mirror,
      fetchEvents: async () => {
        throw new Error("network down");
      },
      subscribe: () => () => {},
      onError: (err, phase) =>
        errors.push({
          phase,
          msg: err instanceof Error ? err.message : String(err),
        }),
    });
    const snap = await conn.start();
    expect(snap.status).toBe("error");
    expect(snap.lastError).toBe("network down");
    expect(errors.length).toBe(1);
    expect(errors[0]!.phase).toBe("catchUp");
    mirror.close();
  });

  test("subscribe failure tears down cleanly and reports error", async () => {
    const mirror = makeMirror();
    const conn = new SharedConnection({
      mirror,
      fetchEvents: async () => ({
        ok: true,
        authority: "auth-test",
        headRevision: 0,
        events: [],
      }),
      subscribe: () => {
        throw new Error("subscribe rejected");
      },
    });
    const snap = await conn.start();
    expect(snap.status).toBe("error");
    expect(snap.lastError).toBe("subscribe rejected");
    mirror.close();
  });
});

describe("SharedConnection.stop", () => {
  test("calling stop() before start() is a no-op that lands in 'stopped'", async () => {
    const mirror = makeMirror();
    const feed = makeFakeFeed();
    const conn = new SharedConnection({
      mirror,
      fetchEvents: feed.fetchEvents,
      subscribe: feed.subscribe,
    });
    const snap = await conn.stop();
    expect(snap.status).toBe("stopped");
    mirror.close();
  });

  test("events arriving after stop() are ignored by listener guard", async () => {
    const mirror = makeMirror();
    const feed = makeFakeFeed();
    const conn = new SharedConnection({
      mirror,
      fetchEvents: feed.fetchEvents,
      subscribe: feed.subscribe,
    });
    await conn.start();
    // We capture the listener by triggering a normal commit first.
    feed.commit(makeRememberEvent(1));
    expect(mirror.getMirrorRevision()).toBe(1);

    await conn.stop();
    // After stop, the fake feed's listener set is empty, so emit() is a
    // no-op. But if a misbehaving transport still fired the original
    // listener somehow, the connection's gen guard would drop it. We can't
    // easily reach the original listener after unsubscribe, so just assert
    // the subscriber count is zero.
    expect(feed.listenerCount()).toBe(0);
    mirror.close();
  });
});

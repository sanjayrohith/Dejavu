/**
 * Tests for the slice B local mirror.
 *
 * Focus areas from the contract
 * (docs/shared-memory-implementation-contract.md):
 *
 *  - apply/applyReceipt dedupe by revision and eventId
 *  - contiguous watermark: own ack at rev 85 with peer revs 23..84 missing
 *    must NOT advance mirrorRevision past 22
 *  - catchUp(fetchEvents) repairs the gap and pushes the watermark to head
 *  - freshness(headRevision) reflects mirror vs head
 *  - recallLocal sees the writer's own committed slip immediately (read-
 *    after-write), even before peer gap is repaired
 */

import { describe, expect, test } from "bun:test";
import { LocalMirror } from "../src/shared-mirror/mirror.ts";
import type {
  FetchEventsFn,
  SharedMemoryEvent,
  SharedRememberPayload,
  SharedWriteReceipt,
} from "../src/shared-mirror/types.ts";

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

function makeMirror() {
  return new LocalMirror({ path: ":memory:", authority: "auth-test" });
}

describe("LocalMirror.apply", () => {
  test("applies revisions 1..N in order and advances watermark", () => {
    const m = makeMirror();
    for (let r = 1; r <= 5; r++) {
      const res = m.apply(makeRememberEvent(r));
      expect(res.applied).toBe(true);
      expect(res.mirrorRevision).toBe(r);
    }
    expect(m.getMirrorRevision()).toBe(5);
    m.close();
  });

  test("dedupes duplicate revisions and duplicate eventIds", () => {
    const m = makeMirror();
    const ev = makeRememberEvent(1);
    const first = m.apply(ev);
    expect(first.applied).toBe(true);

    const dup = m.apply(ev);
    expect(dup.applied).toBe(false);
    expect(dup.mirrorRevision).toBe(1);

    // Same revision, different eventId — PRIMARY KEY conflict on revision.
    const sameRev = m.apply({ ...ev, eventId: "evt-different" });
    expect(sameRev.applied).toBe(false);

    // Same eventId, different revision — UNIQUE conflict on event_id.
    const sameEventId = m.apply({ ...ev, revision: 2 });
    expect(sameEventId.applied).toBe(false);
    expect(m.getMirrorRevision()).toBe(1);
    m.close();
  });

  test("applyReceipt applies the writer's own event for read-after-write", () => {
    const m = makeMirror();
    const ev = makeRememberEvent(1, {
      payload: {
        slipId: "slip-rwrite",
        text: "the user prefers tabs over spaces",
        tags: ["preference"],
        authoredBy: "agent-a",
        sessionId: "session-1",
        state: "kept",
      },
    });
    const receipt: SharedWriteReceipt<SharedRememberPayload> = {
      ok: true,
      id: "slip-rwrite",
      event: ev,
      receipt: {
        authority: ev.authority,
        revision: ev.revision,
        committedAt: ev.committedAt,
      },
      recallable: true,
    };

    const res = m.applyReceipt(receipt);
    expect(res.applied).toBe(true);
    expect(res.mirrorRevision).toBe(1);

    const hits = m.recallLocal({ query: "tabs spaces" });
    expect(hits.hits.length).toBe(1);
    expect(hits.hits[0]!.slipId).toBe("slip-rwrite");
    m.close();
  });
});

describe("LocalMirror watermark — contiguous prefix only", () => {
  test("own high revision before missing peer revisions does NOT advance watermark", () => {
    // This is the canonical contract scenario:
    //   - peers committed revisions 1..22 (mirror has them)
    //   - we acked our own write at revision 85 (writer applies via receipt)
    //   - revisions 23..84 are still missing
    // Expected: mirrorRevision stays at 22, not 85.
    const m = makeMirror();

    // Seed contiguous 1..22 from peers.
    for (let r = 1; r <= 22; r++) {
      m.apply(makeRememberEvent(r));
    }
    expect(m.getMirrorRevision()).toBe(22);

    // Writer's own ack arrives via SharedWriteReceipt.
    const ownEvent = makeRememberEvent(85, {
      eventId: "evt-own-85",
      payload: {
        slipId: "slip-own",
        text: "this is the writer's own committed memory",
        tags: ["own"],
        authoredBy: "agent-me",
        sessionId: "session-me",
        state: "kept",
      },
    });
    const ownReceipt: SharedWriteReceipt<SharedRememberPayload> = {
      ok: true,
      id: "slip-own",
      event: ownEvent,
      receipt: {
        authority: ownEvent.authority,
        revision: 85,
        committedAt: ownEvent.committedAt,
      },
      recallable: true,
    };
    const ownRes = m.applyReceipt(ownReceipt);

    // The event is APPLIED (recorded + materialized) but the contiguous
    // watermark must NOT advance past the gap at 23.
    expect(ownRes.applied).toBe(true);
    expect(ownRes.mirrorRevision).toBe(22);
    expect(m.getMirrorRevision()).toBe(22);
    expect(m.getHighestKnownRevision()).toBe(85);

    // Read-after-write: the writer's own slip is recallable locally
    // even though the watermark hasn't moved.
    const hits = m.recallLocal({ query: "writer committed memory" });
    expect(hits.hits.some((h) => h.slipId === "slip-own")).toBe(true);

    // freshness reflects that we are behind a known head.
    const f = m.freshness(85);
    expect(f.mirrorRevision).toBe(22);
    expect(f.headRevision).toBe(85);
    expect(f.behind).toBe(63);
    expect(f.fresh).toBe(false);

    m.close();
  });

  test("filling the gap from low end advances watermark past previously buffered own ack", () => {
    const m = makeMirror();
    for (let r = 1; r <= 22; r++) m.apply(makeRememberEvent(r));
    m.apply(makeRememberEvent(85, { eventId: "evt-own-85" }));
    expect(m.getMirrorRevision()).toBe(22);

    // Apply 23..84 via catchUp through an injected fetcher.
    const HEAD = 85;
    const events: SharedMemoryEvent[] = [];
    for (let r = 23; r <= 84; r++) events.push(makeRememberEvent(r));

    const fetchEvents: FetchEventsFn = async (since, limit) => {
      const slice = events
        .filter((e) => e.revision > since)
        .slice(0, limit);
      return {
        ok: true,
        authority: "auth-test",
        headRevision: HEAD,
        events: slice,
      };
    };

    return m
      .catchUp(fetchEvents, { batchSize: 25 })
      .then((res) => {
        // Watermark should now have crossed the gap AND swept up the
        // already-buffered own ack at 85.
        expect(res.mirrorRevision).toBe(85);
        expect(res.headRevision).toBe(85);
        // 62 events were missing (23..84 inclusive).
        expect(res.applied).toBe(62);
        expect(m.getMirrorRevision()).toBe(85);
        m.close();
      });
  });

  test("partial gap fill stops watermark at the last contiguous revision", () => {
    const m = makeMirror();
    for (let r = 1; r <= 10; r++) m.apply(makeRememberEvent(r));
    // Buffer some future events that leave a hole at 15.
    m.apply(makeRememberEvent(16));
    m.apply(makeRememberEvent(17));
    expect(m.getMirrorRevision()).toBe(10);

    // Fill 11..14 but NOT 15.
    for (let r = 11; r <= 14; r++) m.apply(makeRememberEvent(r));
    expect(m.getMirrorRevision()).toBe(14);

    // Drop in 15 and the watermark sweeps to 17.
    m.apply(makeRememberEvent(15));
    expect(m.getMirrorRevision()).toBe(17);

    m.close();
  });
});

describe("LocalMirror.catchUp", () => {
  test("repairs an entirely empty mirror from a multi-batch fetcher", async () => {
    const m = makeMirror();

    const HEAD = 50;
    const events: SharedMemoryEvent[] = [];
    for (let r = 1; r <= HEAD; r++) events.push(makeRememberEvent(r));

    let calls = 0;
    const fetchEvents: FetchEventsFn = async (since, limit) => {
      calls++;
      const slice = events
        .filter((e) => e.revision > since)
        .slice(0, limit);
      return {
        ok: true,
        authority: "auth-test",
        headRevision: HEAD,
        events: slice,
      };
    };

    const res = await m.catchUp(fetchEvents, { batchSize: 10 });
    expect(res.mirrorRevision).toBe(HEAD);
    expect(res.headRevision).toBe(HEAD);
    expect(res.applied).toBe(HEAD);
    // 5 fetches of 10 covers 50.
    expect(calls).toBeGreaterThanOrEqual(5);
    m.close();
  });

  test("catchUp is idempotent — second call applies nothing new", async () => {
    const m = makeMirror();
    const events: SharedMemoryEvent[] = [];
    for (let r = 1; r <= 5; r++) events.push(makeRememberEvent(r));
    const fetchEvents: FetchEventsFn = async (since, limit) => ({
      ok: true,
      authority: "auth-test",
      headRevision: 5,
      events: events.filter((e) => e.revision > since).slice(0, limit),
    });

    const a = await m.catchUp(fetchEvents);
    expect(a.applied).toBe(5);
    expect(a.mirrorRevision).toBe(5);

    const b = await m.catchUp(fetchEvents);
    expect(b.applied).toBe(0);
    expect(b.mirrorRevision).toBe(5);
    m.close();
  });

  test("stops cleanly when fetcher returns no events", async () => {
    const m = makeMirror();
    const fetchEvents: FetchEventsFn = async () => ({
      ok: true,
      authority: "auth-test",
      headRevision: 0,
      events: [],
    });
    const res = await m.catchUp(fetchEvents);
    expect(res.applied).toBe(0);
    expect(res.mirrorRevision).toBe(0);
    m.close();
  });
});

describe("LocalMirror.freshness", () => {
  test("fresh=true when mirror equals head", () => {
    const m = makeMirror();
    for (let r = 1; r <= 3; r++) m.apply(makeRememberEvent(r));
    const f = m.freshness(3);
    expect(f).toEqual({
      mirrorRevision: 3,
      headRevision: 3,
      behind: 3 - 3,
      fresh: true,
    });
    m.close();
  });

  test("behind=positive and fresh=false when mirror trails head", () => {
    const m = makeMirror();
    m.apply(makeRememberEvent(1));
    const f = m.freshness(10);
    expect(f.behind).toBe(9);
    expect(f.fresh).toBe(false);
    m.close();
  });

  test("behind clamps to 0 if mirror is somehow ahead of caller's head", () => {
    // Defensive — shouldn't happen in practice, but we don't want
    // negative behind values.
    const m = makeMirror();
    for (let r = 1; r <= 5; r++) m.apply(makeRememberEvent(r));
    const f = m.freshness(3);
    expect(f.behind).toBe(0);
    expect(f.fresh).toBe(true);
    m.close();
  });
});

describe("LocalMirror.recallLocal", () => {
  test("FTS ranks relevant slips", () => {
    const m = makeMirror();
    m.apply(
      makeRememberEvent(1, {
        payload: {
          slipId: "s1",
          text: "the user prefers tabs over spaces",
          tags: ["style"],
          authoredBy: "a",
          sessionId: "s",
          state: "kept",
        },
      }),
    );
    m.apply(
      makeRememberEvent(2, {
        payload: {
          slipId: "s2",
          text: "completely unrelated text",
          tags: [],
          authoredBy: "a",
          sessionId: "s",
          state: "kept",
        },
      }),
    );
    m.apply(
      makeRememberEvent(3, {
        payload: {
          slipId: "s3",
          text: "tabs are better than spaces in this repo",
          tags: ["style"],
          authoredBy: "a",
          sessionId: "s",
          state: "kept",
        },
      }),
    );

    const out = m.recallLocal({ query: "tabs spaces" });
    expect(out.hits.length).toBe(2);
    expect(out.hits[0]!.score).not.toBeNull();
    // BM25: more negative = better. First should be <= second.
    expect(out.hits[0]!.score!).toBeLessThanOrEqual(out.hits[1]!.score!);
    m.close();
  });

  test("tag filter ANDs across requested tags", () => {
    const m = makeMirror();
    m.apply(
      makeRememberEvent(1, {
        payload: {
          slipId: "a",
          text: "alpha",
          tags: ["x", "y"],
          authoredBy: "a",
          sessionId: "s",
          state: "kept",
        },
      }),
    );
    m.apply(
      makeRememberEvent(2, {
        payload: {
          slipId: "b",
          text: "beta",
          tags: ["x"],
          authoredBy: "a",
          sessionId: "s",
          state: "kept",
        },
      }),
    );

    const out = m.recallLocal({ tags: ["x", "y"] });
    expect(out.hits.length).toBe(1);
    expect(out.hits[0]!.slipId).toBe("a");
    m.close();
  });

  test("empty query falls back to most recent slips", () => {
    const m = makeMirror();
    for (let r = 1; r <= 3; r++) m.apply(makeRememberEvent(r));
    const out = m.recallLocal({});
    expect(out.hits.length).toBe(3);
    // Most recent (highest committedAt / revision) first.
    expect(out.hits[0]!.revision).toBe(3);
    expect(out.hits[1]!.revision).toBe(2);
    expect(out.hits[2]!.revision).toBe(1);
    m.close();
  });
});

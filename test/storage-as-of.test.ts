import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage.ts";
import { ulid } from "../src/ulid.ts";
import type { Handoff, Slip } from "../src/types.ts";

/**
 * Fixed instants, so "before" and "after" are unambiguous. Real
 * timestamps are ms since epoch; nothing here depends on their size.
 */
const T1 = 1_000;
const T2 = 2_000;
const T3 = 3_000;
const T4 = 4_000;

const SCOPE = "repo:test";

function slip(overrides: Partial<Slip> = {}): Slip {
  return {
    id: ulid(overrides.createdAt ?? T1),
    sessionId: "s",
    authoredBy: "test",
    scope: SCOPE,
    kind: "note",
    text: "the deployment pipeline needs a token",
    tags: [],
    state: "draft",
    createdAt: T1,
    keptAt: null,
    expiredAt: null,
    usedCount: 0,
    wrongCount: 0,
    ...overrides,
  };
}

function handoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: ulid(overrides.createdAt ?? T1),
    sessionId: `session-${Math.random()}`,
    authoredBy: "test",
    scope: SCOPE,
    summary: "prior work",
    kept: [],
    next: [],
    status: "active",
    automatic: false,
    createdAt: T1,
    resolvedAt: null,
    ...overrides,
  };
}

describe("searching as of a past instant", () => {
  test("memory written after the instant is not credited to it", () => {
    const s = new Storage({ path: ":memory:" });
    const early = slip({ createdAt: T1, state: "kept", keptAt: T1 });
    const late = slip({ createdAt: T3, state: "kept", keptAt: T3 });
    s.insertSlip(early);
    s.insertSlip(late);

    const then = s.searchFts("deployment", 10, SCOPE, false, undefined, T2);
    expect(then.map((hit) => hit.slip.id)).toEqual([early.id]);

    // Without a cutoff the same query sees both.
    expect(s.searchFts("deployment", 10, SCOPE).length).toBe(2);
    s.close();
  });

  test("memory expired after the instant was still visible at it", () => {
    const s = new Storage({ path: ":memory:" });
    const gone = slip({ createdAt: T1, state: "expired", keptAt: T1, expiredAt: T3 });
    s.insertSlip(gone);

    expect(s.searchFts("deployment", 10, SCOPE, false, undefined, T2)).toHaveLength(1);
    expect(s.searchFts("deployment", 10, SCOPE, false, undefined, T4)).toHaveLength(0);
    expect(s.searchFts("deployment", 10, SCOPE)).toHaveLength(0);
    s.close();
  });

  test("expiry is inclusive at the instant it happened", () => {
    const s = new Storage({ path: ":memory:" });
    s.insertSlip(slip({ createdAt: T1, state: "expired", keptAt: T1, expiredAt: T2 }));
    // Retrieval at exactly T2 ran after the expiry was written.
    expect(s.searchFts("deployment", 10, SCOPE, false, undefined, T2)).toHaveLength(0);
    s.close();
  });

  test("creation is inclusive at the instant it happened", () => {
    const s = new Storage({ path: ":memory:" });
    s.insertSlip(slip({ createdAt: T2, state: "kept", keptAt: T2 }));
    expect(s.searchFts("deployment", 10, SCOPE, false, undefined, T2)).toHaveLength(1);
    s.close();
  });

  test("a draft at the instant is still searchable, as it was then", () => {
    const s = new Storage({ path: ":memory:" });
    // Kept later, but recall has always searched drafts too.
    s.insertSlip(slip({ createdAt: T1, state: "kept", keptAt: T3 }));
    expect(s.searchFts("deployment", 10, SCOPE, false, undefined, T2)).toHaveLength(1);
    s.close();
  });
});

describe("listing kept memory as of a past instant", () => {
  test("memory kept after the instant was not kept at it", () => {
    const s = new Storage({ path: ":memory:" });
    s.insertSlip(slip({ createdAt: T1, state: "kept", keptAt: T3 }));

    expect(s.listKept(10, SCOPE, false, undefined, T2)).toHaveLength(0);
    expect(s.listKept(10, SCOPE, false, undefined, T4)).toHaveLength(1);
    s.close();
  });

  test("memory kept then expired is visible only in between", () => {
    const s = new Storage({ path: ":memory:" });
    s.insertSlip(slip({ createdAt: T1, state: "expired", keptAt: T2, expiredAt: T4 }));

    expect(s.listKept(10, SCOPE, false, undefined, T1)).toHaveLength(0);
    expect(s.listKept(10, SCOPE, false, undefined, T3)).toHaveLength(1);
    expect(s.listKept(10, SCOPE, false, undefined, T4)).toHaveLength(0);
    s.close();
  });

  test("trust-ordered selection honours the same cutoff", () => {
    const s = new Storage({ path: ":memory:" });
    const early = slip({ createdAt: T1, state: "kept", keptAt: T1, kind: "decision" });
    const late = slip({ createdAt: T3, state: "kept", keptAt: T3, kind: "decision" });
    s.insertSlip(early);
    s.insertSlip(late);

    const ids = s.listKeptByTrust(["decision"], 10, SCOPE, false, [], T2).map((row) => row.id);
    expect(ids).toEqual([early.id]);
    s.close();
  });
});

describe("supersession as of a past instant", () => {
  test("a supersession written later did not apply then", () => {
    const s = new Storage({ path: ":memory:" });
    const old = slip({ createdAt: T1, state: "kept", keptAt: T1, text: "use jest" });
    const current = slip({ createdAt: T3, state: "kept", keptAt: T3, text: "use vitest" });
    s.insertSlip(old);
    s.insertSlip(current);
    s.insertLink({ fromId: current.id, toId: old.id, kind: "supersedes", createdAt: T3 });

    expect(s.activeSuperseder(old.id, SCOPE, T2)).toBeNull();
    expect(s.activeSuperseder(old.id, SCOPE, T4)?.id).toBe(current.id);
    expect(s.activeSuperseder(old.id, SCOPE)?.id).toBe(current.id);
    s.close();
  });

  test("a superseder expired since does not resurrect as current", () => {
    const s = new Storage({ path: ":memory:" });
    const old = slip({ createdAt: T1, state: "kept", keptAt: T1, text: "use jest" });
    const current = slip({
      createdAt: T2,
      state: "expired",
      keptAt: T2,
      expiredAt: T3,
      text: "use vitest",
    });
    s.insertSlip(old);
    s.insertSlip(current);
    s.insertLink({ fromId: current.id, toId: old.id, kind: "supersedes", createdAt: T2 });

    expect(s.activeSuperseder(old.id, SCOPE, T2)?.id).toBe(current.id);
    expect(s.activeSuperseder(old.id, SCOPE, T4)).toBeNull();
    s.close();
  });
});

describe("anchored lookup as of a past instant", () => {
  test("an anchor written later did not exist then", () => {
    const s = new Storage({ path: ":memory:" });
    const row = slip({ createdAt: T3, state: "kept", keptAt: T3 });
    s.insertSlip(row);
    s.insertAnchor({
      slipId: row.id,
      path: "src/auth.ts",
      symbol: null,
      line: null,
      blobSha: "abc",
      commit: null,
      createdAt: T3,
    });

    expect(s.slipsAnchoredTo(["src/auth.ts"], SCOPE, false, 10, T2)).toHaveLength(0);
    expect(s.slipsAnchoredTo(["src/auth.ts"], SCOPE, false, 10, T4)).toHaveLength(1);
    s.close();
  });
});

describe("handoffs as of a past instant", () => {
  test("a handoff resolved since was still directing work then", () => {
    const s = new Storage({ path: ":memory:" });
    s.insertHandoff(handoff({ createdAt: T1, status: "completed", resolvedAt: T3 }));

    expect(s.latestHandoffs(5, SCOPE, false, T2)).toHaveLength(1);
    expect(s.latestHandoffs(5, SCOPE, false, T4)).toHaveLength(0);
    expect(s.latestHandoffs(5, SCOPE)).toHaveLength(0);
    s.close();
  });

  test("a handoff written later is not backdated into the packet", () => {
    const s = new Storage({ path: ":memory:" });
    s.insertHandoff(handoff({ createdAt: T3 }));
    expect(s.latestHandoffs(5, SCOPE, false, T2)).toHaveLength(0);
    s.close();
  });

  test("the per-session lookup honours the same reconstruction", () => {
    const s = new Storage({ path: ":memory:" });
    s.insertHandoff(
      handoff({ sessionId: "sess", createdAt: T1, status: "abandoned", resolvedAt: T3 }),
    );

    expect(s.getActiveHandoffBySession("sess", SCOPE, T2)).not.toBeNull();
    expect(s.getActiveHandoffBySession("sess", SCOPE, T4)).toBeNull();
    expect(s.getActiveHandoffBySession("sess", SCOPE)).toBeNull();
    s.close();
  });
});

describe("present-day behaviour is untouched", () => {
  test("omitting the cutoff matches passing null", () => {
    const s = new Storage({ path: ":memory:" });
    s.insertSlip(slip({ createdAt: T1, state: "kept", keptAt: T1 }));
    s.insertSlip(slip({ createdAt: T3, state: "expired", keptAt: T3, expiredAt: T4 }));

    expect(s.searchFts("deployment", 10, SCOPE).map((h) => h.slip.id)).toEqual(
      s.searchFts("deployment", 10, SCOPE, false, undefined, null).map((h) => h.slip.id),
    );
    expect(s.listKept(10, SCOPE).map((r) => r.id)).toEqual(
      s.listKept(10, SCOPE, false, undefined, null).map((r) => r.id),
    );
    s.close();
  });
});

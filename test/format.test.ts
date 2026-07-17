import { describe, expect, test } from "bun:test";
import { formatRecall } from "../src/format.ts";
import type { Link, RecallResult, Slip } from "../src/types.ts";

function slip(id: string, text: string): Slip {
  return {
    id,
    sessionId: "s",
    authoredBy: "test",
    scope: "repo:test",
    kind: "note",
    text,
    tags: [],
    state: "kept",
    createdAt: 1,
    keptAt: 2,
    expiredAt: null,
    usedCount: 0,
    wrongCount: 0,
  };
}

function result(id: string, text: string): RecallResult {
  return {
    query: "test runner",
    traceId: "trace-1",
    activeHandoff: null,
    hits: [{ slip: slip(id, text), score: -1, trust: "high", nextAgent: { read: "skip", score: 0, reasons: [], penalties: [] } }],
    readFirst: [],
  };
}

describe("formatRecall", () => {
  test("explains evidence trust and emits compact provenance", () => {
    const text = formatRecall(result("memory", "use vitest"));
    expect(text).toContain("high — repeatedly useful");
    expect(text).not.toContain("the user recorded this");
    expect(text).toContain("source: test · scope: repo:test · session: s");
    expect(text).toContain("used/wrong: 0/0");
  });

  test("old active handoffs are advisory, not silent directives", () => {
    const r = result("memory", "use vitest");
    r.activeHandoff = {
      id: "handoff",
      sessionId: "old",
      authoredBy: "test",
      scope: "repo:test",
      summary: "deploy immediately",
      kept: [],
      next: [],
      status: "active",
      automatic: false,
      createdAt: Date.now() - 4 * 24 * 60 * 60 * 1000,
      resolvedAt: null,
    };
    expect(formatRecall(r)).toContain("stale handoff · 4d old · verify before acting");
  });

  test("surfaces outgoing supersedes and contradicts links", () => {
    const linksFrom: Link[] = [
      { fromId: "new", toId: "old", kind: "supersedes", createdAt: 3 },
      { fromId: "new", toId: "wrong", kind: "contradicts", createdAt: 4 },
    ];
    const text = formatRecall(result("new", "use vitest now"), {
      linksFrom: () => linksFrom,
      linksTo: () => [],
    });

    expect(text).toContain("links: supersedes old; contradicts wrong");
  });

  test("surfaces incoming superseded-by and contradicted-by links", () => {
    const linksTo: Link[] = [
      { fromId: "new", toId: "old", kind: "supersedes", createdAt: 3 },
      { fromId: "correction", toId: "old", kind: "contradicts", createdAt: 4 },
    ];
    const text = formatRecall(result("old", "use jest"), {
      linksFrom: () => [],
      linksTo: () => linksTo,
    });

    expect(text).toContain("links: superseded by new; contradicted by correction");
  });
});

import { describe, expect, test } from "bun:test";
import { rankForNextAgent } from "../src/next-agent.ts";
import type { RecallHit, Slip } from "../src/types.ts";

const slip = (id: string, text: string): Slip => ({
  id,
  text,
  tags: [],
  state: "kept",
  sessionId: "s",
  authoredBy: "test",
  scope: "repo:test",
  kind: "note",
  createdAt: Date.now(),
  keptAt: Date.now(),
  expiredAt: null,
  usedCount: 0,
  wrongCount: 0,
});

const hit = (id: string, text: string, trust: RecallHit["trust"] = "high"): RecallHit => ({
  slip: slip(id, text),
  score: trust === "high" ? -10 : trust === "medium" ? -3 : 0,
  trust,
});

describe("rankForNextAgent", () => {
  test("surfaces query-relevant decisions and security invariants", () => {
    const ranked = rankForNextAgent("dejavu deploy", [
      hit("a", "Random: lunch was tacos."),
      hit("b", "Decision: Dejavu deploys must stay local-first."),
      hit("c", "Security invariant: Access before public Worker deploys with bindings."),
    ]);

    expect(ranked.readFirst.map((h) => h.slip.id)).toEqual(["b", "c"]);
    expect(ranked.readFirst.find((h) => h.slip.id === "c")?.nextAgent.reasons).toContain("security_invariant");
  });

  test("penalizes stale plans and random notes", () => {
    const ranked = rankForNextAgent("dejavu feature", [
      hit("old", "Old plan: release the feature immediately."),
      hit("new", "New decision: defer until go/no-go eval passes."),
      hit("r", "Random: coffee changed."),
    ]);

    expect(ranked.hits.find((h) => h.slip.id === "old")?.nextAgent.read).toBe("skip");
    expect(ranked.hits.find((h) => h.slip.id === "r")?.nextAgent.read).toBe("skip");
    expect(ranked.readFirst.map((h) => h.slip.id)).toEqual(["new"]);
  });

  test("does not force filler", () => {
    const ranked = rankForNextAgent("security", [
      hit("a", "Security invariant: secrets before code."),
      hit("b", "Routine docs note: README wording."),
      hit("c", "Random: tacos."),
    ]);

    expect(ranked.readFirst.map((h) => h.slip.id)).toEqual(["a"]);
  });
});

import { describe, expect, test } from "bun:test";
import { DUPLICATE_THRESHOLD, RELATED_THRESHOLD, findNearDuplicate, textOverlap } from "../src/duplicates.ts";
import { ulid } from "../src/ulid.ts";
import type { Slip } from "../src/types.ts";

function makeSlip(text: string, overrides: Partial<Slip> = {}): Slip {
  const now = Date.now();
  return {
    id: ulid(now),
    sessionId: "test-session",
    authoredBy: "test",
    scope: "repo:test",
    kind: "note",
    text,
    tags: [],
    state: "kept",
    createdAt: now,
    keptAt: now,
    expiredAt: null,
    usedCount: 0,
    wrongCount: 0,
    ...overrides,
  };
}

describe("textOverlap", () => {
  test("identical text overlaps completely", () => {
    expect(textOverlap("always deploy with wrangler", "always deploy with wrangler")).toBe(1);
  });

  test("unrelated sentences overlap near zero", () => {
    expect(textOverlap("the database uses SQLite", "coffee tastes better cold")).toBe(0);
  });

  test("a paraphrase overlaps but not completely", () => {
    const overlap = textOverlap(
      "always deploy with wrangler, never the dashboard",
      "we always deploy with wrangler",
    );
    expect(overlap).toBeGreaterThan(RELATED_THRESHOLD);
    expect(overlap).toBeLessThan(1);
  });

  test("shared stopwords alone never register as overlap", () => {
    expect(textOverlap("we should use the new one", "we should use the old one")).toBeLessThan(RELATED_THRESHOLD);
  });

  test("empty text has no signal to overlap with", () => {
    expect(textOverlap("", "always deploy with wrangler")).toBe(0);
    expect(textOverlap("the a an", "always deploy with wrangler")).toBe(0);
  });
});

describe("findNearDuplicate", () => {
  test("returns null with no candidates", () => {
    expect(findNearDuplicate([], "always deploy with wrangler")).toBeNull();
  });

  test("returns null when nothing clears the related threshold", () => {
    const candidates = [{ slip: makeSlip("coffee tastes better cold") }];
    expect(findNearDuplicate(candidates, "always deploy with wrangler")).toBeNull();
  });

  test("classifies near-identical text as duplicate", () => {
    const existing = makeSlip("always deploy with wrangler, never the dashboard");
    const found = findNearDuplicate([{ slip: existing }], "always deploy with wrangler, never the dashboard");
    expect(found?.slip.id).toBe(existing.id);
    expect(found?.kind).toBe("duplicate");
    expect(found?.overlap).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
  });

  test("classifies partial overlap as related, not duplicate", () => {
    const existing = makeSlip("always deploy with wrangler, never the dashboard");
    const found = findNearDuplicate([{ slip: existing }], "deploy staging with wrangler now, not the dashboard");
    expect(found?.kind).toBe("related");
    expect(found?.overlap).toBeGreaterThanOrEqual(RELATED_THRESHOLD);
    expect(found?.overlap).toBeLessThan(DUPLICATE_THRESHOLD);
  });

  test("picks the strongest candidate among several", () => {
    const weak = makeSlip("deploy staging with wrangler");
    const strong = makeSlip("always deploy with wrangler, never the dashboard");
    const found = findNearDuplicate(
      [{ slip: weak }, { slip: strong }],
      "always deploy with wrangler, never the dashboard",
    );
    expect(found?.slip.id).toBe(strong.id);
  });
});

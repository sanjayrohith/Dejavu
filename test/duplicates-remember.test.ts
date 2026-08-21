import { beforeEach, describe, expect, test } from "bun:test";
import { Dejavu, memory } from "../src/index.ts";
import { _resetSessionForTesting } from "../src/lifecycle.ts";

beforeEach(() => {
  _resetSessionForTesting();
  process.env.DEJAVU_SESSION = "dup-test-session";
  process.env.DEJAVU_AUTHOR = "dup-test-agent";
});

describe("Dejavu.findDuplicate", () => {
  test("finds a duplicate of already-kept text", () => {
    const d = memory();
    const original = d.remember("always deploy with wrangler, never the dashboard");
    d.keep([original.id], { noChainRollup: true });

    const found = d.findDuplicate("always deploy with wrangler, never the dashboard");
    expect(found?.slip.id).toBe(original.id);
    expect(found?.kind).toBe("duplicate");
    d.close();
  });

  test("returns null when nothing overlaps", () => {
    const d = memory();
    d.keep([d.remember("the database uses SQLite").id], { noChainRollup: true });
    expect(d.findDuplicate("coffee tastes better cold")).toBeNull();
    d.close();
  });

  test("returns null for empty or whitespace-only text", () => {
    const d = memory();
    d.keep([d.remember("always deploy with wrangler").id], { noChainRollup: true });
    expect(d.findDuplicate("")).toBeNull();
    expect(d.findDuplicate("   ")).toBeNull();
    d.close();
  });

  test("ignores drafts — only kept memory counts as already known", () => {
    const d = memory();
    // Deliberately never kept: this is the same session still thinking,
    // not standing memory a new write should be compared against.
    d.remember("always deploy with wrangler, never the dashboard");
    expect(d.findDuplicate("always deploy with wrangler, never the dashboard")).toBeNull();
    d.close();
  });

  test("ignores expired memory", () => {
    const d = memory();
    const original = d.remember("always deploy with wrangler, never the dashboard");
    d.keep([original.id], { noChainRollup: true });
    d.forget(original.id);
    expect(d.findDuplicate("always deploy with wrangler, never the dashboard")).toBeNull();
    d.close();
  });

  test("never matches across repository scope, same as recall", () => {
    const d = new Dejavu({ path: ":memory:", skipGc: true, scope: "repo:alpha" });
    const theirs = d.remember("always deploy with wrangler, never the dashboard", { scope: "repo:beta" });
    d.keep([theirs.id], { noChainRollup: true });
    expect(d.findDuplicate("always deploy with wrangler, never the dashboard")).toBeNull();
    d.close();
  });

  test("does not surface a memory the caller already linked via supersedes", () => {
    const d = memory();
    const original = d.remember("always deploy with wrangler, never the dashboard");
    d.keep([original.id], { noChainRollup: true });

    const found = d.findDuplicate("always deploy with wrangler, never the dashboard");
    expect(found?.slip.id).toBe(original.id);

    const next = d.remember("always deploy with wrangler, never the dashboard", {
      links: [{ toId: original.id, kind: "supersedes" }],
    });
    expect(next.id).not.toBe(original.id);
    d.close();
  });
});

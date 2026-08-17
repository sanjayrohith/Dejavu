import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dejavu, memory } from "../src/index.ts";
import { dispatch, newDispatchState } from "../src/mcp.ts";
import { _resetSessionForTesting } from "../src/lifecycle.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * An in-memory instance whose anchor root is a scratch directory, so an
 * empty-query recall orients against a known-empty tree rather than
 * against the working tree of whoever runs the suite.
 */
function isolated(): Dejavu {
  const anchorRoot = mkdtempSync(join(tmpdir(), "dejavu-mcp-root-"));
  dirs.push(anchorRoot);
  return new Dejavu({ path: ":memory:", skipGc: true, anchorRoot });
}

beforeEach(() => {
  _resetSessionForTesting();
  process.env.DEJAVU_SESSION = "mcp-test-session";
  process.env.DEJAVU_AUTHOR = "mcp-test-agent";
});

describe("MCP dispatch — recall(empty) orients", () => {
  test("blank query returns active handoff + kept memory", () => {
    const d = isolated();
    // Plant a handoff in a prior session
    d.handoff({
      sessionId: "prior",
      authoredBy: "prior-agent",
      summary: "prior session signoff: shipped the auth refactor",
    });
    const a = d.remember("kept fact A");
    const b = d.remember("kept fact B");
    d.keep([a.id, b.id], { noChainRollup: true });

    const state = newDispatchState();
    const r = dispatch(d, state, "recall", { query: "  " });
    expect(r.text).toContain("active handoff");
    expect(r.text).toContain("auth refactor");
    expect(r.text).toContain("kept fact A");
    expect(r.text).toContain("kept fact B");
    d.close();
  });

  test("blank query sections memory instead of listing it flat", () => {
    const d = isolated();
    d.keep([d.remember("always deploy with wrangler", { kind: "decision" }).id], {
      noChainRollup: true,
    });
    d.keep([d.remember("blocked on the canary rollout", { kind: "wip" }).id], {
      noChainRollup: true,
    });

    const r = dispatch(d, newDispatchState(), "recall", { query: "" });
    expect(r.text).toContain("# must know");
    expect(r.text).toContain("# active work");
    d.close();
  });

  test("a kind filter still gets the flat recents view it asked for", () => {
    const d = isolated();
    d.keep([d.remember("always deploy with wrangler", { kind: "decision" }).id], {
      noChainRollup: true,
    });

    const r = dispatch(d, newDispatchState(), "recall", { query: "", kinds: ["decision"] });
    expect(r.text).toContain("recall(recents)");
    expect(r.text).toContain("always deploy with wrangler");
    d.close();
  });

  test("blank query with empty DB still returns gracefully", () => {
    const d = isolated();
    const state = newDispatchState();
    const r = dispatch(d, state, "recall", { query: "" });
    expect(r.text).toContain("nothing kept yet");
    d.close();
  });

  test("blank query flips recallSeen", () => {
    const d = memory();
    const state = newDispatchState();
    expect(state.recallSeen).toBe(false);
    dispatch(d, state, "recall", { query: "" });
    expect(state.recallSeen).toBe(true);
    d.close();
  });
});

describe("MCP dispatch — prior-handoff nudge on remember/handoff", () => {
  test("first remember when no recall has happened includes nudge", () => {
    const d = memory();
    d.handoff({
      sessionId: "prior",
      authoredBy: "prior-agent",
      summary: "shipped the migration",
    });
    const state = newDispatchState();
    const r = dispatch(d, state, "remember", { text: "a new note" });
    expect(r.text).toContain("drafted slip");
    expect(r.text).toContain("you have not called recall yet");
    expect(r.text).toContain("shipped the migration");
    d.close();
  });

  test("nudge disappears after first recall", () => {
    const d = memory();
    d.handoff({
      sessionId: "prior",
      authoredBy: "prior-agent",
      summary: "shipped the migration",
    });
    const state = newDispatchState();
    dispatch(d, state, "recall", { query: "anything" });
    const r = dispatch(d, state, "remember", { text: "a new note" });
    expect(r.text).not.toContain("you have not called recall yet");
    d.close();
  });

  test("no nudge when there is no prior handoff in DB", () => {
    const d = memory();
    const state = newDispatchState();
    const r = dispatch(d, state, "remember", { text: "first note ever" });
    expect(r.text).toContain("drafted slip");
    expect(r.text).not.toContain("you have not called recall yet");
    d.close();
  });

  test("nudge truncates long handoff summaries", () => {
    const d = memory();
    const longSummary = "x".repeat(500);
    d.handoff({
      sessionId: "prior",
      authoredBy: "prior-agent",
      summary: longSummary,
    });
    const state = newDispatchState();
    const r = dispatch(d, state, "remember", { text: "a note" });
    expect(r.text).toContain("…");
    // First 240 chars of x's appear, but not all 500
    expect(r.text.split("x").length - 1).toBeLessThan(500);
    d.close();
  });
});

describe("MCP dispatch — memory quality tools", () => {
  test("remember accepts kind and supersedes links", () => {
    const d = memory();
    const old = d.remember("use jest");
    const state = newDispatchState();
    const response = dispatch(d, state, "remember", {
      text: "Decision: use vitest",
      kind: "decision",
      keep: true,
      supersedes: [old.id],
    });
    expect(response.isError).toBeUndefined();
    const freshId = response.text.match(/slip (\w+)/)?.[1];
    const fresh = freshId ? d.get(freshId) : null;
    expect(fresh?.kind).toBe("decision");
    expect(d.storage.linksFrom(fresh!.id)[0]?.toId).toBe(old.id);
    d.close();
  });

  test("assess closes the recall receipt loop", () => {
    const d = memory();
    const state = newDispatchState();
    const recalled = dispatch(d, state, "recall", { query: "missing" });
    const traceId = recalled.text.match(/recall receipt (\w+)/)?.[1];
    expect(traceId).toBeTruthy();
    const assessed = dispatch(d, state, "assess", { traceId, assessment: "no_memory_needed" });
    expect(assessed.text).toContain("assessed no_memory_needed");
    expect(d.recallReport().noMemoryNeeded).toBe(1);
    d.close();
  });

  test("resolve_handoff removes it from subsequent recall", () => {
    const d = memory();
    const handoff = d.handoff({ summary: "old directive" });
    const state = newDispatchState();
    expect(dispatch(d, state, "resolve_handoff", { id: handoff.id }).isError).toBeUndefined();
    expect(d.recall("directive").activeHandoff).toBeNull();
    d.close();
  });
});

describe("MCP dispatch — signal tool", () => {
  test("signal used bumps usedCount", () => {
    const d = memory();
    const s = d.remember("a fact");
    const state = newDispatchState();
    const r = dispatch(d, state, "signal", { id: s.id, action: "used" });
    expect(r.text).toContain("used (+1)");
    expect(d.get(s.id)!.usedCount).toBe(1);
    d.close();
  });

  test("signal wrong bumps wrongCount", () => {
    const d = memory();
    const s = d.remember("a sketchy fact");
    const state = newDispatchState();
    const r = dispatch(d, state, "signal", { id: s.id, action: "wrong" });
    expect(r.text).toContain("wrong (+1)");
    expect(d.get(s.id)!.wrongCount).toBe(1);
    d.close();
  });

  test("signal forget expires the slip", () => {
    const d = memory();
    const s = d.remember("delete me");
    d.keep([s.id], { noChainRollup: true });
    expect(d.get(s.id)!.state).toBe("kept");

    const state = newDispatchState();
    const r = dispatch(d, state, "signal", { id: s.id, action: "forget" });
    expect(r.text).toContain("forgotten");
    expect(d.get(s.id)!.state).toBe("expired");
    d.close();
  });

  test("signal forget on already-expired slip is graceful", () => {
    const d = memory();
    const s = d.remember("transient");
    d.forget(s.id);
    const state = newDispatchState();
    const r = dispatch(d, state, "signal", { id: s.id, action: "forget" });
    expect(r.text).toContain("not forgotten");
    expect(r.isError).toBeUndefined();
    d.close();
  });

  test("signal with missing id is an error", () => {
    const d = memory();
    const state = newDispatchState();
    const r = dispatch(d, state, "signal", { action: "used" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("id is required");
    d.close();
  });

  test("signal with unknown action is an error", () => {
    const d = memory();
    const s = d.remember("ok");
    const state = newDispatchState();
    const r = dispatch(d, state, "signal", { id: s.id, action: "wat" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("unknown action");
    d.close();
  });
});

describe("MCP dispatch — backwards compatibility", () => {
  test("remember+keep still rolls chain-shaped into handoff", () => {
    const d = memory();
    const state = newDispatchState();
    const r = dispatch(d, state, "remember", {
      text: "Decision: use Bun for new TS libs",
      keep: true,
    });
    expect(r.text).toContain("kept slip");
    expect(r.text).toContain("auto-rolled into session handoff");
    d.close();
  });

  test("handoff with summary works through dispatch", () => {
    const d = memory();
    d.remember("draft a");
    d.remember("draft b");
    const state = newDispatchState();
    const r = dispatch(d, state, "handoff", {
      summary: "did the thing",
      next: ["next thing"],
    });
    expect(r.text).toContain("handoff");
    expect(r.text).toContain("2 slip(s) kept");
    d.close();
  });

  test("unknown tool name returns error", () => {
    const d = memory();
    const state = newDispatchState();
    const r = dispatch(d, state, "nonexistent", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("unknown tool");
    d.close();
  });

  test("library-thrown errors bubble up as isError", () => {
    const d = memory();
    const state = newDispatchState();
    const r = dispatch(d, state, "remember", { text: "" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("error:");
    d.close();
  });
});

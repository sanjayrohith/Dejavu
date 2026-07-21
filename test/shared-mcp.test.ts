import { describe, expect, test } from "bun:test";
import { dispatchShared, type SharedDispatchClient } from "../src/shared-mcp.ts";

function client(): SharedDispatchClient {
  return {
    async remember() { return { id: "slip-1", receipt: { revision: 7 }, recallable: true }; },
    async handoff() { return { id: "handoff-1", receipt: { revision: 8 }, recallable: true }; },
    async signal() { return { id: "signal-1", receipt: { revision: 9 }, recallable: true }; },
    async delete() { return { id: "slip-1", receipt: { revision: 10 }, recallable: true }; },
    recall(query) { return query === "hit" ? { mirrorRevision: 7, latestHandoff: { summary: "continue work", revision: 6, next: ["test"] }, hits: [{ slipId: "slip-1", text: "Decision: use feed", tags: ["decision"], revision: 7, authoredBy: "a", committedAt: "now", usedCount: 1 }] } : { mirrorRevision: 7, hits: [] }; },
    status() { return { status: "live", mirrorRevision: 7, knownHeadRevision: 7, freshness: { behind: 0, fresh: true } }; },
    async refreshStatus() { return { status: "live", mirrorRevision: 7, knownHeadRevision: 9, freshness: { behind: 2, fresh: false } }; },
  };
}

describe("shared MCP dispatch", () => {
  test("remember reports committed receipt revision", async () => {
    const result = await dispatchShared(client(), "remember", { text: "x" });
    expect(result.text).toContain("committed revision 7");
    expect(result.text).toContain("immediately recallable");
  });
  test("recall renders mirror hits and revision", async () => {
    const result = await dispatchShared(client(), "recall", { query: "hit" });
    expect(result.text).toContain("mirror revision 7");
    expect(result.text).toContain("Decision: use feed");
    expect(result.text).toContain("latest shared handoff");
    expect(result.text).toContain("used=1");
  });
  test("handoff, signal and delete report committed revision", async () => {
    expect((await dispatchShared(client(), "handoff", { summary: "next" })).text).toContain("revision 8");
    expect((await dispatchShared(client(), "signal", { id: "slip-1", action: "used" })).text).toContain("revision 9");
    const deleted = await dispatchShared(client(), "delete", { id: "slip-1" });
    expect(deleted.text).toContain("revision 10");
    expect(deleted.text).toContain("removed from synced local copies");
    expect(deleted.text).toContain("redacted from server replay history");
  });
  test("status communicates stale/freshness explicitly", async () => {
    const result = await dispatchShared(client(), "status", {});
    expect(result.text).toContain("behind 2");
    expect(result.text).toContain("fresh=false");
  });
});

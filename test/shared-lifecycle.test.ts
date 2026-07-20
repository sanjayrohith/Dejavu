import { describe, expect, test } from "bun:test";
import { SharedAuthority } from "../src/shared-authority/index.ts";
import { LocalMirror } from "../src/shared-mirror/index.ts";

function setup() { let n=0; return { authority: new SharedAuthority({ authority: "owner", newEventId: () => `e-${++n}` }), mirror: new LocalMirror({ path: ":memory:", authority: "owner" }) }; }
const input = { slipId: "s1", text: "important preference memory", tags: ["preference"], authoredBy: "agent", sessionId: "session" };

describe("shared lifecycle mirror materialization", () => {
  test("handoff materializes and surfaces with recall", () => {
    const { authority, mirror } = setup();
    mirror.applyReceipt(authority.remember(input));
    const h = authority.handoff({ handoffId: "h1", summary: "continue auth refactor", next: ["run tests"], kept: ["s1"], authoredBy: "agent", sessionId: "session" });
    mirror.apply(h.event);
    const result = mirror.recallLocal({ query: "preference" });
    expect(result.latestHandoff?.summary).toBe("continue auth refactor");
    expect(result.latestHandoff?.next).toEqual(["run tests"]);
    mirror.close();
  });

  test("used and wrong signals annotate local recalled slips", () => {
    const { authority, mirror } = setup();
    mirror.applyReceipt(authority.remember(input));
    mirror.apply(authority.signal({ signalId: "sig1", slipId: "s1", action: "used", authoredBy: "a", sessionId: "s" }).event);
    mirror.apply(authority.signal({ signalId: "sig2", slipId: "s1", action: "wrong", authoredBy: "a", sessionId: "s" }).event);
    const hit = mirror.recallLocal({ query: "important" }).hits[0]!;
    expect(hit.usedCount).toBe(1);
    expect(hit.wrongCount).toBe(1);
    mirror.close();
  });

  test("forget signal excludes expired slip from recall without removing its local row", () => {
    const { authority, mirror } = setup();
    mirror.applyReceipt(authority.remember(input));
    expect(mirror.recallLocal({ query: "important" }).hits).toHaveLength(1);
    mirror.apply(authority.signal({ signalId: "sig3", slipId: "s1", action: "forget", authoredBy: "a", sessionId: "s" }).event);
    expect(mirror.recallLocal({ query: "important" }).hits).toHaveLength(0);
    const row = mirror.db.prepare("SELECT state FROM mirror_slips WHERE slip_id = ?").get("s1") as { state: string };
    expect(row.state).toBe("expired");
    mirror.close();
  });

  test("delete removes slip content from local SQLite and FTS while retaining a deletion change", () => {
    const { authority, mirror } = setup();
    mirror.applyReceipt(authority.remember(input));
    const deleted = authority.delete({ deleteId: "delete-1", slipId: "s1", authoredBy: "a", sessionId: "s" });
    mirror.apply(deleted.event);
    expect(deleted.event.type).toBe("delete");
    expect(mirror.recallLocal({ query: "important" }).hits).toHaveLength(0);
    expect(mirror.db.prepare("SELECT * FROM mirror_slips WHERE slip_id = ?").get("s1")).toBeNull();
    const events = mirror.db.prepare("SELECT type FROM mirror_events ORDER BY revision").all() as Array<{ type: string }>;
    expect(events.map((event) => event.type)).toEqual(["remember", "delete"]);
    mirror.close();
  });

  test("a new local copy can catch up across purged history without recreating deleted content", async () => {
    const { authority } = setup();
    authority.remember(input);
    authority.delete({ deleteId: "delete-1", slipId: "s1", authoredBy: "a", sessionId: "s" });
    const newMirror = new LocalMirror({ path: ":memory:", authority: "owner" });
    await newMirror.catchUp(async (since, limit) => {
      const result = authority.eventsSince(since, limit);
      return result;
    });
    expect(newMirror.getMirrorRevision()).toBe(2);
    expect(newMirror.recallLocal({ query: "important" }).hits).toHaveLength(0);
    expect(newMirror.db.prepare("SELECT * FROM mirror_slips WHERE slip_id = ?").get("s1")).toBeNull();
    newMirror.close();
  });
});

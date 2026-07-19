import { describe, expect, test } from "bun:test";
import {
  SharedAuthority,
  createHandlers,
  handleAuthorityRequest,
} from "../src/shared-authority/index.ts";

function makeAuthority(opts?: { authority?: string }) {
  let n = 0;
  let t = 1_700_000_000_000;
  return new SharedAuthority({
    authority: opts?.authority ?? "test-authority",
    now: () => t++,
    newEventId: () => `EVT${(++n).toString().padStart(4, "0")}`,
  });
}

const baseInput = {
  slipId: "slip-1",
  text: "the user prefers pnpm",
  tags: ["pref"],
  authoredBy: "agent-a",
  sessionId: "sess-1",
};

describe("SharedAuthority — Slice A", () => {
  test("remember returns a receipt with the canonical event included", () => {
    const a = makeAuthority();
    const r = a.remember(baseInput);

    expect(r.ok).toBe(true);
    expect(r.recallable).toBe(true);
    expect(r.id).toBe("slip-1");
    expect(r.event.type).toBe("remember");
    expect(r.event.authority).toBe("test-authority");
    expect(r.event.revision).toBe(1);
    expect(r.event.eventId).toBe("EVT0001");
    expect(r.event.payload.slipId).toBe("slip-1");
    expect(r.event.payload.state).toBe("kept");
    expect(r.event.payload.tags).toEqual(["pref"]);
    expect(r.receipt.revision).toBe(1);
    expect(r.receipt.authority).toBe("test-authority");
    expect(typeof r.receipt.committedAt).toBe("string");
    // included event matches the receipt summary
    expect(r.event.revision).toBe(r.receipt.revision);
    expect(r.event.committedAt).toBe(r.receipt.committedAt);
  });

  test("revisions are monotonic per authority", () => {
    const a = makeAuthority();
    const r1 = a.remember({ ...baseInput, slipId: "s1" });
    const r2 = a.remember({ ...baseInput, slipId: "s2" });
    const r3 = a.remember({ ...baseInput, slipId: "s3" });
    expect(r1.event.revision).toBe(1);
    expect(r2.event.revision).toBe(2);
    expect(r3.event.revision).toBe(3);
    expect(a.status().headRevision).toBe(3);
  });

  test("delete commits a replayable deletion and redacts prior remembered content", () => {
    const a = makeAuthority();
    a.remember(baseInput);
    const deleted = a.delete({ deleteId: "del-1", slipId: "slip-1", authoredBy: "agent-a", sessionId: "sess-1" });
    expect(deleted.id).toBe("slip-1");
    expect(deleted.event.type).toBe("delete");
    expect(deleted.event.payload.slipId).toBe("slip-1");
    expect(deleted.receipt.revision).toBe(2);
    const history = a.eventsSince(0).events;
    expect(history.map((event) => event.type)).toEqual(["remember", "delete"]);
    expect(history[0]!.payload).toEqual({ slipId: "slip-1", purged: true });
    expect(JSON.stringify(history)).not.toContain("the user prefers pnpm");
  });

  test("eventsSince returns ascending events after the cursor", () => {
    const a = makeAuthority();
    a.remember({ ...baseInput, slipId: "s1" });
    a.remember({ ...baseInput, slipId: "s2" });
    a.remember({ ...baseInput, slipId: "s3" });

    const all = a.eventsSince(0);
    expect(all.ok).toBe(true);
    expect(all.headRevision).toBe(3);
    expect(all.events.map((e) => e.revision)).toEqual([1, 2, 3]);

    const tail = a.eventsSince(1);
    expect(tail.events.map((e) => e.revision)).toEqual([2, 3]);

    const empty = a.eventsSince(3);
    expect(empty.events).toEqual([]);
    expect(empty.headRevision).toBe(3);
  });

  test("eventsSince honors limit", () => {
    const a = makeAuthority();
    for (let i = 0; i < 5; i++) {
      a.remember({ ...baseInput, slipId: `s${i}` });
    }
    const out = a.eventsSince(0, 2);
    expect(out.events.map((e) => e.revision)).toEqual([1, 2]);
    expect(out.headRevision).toBe(5);
  });

  test("status mirrors headRevision", () => {
    const a = makeAuthority();
    expect(a.status()).toEqual({
      ok: true,
      authority: "test-authority",
      headRevision: 0,
    });
    a.remember({ ...baseInput, slipId: "x" });
    expect(a.status().headRevision).toBe(1);
  });

  test("input validation rejects bad writes", () => {
    const a = makeAuthority();
    expect(() => a.remember({ ...baseInput, slipId: "" })).toThrow();
    expect(() => a.remember({ ...baseInput, text: "  " })).toThrow();
    expect(() => a.remember({ ...baseInput, authoredBy: "" })).toThrow();
    expect(() => a.remember({ ...baseInput, sessionId: "" })).toThrow();
  });

  test("listener fanout is fire-and-forget and never blocks commit", async () => {
    const a = makeAuthority();
    const seen: number[] = [];
    a.subscribe((e) => {
      // Throwing listener must not wedge the authority.
      if (e.revision === 2) throw new Error("boom");
      seen.push(e.revision);
    });

    // remember returns synchronously even though listeners are async.
    const r1 = a.remember({ ...baseInput, slipId: "a" });
    const r2 = a.remember({ ...baseInput, slipId: "b" });
    const r3 = a.remember({ ...baseInput, slipId: "c" });

    expect(r1.event.revision).toBe(1);
    expect(r2.event.revision).toBe(2);
    expect(r3.event.revision).toBe(3);

    // Drain the microtask queue.
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toEqual([1, 3]);
    expect(a.status().headRevision).toBe(3);
  });

  test("unsubscribe stops further deliveries", async () => {
    const a = makeAuthority();
    const seen: number[] = [];
    const off = a.subscribe((e) => seen.push(e.revision));
    a.remember({ ...baseInput, slipId: "a" });
    await new Promise((r) => setTimeout(r, 0));
    off();
    a.remember({ ...baseInput, slipId: "b" });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([1]);
  });
});

describe("authority function API", () => {
  test("createHandlers exposes remember/eventsSince/status", () => {
    const a = makeAuthority();
    const api = createHandlers(a);
    const r = api.remember(baseInput);
    expect(r.event.revision).toBe(1);
    expect(api.status().headRevision).toBe(1);
    expect(api.eventsSince(0).events).toHaveLength(1);
  });
});

describe("handleAuthorityRequest — fetch-like adapter", () => {
  test("POST /v1/shared/remember commits and returns receipt JSON", async () => {
    const a = makeAuthority();
    const req = new Request("http://x/v1/shared/remember", {
      method: "POST",
      body: JSON.stringify(baseInput),
      headers: { "content-type": "application/json" },
    });
    const res = await handleAuthorityRequest(a, req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; event: { revision: number } };
    expect(body.ok).toBe(true);
    expect(body.event.revision).toBe(1);
  });

  test("POST /v1/shared/delete commits a replayable deletion", async () => {
    const a = makeAuthority();
    a.remember(baseInput);
    const res = await handleAuthorityRequest(a, new Request("http://x/v1/shared/delete", {
      method: "POST",
      body: JSON.stringify({ deleteId: "del-1", slipId: "slip-1", authoredBy: "agent-a", sessionId: "sess-1" }),
      headers: { "content-type": "application/json" },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { event: { type: string; revision: number } };
    expect(body.event.type).toBe("delete");
    expect(body.event.revision).toBe(2);
  });

  test("GET /v1/shared/events?since=N returns ascending events", async () => {
    const a = makeAuthority();
    a.remember({ ...baseInput, slipId: "s1" });
    a.remember({ ...baseInput, slipId: "s2" });
    const req = new Request("http://x/v1/shared/events?since=1", { method: "GET" });
    const res = await handleAuthorityRequest(a, req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      headRevision: number;
      events: Array<{ revision: number }>;
    };
    expect(body.headRevision).toBe(2);
    expect(body.events.map((e) => e.revision)).toEqual([2]);
  });

  test("GET /v1/shared/status returns head", async () => {
    const a = makeAuthority();
    a.remember(baseInput);
    const req = new Request("http://x/v1/shared/status", { method: "GET" });
    const res = await handleAuthorityRequest(a, req);
    const body = (await res.json()) as { headRevision: number; authority: string };
    expect(body.headRevision).toBe(1);
    expect(body.authority).toBe("test-authority");
  });

  test("unknown route returns 404", async () => {
    const a = makeAuthority();
    const req = new Request("http://x/v1/shared/nope", { method: "GET" });
    const res = await handleAuthorityRequest(a, req);
    expect(res.status).toBe(404);
  });

  test("wrong method returns 405", async () => {
    const a = makeAuthority();
    const req = new Request("http://x/v1/shared/remember", { method: "GET" });
    const res = await handleAuthorityRequest(a, req);
    expect(res.status).toBe(405);
  });

  test("malformed JSON body returns 400", async () => {
    const a = makeAuthority();
    const req = new Request("http://x/v1/shared/remember", {
      method: "POST",
      body: "not-json",
      headers: { "content-type": "application/json" },
    });
    const res = await handleAuthorityRequest(a, req);
    expect(res.status).toBe(400);
  });
});

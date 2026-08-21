import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/storage.ts";
import { ulid } from "../src/ulid.ts";
import type { Slip } from "../src/types.ts";

function makeSlip(overrides: Partial<Slip> = {}): Slip {
  const now = Date.now();
  return {
    id: ulid(now),
    sessionId: "test-session",
    authoredBy: "test",
    scope: "repo:test",
    kind: "note",
    text: "hello world",
    tags: [],
    state: "draft",
    createdAt: now,
    keptAt: null,
    expiredAt: null,
    usedCount: 0,
    wrongCount: 0,
    ...overrides,
  };
}

describe("Storage", () => {
  test("migrates pre-scope databases without assigning them to the current repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "dejavu-storage-"));
    const path = join(dir, "legacy.db");
    const old = new Database(path, { create: true });
    old.exec(`
      CREATE TABLE slips (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, authored_by TEXT NOT NULL,
        text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL,
        created_at INTEGER NOT NULL, kept_at INTEGER, expired_at INTEGER,
        used_count INTEGER NOT NULL DEFAULT 0, wrong_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE handoffs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, authored_by TEXT NOT NULL,
        summary TEXT NOT NULL, kept TEXT NOT NULL DEFAULT '[]', next TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
      INSERT INTO slips VALUES ('old', 's', 'agent', 'legacy text', '[]', 'kept', 1, 1, NULL, 0, 0);
      INSERT INTO handoffs VALUES ('h', 's', 'agent', 'legacy handoff', '[]', '[]', 1);
    `);
    old.close();

    const migrated = new Storage({ path });
    expect(migrated.getSlip("old")?.scope).toBe("legacy:global");
    expect(migrated.latestHandoffs(1)[0]?.scope).toBe("legacy:global");
    expect(migrated.searchFts("legacy", 10, "repo:new")).toEqual([]);
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("health checks SQLite and FTS coverage", () => {
    const s = new Storage({ path: ":memory:" });
    s.insertSlip(makeSlip());
    expect(s.health()).toEqual({ ok: true, sqlite: "ok", slips: 1, indexed: 1 });
    s.close();
  });

  test("insert + get round-trip", () => {
    const s = new Storage({ path: ":memory:" });
    const slip = makeSlip({ text: "decided to use SQLite" });
    s.insertSlip(slip);
    const got = s.getSlip(slip.id);
    expect(got).not.toBeNull();
    expect(got!.text).toBe("decided to use SQLite");
    expect(got!.state).toBe("draft");
    s.close();
  });

  test("FTS5 search ranks relevant slips", () => {
    const s = new Storage({ path: ":memory:" });
    s.insertSlip(makeSlip({ text: "the user prefers tabs over spaces" }));
    s.insertSlip(makeSlip({ text: "completely unrelated text" }));
    s.insertSlip(makeSlip({ text: "tabs are better than spaces in this repo" }));

    const hits = s.searchFts("tabs spaces", 10);
    expect(hits.length).toBe(2);
    // best score (most negative) is first
    expect(hits[0]!.score).toBeLessThanOrEqual(hits[1]!.score);
  });

  test("FTS5 and recents can be constrained to one repository scope", () => {
    const s = new Storage({ path: ":memory:" });
    const alpha = makeSlip({ text: "shared marker alpha", scope: "repo:alpha", state: "kept", keptAt: 1 });
    const beta = makeSlip({ text: "shared marker beta", scope: "repo:beta", state: "kept", keptAt: 2 });
    const global = makeSlip({ text: "shared marker global preference", scope: "global", state: "kept", keptAt: 3 });
    s.insertSlip(alpha);
    s.insertSlip(beta);
    s.insertSlip(global);

    expect(new Set(s.searchFts("shared marker", 10, "repo:alpha").map((hit) => hit.slip.id))).toEqual(new Set([alpha.id, global.id]));
    expect(new Set(s.listKept(10, "repo:alpha").map((slip) => slip.id))).toEqual(new Set([alpha.id, global.id]));
    s.close();
  });

  test("legacy global rows require an explicit compatibility opt-in", () => {
    const s = new Storage({ path: ":memory:" });
    const legacy = makeSlip({ text: "legacy marker", scope: "legacy:global", state: "kept", keptAt: 1 });
    s.insertSlip(legacy);
    expect(s.searchFts("legacy marker", 10, "repo:alpha")).toEqual([]);
    expect(s.searchFts("legacy marker", 10, "repo:alpha", true).map((hit) => hit.slip.id)).toEqual([legacy.id]);
    s.close();
  });

  test("FTS5 excludes expired slips", () => {
    const s = new Storage({ path: ":memory:" });
    const a = makeSlip({ text: "kept memory" });
    const b = makeSlip({ text: "expired memory" });
    s.insertSlip(a);
    s.insertSlip(b);
    s.setState(b.id, "expired", Date.now());

    const hits = s.searchFts("memory", 10);
    expect(hits.length).toBe(1);
    expect(hits[0]!.slip.id).toBe(a.id);
    s.close();
  });

  test("setState transitions draft -> kept and stamps keptAt", () => {
    const s = new Storage({ path: ":memory:" });
    const slip = makeSlip();
    s.insertSlip(slip);

    const at = Date.now() + 1000;
    s.setState(slip.id, "kept", at);
    const got = s.getSlip(slip.id)!;
    expect(got.state).toBe("kept");
    expect(got.keptAt).toBe(at);
    expect(got.expiredAt).toBeNull();
    s.close();
  });

  test("gcDrafts expires only old drafts", () => {
    const s = new Storage({ path: ":memory:" });
    const old = makeSlip({ createdAt: 1000, text: "old" });
    const recent = makeSlip({ createdAt: Date.now(), text: "recent" });
    const oldKept = makeSlip({
      createdAt: 1000,
      state: "kept",
      keptAt: 1500,
      text: "old kept",
    });
    s.insertSlip(old);
    s.insertSlip(recent);
    s.insertSlip(oldKept);

    const expired = s.gcDrafts(Date.now() - 1000, Date.now());
    expect(expired).toBe(1);
    expect(s.getSlip(old.id)!.state).toBe("expired");
    expect(s.getSlip(recent.id)!.state).toBe("draft");
    expect(s.getSlip(oldKept.id)!.state).toBe("kept");
    s.close();
  });

  test("handoffs are unique per session", () => {
    const s = new Storage({ path: ":memory:" });
    const now = Date.now();
    s.insertHandoff({
      id: ulid(now),
      sessionId: "S1",
      authoredBy: "test",
      scope: "repo:test",
      summary: "first",
      kept: [],
      next: [],
      status: "active",
      automatic: false,
      createdAt: now,
      resolvedAt: null,
    });
    expect(() =>
      s.insertHandoff({
        id: ulid(now + 1),
        sessionId: "S1",
        authoredBy: "test",
        scope: "repo:test",
        summary: "second",
        kept: [],
        next: [],
        status: "active",
        automatic: false,
        createdAt: now + 1,
        resolvedAt: null,
      }),
    ).toThrow();
    s.close();
  });

  test("links round-trip", () => {
    const s = new Storage({ path: ":memory:" });
    const a = makeSlip({ text: "old" });
    const b = makeSlip({ text: "new" });
    s.insertSlip(a);
    s.insertSlip(b);
    s.insertLink({
      fromId: b.id,
      toId: a.id,
      kind: "supersedes",
      createdAt: Date.now(),
    });
    const links = s.linksFrom(b.id);
    expect(links.length).toBe(1);
    expect(links[0]!.kind).toBe("supersedes");
    expect(links[0]!.toId).toBe(a.id);

    const incoming = s.linksTo(a.id);
    expect(incoming.length).toBe(1);
    expect(incoming[0]!.kind).toBe("supersedes");
    expect(incoming[0]!.fromId).toBe(b.id);
    s.close();
  });
});

describe("selecting kept memory by trust", () => {
  /** Kept `kept_at` ms apart so recency ordering is unambiguous. */
  function kept(overrides: Partial<Slip> = {}): Slip {
    return makeSlip({ state: "kept", keptAt: Date.now(), ...overrides });
  }

  test("repeatedly-useful memory outranks memory kept a moment ago", () => {
    const s = new Storage({ path: ":memory:" });
    const proven = kept({ text: "the team uses bun", kind: "preference", usedCount: 4, keptAt: 1_000 });
    const fresh = kept({ text: "scratch note from just now", kind: "preference", keptAt: 9_000 });
    s.insertSlip(proven);
    s.insertSlip(fresh);

    const ordered = s.listKeptByTrust(["preference"], 10, "repo:test");
    expect(ordered.map((slip) => slip.id)).toEqual([proven.id, fresh.id]);
    s.close();
  });

  test("disputed memory sinks below everything else", () => {
    const s = new Storage({ path: ":memory:" });
    const disputed = kept({ text: "disputed claim", kind: "decision", usedCount: 9, wrongCount: 1, keptAt: 9_000 });
    const plain = kept({ text: "ordinary decision", kind: "decision", keptAt: 1_000 });
    s.insertSlip(disputed);
    s.insertSlip(plain);

    const ordered = s.listKeptByTrust(["decision"], 10, "repo:test");
    expect(ordered.map((slip) => slip.id)).toEqual([plain.id, disputed.id]);
    s.close();
  });

  test("recency only breaks ties between equally trusted memory", () => {
    const s = new Storage({ path: ":memory:" });
    const older = kept({ text: "older decision", kind: "decision", keptAt: 1_000 });
    const newer = kept({ text: "newer decision", kind: "decision", keptAt: 9_000 });
    s.insertSlip(older);
    s.insertSlip(newer);

    const ordered = s.listKeptByTrust(["decision"], 10, "repo:test");
    expect(ordered.map((slip) => slip.id)).toEqual([newer.id, older.id]);
    s.close();
  });

  test("filters by kind and skips drafts and expired memory", () => {
    const s = new Storage({ path: ":memory:" });
    const wanted = kept({ text: "a real pitfall", kind: "pitfall" });
    s.insertSlip(wanted);
    s.insertSlip(kept({ text: "a note", kind: "note" }));
    s.insertSlip(makeSlip({ text: "an unkept pitfall", kind: "pitfall" }));
    s.insertSlip(kept({ text: "an expired pitfall", kind: "pitfall", state: "expired" }));

    const ordered = s.listKeptByTrust(["pitfall"], 10, "repo:test");
    expect(ordered.map((slip) => slip.id)).toEqual([wanted.id]);
    s.close();
  });

  test("excluded ids do not come back, so sections cannot repeat a slip", () => {
    const s = new Storage({ path: ":memory:" });
    const first = kept({ text: "first decision", kind: "decision", keptAt: 9_000 });
    const second = kept({ text: "second decision", kind: "decision", keptAt: 1_000 });
    s.insertSlip(first);
    s.insertSlip(second);

    const ordered = s.listKeptByTrust(["decision"], 10, "repo:test", false, [first.id]);
    expect(ordered.map((slip) => slip.id)).toEqual([second.id]);
    s.close();
  });

  test("respects repository scope and deliberate global memory", () => {
    const s = new Storage({ path: ":memory:" });
    const mine = kept({ text: "scoped decision", kind: "decision" });
    const global = kept({ text: "global preference", kind: "decision", scope: "global" });
    s.insertSlip(mine);
    s.insertSlip(global);
    s.insertSlip(kept({ text: "another repo's decision", kind: "decision", scope: "repo:elsewhere" }));

    const ids = s.listKeptByTrust(["decision"], 10, "repo:test").map((slip) => slip.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(mine.id);
    expect(ids).toContain(global.id);
    s.close();
  });

  test("a zero budget selects nothing rather than everything", () => {
    const s = new Storage({ path: ":memory:" });
    s.insertSlip(kept({ kind: "decision" }));
    expect(s.listKeptByTrust(["decision"], 0, "repo:test")).toEqual([]);
    s.close();
  });
});

describe("scopeCounts", () => {
  test("empty database reports no scopes", () => {
    const s = new Storage({ path: ":memory:" });
    expect(s.scopeCounts()).toEqual([]);
    s.close();
  });

  test("breaks slip state down per scope, unlike counts()", () => {
    const s = new Storage({ path: ":memory:" });
    s.insertSlip(makeSlip({ scope: "repo:alpha", state: "kept", keptAt: Date.now() }));
    s.insertSlip(makeSlip({ scope: "repo:alpha", state: "draft" }));
    s.insertSlip(makeSlip({ scope: "repo:alpha", state: "expired", expiredAt: Date.now() }));
    s.insertSlip(makeSlip({ scope: "repo:beta", state: "kept", keptAt: Date.now() }));

    const rows = s.scopeCounts();
    expect(rows.map((r) => r.scope)).toEqual(["repo:alpha", "repo:beta"]); // sorted

    const alpha = rows.find((r) => r.scope === "repo:alpha")!;
    expect(alpha).toMatchObject({ slips: 3, kept: 1, drafts: 1, expired: 1 });

    const beta = rows.find((r) => r.scope === "repo:beta")!;
    expect(beta).toMatchObject({ slips: 1, kept: 1, drafts: 0, expired: 0 });
    s.close();
  });

  test("counts handoffs and active handoffs per scope", () => {
    const s = new Storage({ path: ":memory:" });
    const now = Date.now();
    s.insertSlip(makeSlip({ scope: "repo:alpha", state: "kept", keptAt: now }));
    s.insertHandoff({
      id: ulid(now),
      sessionId: "S1",
      authoredBy: "test",
      scope: "repo:alpha",
      summary: "active one",
      kept: [],
      next: [],
      status: "active",
      automatic: false,
      createdAt: now,
      resolvedAt: null,
    });
    s.insertHandoff({
      id: ulid(now + 1),
      sessionId: "S2",
      authoredBy: "test",
      scope: "repo:alpha",
      summary: "resolved one",
      kept: [],
      next: [],
      status: "completed",
      automatic: false,
      createdAt: now,
      resolvedAt: now,
    });

    const alpha = s.scopeCounts().find((r) => r.scope === "repo:alpha")!;
    expect(alpha.handoffs).toBe(2);
    expect(alpha.activeHandoffs).toBe(1);
    s.close();
  });

  test("counts distinct anchored slips per scope, not anchor rows", () => {
    const s = new Storage({ path: ":memory:" });
    const now = Date.now();
    const slip = makeSlip({ scope: "repo:alpha", state: "kept", keptAt: now });
    s.insertSlip(slip);
    // Two anchors on the same slip must still count as one anchored slip.
    s.insertAnchor({ slipId: slip.id, path: "src/a.ts", symbol: null, line: null, blobSha: "x".repeat(40), commit: null, createdAt: now });
    s.insertAnchor({ slipId: slip.id, path: "src/b.ts", symbol: null, line: null, blobSha: "y".repeat(40), commit: null, createdAt: now });
    s.insertSlip(makeSlip({ scope: "repo:beta", state: "kept", keptAt: now }));

    const rows = s.scopeCounts();
    expect(rows.find((r) => r.scope === "repo:alpha")!.anchoredSlips).toBe(1);
    expect(rows.find((r) => r.scope === "repo:beta")!.anchoredSlips).toBe(0);
    s.close();
  });
});

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

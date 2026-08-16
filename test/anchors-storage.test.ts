import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/storage.ts";
import type { Anchor, Slip } from "../src/types.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function slip(id: string, scope = "repo:alpha", state: Slip["state"] = "kept"): Slip {
  return {
    id,
    sessionId: "session-1",
    authoredBy: "test",
    scope,
    kind: "pitfall",
    text: `memory ${id}`,
    tags: [],
    state,
    createdAt: Date.now(),
    keptAt: state === "kept" ? Date.now() : null,
    expiredAt: state === "expired" ? Date.now() : null,
    usedCount: 0,
    wrongCount: 0,
  };
}

function anchor(slipId: string, path: string, symbol: string | null = null): Anchor {
  return {
    slipId,
    path,
    symbol,
    line: null,
    blobSha: "a".repeat(40),
    commit: "c".repeat(40),
    createdAt: Date.now(),
  };
}

function store(): Storage {
  return new Storage({ path: ":memory:" });
}

describe("anchor storage", () => {
  test("round-trips an anchor", () => {
    const s = store();
    s.insertSlip(slip("slip-1"));
    s.insertAnchor({ ...anchor("slip-1", "src/auth.ts", "login"), line: 42 });
    expect(s.anchorsFor("slip-1")).toEqual([
      {
        slipId: "slip-1",
        path: "src/auth.ts",
        symbol: "login",
        line: 42,
        blobSha: "a".repeat(40),
        commit: "c".repeat(40),
        createdAt: expect.any(Number),
      },
    ]);
    s.close();
  });

  test("a null symbol round-trips as null, not empty string", () => {
    const s = store();
    s.insertSlip(slip("slip-1"));
    s.insertAnchor(anchor("slip-1", "src/auth.ts"));
    expect(s.anchorsFor("slip-1")[0]!.symbol).toBeNull();
    s.close();
  });

  test("re-anchoring the same path and symbol is a no-op", () => {
    const s = store();
    s.insertSlip(slip("slip-1"));
    s.insertAnchor(anchor("slip-1", "src/auth.ts"));
    s.insertAnchor({ ...anchor("slip-1", "src/auth.ts"), blobSha: "b".repeat(40) });
    const stored = s.anchorsFor("slip-1");
    expect(stored).toHaveLength(1);
    // Anchors are immutable — the second write must not rewrite the captured id.
    expect(stored[0]!.blobSha).toBe("a".repeat(40));
    s.close();
  });

  test("the same path with different symbols are distinct anchors", () => {
    const s = store();
    s.insertSlip(slip("slip-1"));
    s.insertAnchor(anchor("slip-1", "src/auth.ts", "login"));
    s.insertAnchor(anchor("slip-1", "src/auth.ts", "logout"));
    expect(s.anchorsFor("slip-1")).toHaveLength(2);
    s.close();
  });

  test("batch lookup groups by slip and omits unanchored slips", () => {
    const s = store();
    s.insertSlip(slip("slip-1"));
    s.insertSlip(slip("slip-2"));
    s.insertSlip(slip("slip-3"));
    s.insertAnchor(anchor("slip-1", "src/auth.ts"));
    s.insertAnchor(anchor("slip-1", "src/session.ts"));
    s.insertAnchor(anchor("slip-2", "src/auth.ts"));
    const grouped = s.anchorsForSlips(["slip-1", "slip-2", "slip-3"]);
    expect(grouped.get("slip-1")).toHaveLength(2);
    expect(grouped.get("slip-2")).toHaveLength(1);
    expect(grouped.has("slip-3")).toBe(false);
    s.close();
  });

  test("batch lookup on an empty list does not query", () => {
    const s = store();
    expect(s.anchorsForSlips([]).size).toBe(0);
    s.close();
  });
});

describe("reverse lookup by path", () => {
  test("finds slips anchored to any of the given paths", () => {
    const s = store();
    s.insertSlip(slip("slip-1"));
    s.insertSlip(slip("slip-2"));
    s.insertAnchor(anchor("slip-1", "src/auth.ts"));
    s.insertAnchor(anchor("slip-2", "src/billing.ts"));
    const found = s.slipsAnchoredTo(["src/auth.ts"], "repo:alpha");
    expect(found.map((f) => f.id)).toEqual(["slip-1"]);
    s.close();
  });

  test("does not cross repository scopes", () => {
    const s = store();
    s.insertSlip(slip("slip-alpha", "repo:alpha"));
    s.insertSlip(slip("slip-beta", "repo:beta"));
    s.insertAnchor(anchor("slip-alpha", "src/auth.ts"));
    s.insertAnchor(anchor("slip-beta", "src/auth.ts"));
    expect(s.slipsAnchoredTo(["src/auth.ts"], "repo:alpha").map((f) => f.id)).toEqual([
      "slip-alpha",
    ]);
    s.close();
  });

  test("includes deliberate global slips, matching recall", () => {
    const s = store();
    s.insertSlip(slip("slip-global", "global"));
    s.insertAnchor(anchor("slip-global", "src/auth.ts"));
    expect(s.slipsAnchoredTo(["src/auth.ts"], "repo:alpha").map((f) => f.id)).toEqual([
      "slip-global",
    ]);
    s.close();
  });

  test("excludes expired slips", () => {
    const s = store();
    s.insertSlip(slip("slip-1", "repo:alpha", "expired"));
    s.insertAnchor(anchor("slip-1", "src/auth.ts"));
    expect(s.slipsAnchoredTo(["src/auth.ts"], "repo:alpha")).toEqual([]);
    s.close();
  });

  test("returns each slip once even with several matching anchors", () => {
    const s = store();
    s.insertSlip(slip("slip-1"));
    s.insertAnchor(anchor("slip-1", "src/auth.ts"));
    s.insertAnchor(anchor("slip-1", "src/session.ts"));
    expect(s.slipsAnchoredTo(["src/auth.ts", "src/session.ts"], "repo:alpha")).toHaveLength(1);
    s.close();
  });

  test("an empty path list matches nothing", () => {
    const s = store();
    expect(s.slipsAnchoredTo([], "repo:alpha")).toEqual([]);
    s.close();
  });

  test("lists every anchored slip in scope", () => {
    const s = store();
    s.insertSlip(slip("slip-1"));
    s.insertSlip(slip("slip-2"));
    s.insertAnchor(anchor("slip-1", "src/auth.ts"));
    expect(s.listAnchoredSlips("repo:alpha").map((f) => f.id)).toEqual(["slip-1"]);
    s.close();
  });
});

describe("migration", () => {
  test("adds the anchors table to a database created without it", () => {
    const dir = mkdtempSync(join(tmpdir(), "dejavu-migrate-"));
    dirs.push(dir);
    const path = join(dir, "legacy.db");

    // A pre-anchor database: slips exist, the anchors table does not.
    const legacy = new Database(path, { create: true });
    legacy.exec(`CREATE TABLE slips (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, authored_by TEXT NOT NULL,
      text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL CHECK (state IN ('draft','kept','expired')),
      created_at INTEGER NOT NULL, kept_at INTEGER, expired_at INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0, wrong_count INTEGER NOT NULL DEFAULT 0)`);
    legacy.exec(
      `INSERT INTO slips (id, session_id, authored_by, text, state, created_at)
       VALUES ('old-1', 'session-0', 'legacy', 'memory written before anchors', 'kept', 1)`,
    );
    legacy.close();

    const s = new Storage({ path });
    // The pre-existing memory is untouched and the new table is usable.
    expect(s.getSlip("old-1")?.text).toBe("memory written before anchors");
    expect(s.anchorsFor("old-1")).toEqual([]);
    s.insertAnchor(anchor("old-1", "src/auth.ts"));
    expect(s.anchorsFor("old-1")).toHaveLength(1);
    s.close();
  });
});

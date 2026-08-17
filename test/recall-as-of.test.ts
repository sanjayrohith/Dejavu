import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dejavu } from "../src/index.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "dejavu-as-of-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "auth.ts"), "export const timeout = 30;\n");
  return dir;
}

function open(): Dejavu {
  return new Dejavu({
    path: ":memory:",
    skipGc: true,
    scope: "repo:test",
    anchorRoot: workspace(),
    sessionId: "session-a",
    noChainRollup: true,
  });
}

/** Backdate a slip, since fixtures cannot wait around for real time. */
function backdate(d: Dejavu, id: string, createdAt: number, keptAt: number | null = createdAt): void {
  d.storage.db
    .prepare(`UPDATE slips SET created_at = ?, kept_at = ? WHERE id = ?`)
    .run(createdAt, keptAt, id);
}

describe("recalling as of a past instant", () => {
  test("memory written after the instant does not appear", () => {
    const d = open();
    const early = d.remember("the deploy script needs sudo").id;
    d.keep([early]);
    backdate(d, early, 1_000);

    const late = d.remember("the deploy script needs a token").id;
    d.keep([late]);
    backdate(d, late, 3_000);

    const ids = d.recall("deploy script", { asOf: 2_000 }).hits.map((hit) => hit.slip.id);
    expect(ids).toEqual([early]);
    expect(d.recall("deploy script").hits).toHaveLength(2);
    d.close();
  });

  test("supersession recorded later does not rewrite the past", () => {
    const d = open();
    const old = d.remember("use jest", { kind: "decision" }).id;
    d.keep([old]);
    backdate(d, old, 1_000);

    const current = d.remember("use vitest", { kind: "decision" }).id;
    d.keep([current]);
    backdate(d, current, 3_000);
    d.storage.insertLink({ fromId: current, toId: old, kind: "supersedes", createdAt: 3_000 });

    // At T2 the correction did not exist, so the old memory was the answer.
    expect(d.recall("jest", { asOf: 2_000 }).hits.map((h) => h.slip.id)).toEqual([old]);
    // Today it resolves forward to the replacement.
    expect(d.recall("jest").hits.map((h) => h.slip.id)).toEqual([current]);
    d.close();
  });

  test("a handoff resolved since is restored to the packet", () => {
    const d = open();
    const h = d.handoff({ summary: "canary half-deployed" });
    d.storage.db.prepare(`UPDATE handoffs SET created_at = ? WHERE id = ?`).run(1_000, h.id);
    d.resolveHandoff(h.id, "completed");
    d.storage.db.prepare(`UPDATE handoffs SET resolved_at = ? WHERE id = ?`).run(3_000, h.id);

    expect(d.recall("", { asOf: 2_000 }).activeHandoff?.id).toBe(h.id);
    expect(d.recall("").activeHandoff).toBeNull();
    d.close();
  });

  test("a replay leaves no receipt behind", () => {
    const d = open();
    d.keep([d.remember("the deploy script needs sudo").id]);

    const before = d.storage.recentRecallTraces(50, "repo:test").length;
    const result = d.recall("deploy", { asOf: Date.now() });
    const after = d.storage.recentRecallTraces(50, "repo:test").length;

    expect(result.traceId).toBeNull();
    expect(after).toBe(before);
    d.close();
  });

  test("an ordinary recall still records one", () => {
    const d = open();
    d.keep([d.remember("the deploy script needs sudo").id]);
    expect(d.recall("deploy").traceId).not.toBeNull();
    d.close();
  });
});

describe("reverse lookup as of a past instant", () => {
  test("anchors written later are not visible", () => {
    const d = open();
    const slip = d.remember("a pitfall about auth", { kind: "pitfall", anchors: ["src/auth.ts"] });
    d.keep([slip.id]);
    d.storage.db.prepare(`UPDATE slips SET created_at = ?, kept_at = ? WHERE id = ?`).run(3_000, 3_000, slip.id);
    d.storage.db.prepare(`UPDATE anchors SET created_at = ? WHERE slip_id = ?`).run(3_000, slip.id);

    expect(d.touching(["src/auth.ts"], { asOf: 2_000 }).hits).toHaveLength(0);
    expect(d.touching(["src/auth.ts"], { asOf: 4_000 }).hits).toHaveLength(1);
    d.close();
  });

  test("a replayed reverse lookup leaves no receipt", () => {
    const d = open();
    d.keep([d.remember("a pitfall about auth", { kind: "pitfall", anchors: ["src/auth.ts"] }).id]);
    expect(d.touching(["src/auth.ts"], { asOf: Date.now() }).traceId).toBeNull();
    d.close();
  });
});

describe("orientation as of a past instant", () => {
  test("does not consult today's working tree", () => {
    const d = open();
    // No paths passed: a live call would read the tree. As of a past
    // instant, what the tree looks like now is not an answer to anything.
    const packet = d.orientation({ asOf: Date.now() });
    expect(packet.worktreeUnavailable).toBe(true);
    expect(packet.paths).toEqual([]);
    d.close();
  });

  test("honours the cutoff and leaves no receipt", () => {
    const d = open();
    const early = d.remember("always deploy with wrangler", { kind: "decision" }).id;
    d.keep([early]);
    backdate(d, early, 1_000);
    const late = d.remember("always deploy on fridays", { kind: "decision" }).id;
    d.keep([late]);
    backdate(d, late, 3_000);

    const packet = d.orientation({ paths: [], asOf: 2_000 });
    expect(packet.mustKnow.map((hit) => hit.slip.id)).toEqual([early]);
    expect(packet.traceId).toBeNull();
    d.close();
  });
});

describe("drift labelling under a cutoff", () => {
  test("is suppressed, because the past working tree is unknowable", () => {
    const root = workspace();
    const d = new Dejavu({
      path: ":memory:",
      skipGc: true,
      scope: "repo:test",
      anchorRoot: root,
      sessionId: "session-a",
      noChainRollup: true,
    });
    d.keep([d.remember("a pitfall about auth", { kind: "pitfall", anchors: ["src/auth.ts"] }).id]);

    expect(d.recall("pitfall auth").hits[0]!.drift).toBe("verified");
    expect(d.recall("pitfall auth", { asOf: Date.now() }).hits[0]!.drift).toBeUndefined();
    d.close();
  });

  test("but can still be asked for explicitly", () => {
    const root = workspace();
    const d = new Dejavu({
      path: ":memory:",
      skipGc: true,
      scope: "repo:test",
      anchorRoot: root,
      sessionId: "session-a",
      noChainRollup: true,
    });
    d.keep([d.remember("a pitfall about auth", { kind: "pitfall", anchors: ["src/auth.ts"] }).id]);

    const hit = d.recall("pitfall auth", { asOf: Date.now(), checkAnchorDrift: true }).hits[0]!;
    expect(hit.drift).toBe("verified");
    d.close();
  });
});

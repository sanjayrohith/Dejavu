import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dejavu } from "../src/index.ts";
import {
  agreement,
  classifyTrace,
  parseOrientationQuery,
  parseTouchingQuery,
  replay,
} from "../src/replay.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "dejavu-replay-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "auth.ts"), "export const timeout = 30;\n");
  return dir;
}

function open(path = ":memory:"): Dejavu {
  return new Dejavu({
    path,
    skipGc: true,
    scope: "repo:test",
    anchorRoot: workspace(),
    sessionId: "session-a",
    noChainRollup: true,
  });
}

function keep(d: Dejavu, text: string, opts: Parameters<Dejavu["remember"]>[1] = {}): string {
  const slip = d.remember(text, opts);
  d.keep([slip.id]);
  return slip.id;
}

/** Move a slip and everything about it into the past. */
function backdate(d: Dejavu, id: string, at: number): void {
  d.storage.db.prepare(`UPDATE slips SET created_at = ?, kept_at = ? WHERE id = ?`).run(at, at, id);
  d.storage.db.prepare(`UPDATE anchors SET created_at = ? WHERE slip_id = ?`).run(at, id);
}

/** Move a recorded receipt into the past, so later writes postdate it. */
function backdateTrace(d: Dejavu, traceId: string, at: number): void {
  d.storage.db.prepare(`UPDATE recall_traces SET created_at = ? WHERE id = ?`).run(at, traceId);
}

describe("recovering what wrote a receipt", () => {
  test("tells the four retrievals apart by their recorded query", () => {
    expect(classifyTrace("deploy staging")).toEqual({ kind: "recall", tier: "exact" });
    expect(classifyTrace("")).toEqual({ kind: "recents", tier: "exact" });
    expect(classifyTrace("   ")).toEqual({ kind: "recents", tier: "exact" });
    expect(classifyTrace("touching:src/auth.ts")).toEqual({ kind: "touching", tier: "exact" });
    expect(classifyTrace("orientation:main src/auth.ts")).toEqual({
      kind: "orientation",
      tier: "approximate",
    });
  });

  test("splits an orientation query back into branch and paths", () => {
    expect(parseOrientationQuery("orientation:main src/a.ts src/b.ts")).toEqual({
      branch: "main",
      paths: ["src/a.ts", "src/b.ts"],
    });
    expect(parseOrientationQuery("orientation:- src/a.ts")).toEqual({
      branch: null,
      paths: ["src/a.ts"],
    });
    expect(parseOrientationQuery("orientation:main")).toEqual({ branch: "main", paths: [] });
    expect(parseOrientationQuery("orientation:")).toEqual({ branch: null, paths: [] });
  });

  test("splits a touching query back into paths", () => {
    expect(parseTouchingQuery("touching:src/a.ts src/b.ts")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(parseTouchingQuery("touching:")).toEqual([]);
  });
});

describe("replaying an unchanged implementation", () => {
  test("a recall that has not moved comes back identical", () => {
    const d = open();
    keep(d, "the deploy script needs sudo");
    keep(d, "deployment runs through wrangler");
    d.recall("deploy");

    const report = replay(d);
    expect(report.traces).toBe(1);
    expect(report.exact.replayed).toBe(1);
    expect(report.exact.identical).toBe(1);
    expect(report.cases[0]!.verdict).toBe("identical");
    d.close();
  });

  test("replaying is itself idempotent and records nothing", () => {
    const d = open();
    keep(d, "the deploy script needs sudo");
    d.recall("deploy");

    expect(replay(d).traces).toBe(1);
    expect(replay(d).traces).toBe(1);
    expect(replay(d).exact.identical).toBe(1);
    d.close();
  });

  test("a reverse lookup replays exactly", () => {
    const d = open();
    keep(d, "a pitfall about auth", { kind: "pitfall", anchors: ["src/auth.ts"] });
    d.touching(["src/auth.ts"]);

    const report = replay(d);
    expect(report.cases[0]!.kind).toBe("touching");
    expect(report.exact.identical).toBe(1);
    d.close();
  });

  test("an orientation packet replays into the approximate tier", () => {
    const d = open();
    keep(d, "always deploy with wrangler", { kind: "decision" });
    d.orientation({ paths: [], branch: "main" });

    const report = replay(d);
    expect(report.cases[0]!.kind).toBe("orientation");
    expect(report.approximate.replayed).toBe(1);
    expect(report.approximate.identical).toBe(1);
    expect(report.exact.replayed).toBe(0);
    d.close();
  });
});

describe("the as-of cutoff is what makes this meaningful", () => {
  test("memory written after a receipt is not credited to it", () => {
    const d = open();
    const early = keep(d, "deployment runs through wrangler");
    backdate(d, early, 1_000);

    const trace = d.recall("deployment")!;
    backdateTrace(d, trace.traceId!, 2_000);

    // Written later. A naive replay would now "find" it and call the old
    // receipt a regression.
    const late = keep(d, "deployment also needs a canary check");
    backdate(d, late, 3_000);

    const report = replay(d);
    expect(report.exact.identical).toBe(1);
    expect(report.cases[0]!.actual).toEqual([early]);
    d.close();
  });

  test("memory expired since is restored, not counted as lost", () => {
    const d = open();
    const id = keep(d, "deployment runs through wrangler");
    backdate(d, id, 1_000);
    const trace = d.recall("deployment")!;
    backdateTrace(d, trace.traceId!, 2_000);

    d.forget(id);
    d.storage.db.prepare(`UPDATE slips SET expired_at = ? WHERE id = ?`).run(3_000, id);

    const report = replay(d);
    expect(report.exact.identical).toBe(1);
    expect(report.cases[0]!.lost).toEqual([]);
    d.close();
  });
});

describe("detecting that retrieval moved", () => {
  test("a hit that disappears is reported as lost", () => {
    const d = open();
    const a = keep(d, "deployment runs through wrangler");
    const b = keep(d, "deployment needs a canary check");
    backdate(d, a, 1_000);
    backdate(d, b, 1_000);

    const trace = d.recall("deployment")!;
    backdateTrace(d, trace.traceId!, 2_000);
    expect(trace.hits).toHaveLength(2);

    // Simulate retrieval moving: one memory is expired *before* the
    // receipt, so replaying the same moment can no longer return it.
    d.storage.db
      .prepare(`UPDATE slips SET state = 'expired', expired_at = ? WHERE id = ?`)
      .run(1_500, b);

    const report = replay(d);
    expect(report.exact.changed).toBe(1);
    expect(report.cases[0]!.lost).toEqual([b]);
    expect(report.cases[0]!.verdict).toBe("changed");
    d.close();
  });

  test("the same set in a different order is reordered, not changed", () => {
    const d = open();
    const a = keep(d, "alpha deployment note");
    const b = keep(d, "beta deployment note");
    backdate(d, a, 1_000);
    backdate(d, b, 1_000);
    const trace = d.recall("deployment")!;
    backdateTrace(d, trace.traceId!, 2_000);

    // Rewrite the receipt's recorded order without touching the memory.
    d.storage.db
      .prepare(`UPDATE recall_traces SET hit_ids = ? WHERE id = ?`)
      .run(JSON.stringify([...trace.hits.map((h) => h.slip.id)].reverse()), trace.traceId!);

    const report = replay(d);
    expect(report.exact.reordered).toBe(1);
    expect(report.cases[0]!.gained).toEqual([]);
    expect(report.cases[0]!.lost).toEqual([]);
    d.close();
  });

  test("order is not held against the approximate tier", () => {
    const d = open();
    const a = keep(d, "always deploy with wrangler", { kind: "decision" });
    const b = keep(d, "the team prefers tabs", { kind: "preference" });
    backdate(d, a, 1_000);
    backdate(d, b, 1_000);
    const packet = d.orientation({ paths: [], branch: "main" });
    backdateTrace(d, packet.traceId!, 2_000);

    d.storage.db
      .prepare(`UPDATE recall_traces SET hit_ids = ? WHERE id = ?`)
      .run(
        JSON.stringify([...packet.mustKnow.map((h) => h.slip.id)].reverse()),
        packet.traceId!,
      );

    const report = replay(d);
    expect(report.approximate.identical).toBe(1);
    expect(report.approximate.changed).toBe(0);
    d.close();
  });

  test("finding something where nothing was found before is visible", () => {
    const d = open();
    const trace = d.recall("deployment")!; // empty database, no hits
    expect(trace.hits).toHaveLength(0);
    backdateTrace(d, trace.traceId!, 2_000);

    // A memory that existed before the receipt but was somehow not
    // returned — exactly the "missed" case replay should surface.
    const id = keep(d, "deployment runs through wrangler");
    backdate(d, id, 1_000);

    const report = replay(d);
    expect(report.cases[0]!.verdict).toBe("changed");
    expect(report.cases[0]!.gained).toEqual([id]);
    d.close();
  });
});

describe("the report", () => {
  test("keeps assessments alongside the replay, without conflating them", () => {
    const d = open();
    keep(d, "deployment runs through wrangler");
    const trace = d.recall("deployment")!;
    d.assessRecall(trace.traceId!, "useful", "saved a scan");

    const report = replay(d);
    expect(report.assessed.total).toBe(1);
    expect(report.assessed.useful).toBe(1);
    expect(report.cases[0]!.assessment).toBe("useful");
    d.close();
  });

  test("never replays another repository's receipts", () => {
    const path = join(mkdtempSync(join(tmpdir(), "dejavu-replay-db-")), "dejavu.db");
    dirs.push(join(path, ".."));

    const mine = open(path);
    keep(mine, "deployment runs through wrangler");
    mine.recall("deployment");
    mine.close();

    const theirs = new Dejavu({ path, skipGc: true, scope: "repo:elsewhere", sessionId: "s" });
    theirs.recall("deployment");
    const report = replay(theirs);
    expect(report.scope).toBe("repo:elsewhere");
    expect(report.traces).toBe(1);
    theirs.close();
  });

  test("agreement is a share of what actually ran, or null when nothing did", () => {
    expect(agreement({ replayed: 0, identical: 0, reordered: 0, changed: 0 })).toBeNull();
    expect(agreement({ replayed: 4, identical: 3, reordered: 1, changed: 0 })).toBe(75);
  });

  test("honours a cap on how many receipts to replay", () => {
    const d = open();
    keep(d, "deployment runs through wrangler");
    for (let i = 0; i < 5; i += 1) d.recall("deployment");

    expect(replay(d).traces).toBe(5);
    expect(replay(d, { limit: 2 }).traces).toBe(2);
    d.close();
  });
});

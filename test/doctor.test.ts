import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dejavu, memory } from "../src/index.ts";
import { LARGE_DB_BYTES, buildDoctorReport, collectWarnings } from "../src/doctor.ts";
import { _resetSessionForTesting } from "../src/lifecycle.ts";
import { writeSessionPointer } from "../src/session.ts";
import { VERSION } from "../src/version.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetSessionForTesting();
  process.env.DEJAVU_SESSION = "doctor-test-session";
  process.env.DEJAVU_AUTHOR = "doctor-test-agent";
});

function fileBacked(): Dejavu {
  const dir = mkdtempSync(join(tmpdir(), "dejavu-doctor-"));
  dirs.push(dir);
  return new Dejavu({ path: join(dir, "dejavu.db"), skipGc: true, scope: "repo:doctor" });
}

describe("buildDoctorReport — redaction", () => {
  test("never includes slip or handoff text, anywhere in the serialized report", () => {
    const d = memory();
    const secret = d.remember("THE-SECRET-DECISION-TEXT-9f3a", { tags: ["THE-SECRET-TAG-7c1b"] });
    d.keep([secret.id], { noChainRollup: true });
    d.handoff({ summary: "THE-SECRET-HANDOFF-SUMMARY-2e8d", next: ["THE-SECRET-NEXT-STEP-4b6f"] });

    const serialized = JSON.stringify(buildDoctorReport(d));
    expect(serialized).not.toContain("THE-SECRET-DECISION-TEXT-9f3a");
    expect(serialized).not.toContain("THE-SECRET-TAG-7c1b");
    expect(serialized).not.toContain("THE-SECRET-HANDOFF-SUMMARY-2e8d");
    expect(serialized).not.toContain("THE-SECRET-NEXT-STEP-4b6f");
    d.close();
  });
});

describe("buildDoctorReport — runtime and database", () => {
  test("reports version, runtime, and a healthy database", () => {
    const d = fileBacked();
    d.keep([d.remember("a kept decision").id], { noChainRollup: true });
    const report = buildDoctorReport(d);

    expect(report.version).toBe(VERSION);
    expect(report.runtime.bun).toBe(Bun.version);
    expect(report.runtime.platform).toBe(process.platform);
    expect(report.database.sqlite).toBe("ok");
    expect(report.database.ftsInSync).toBe(true);
    expect(report.database.sizeBytes).toBeGreaterThan(0);
    expect(report.warnings).toEqual([]);
    d.close();
  });

  test("in-memory databases report a null size rather than throwing", () => {
    const d = memory();
    const report = buildDoctorReport(d);
    expect(report.database.sizeBytes).toBeNull();
    d.close();
  });
});

describe("buildDoctorReport — scopes and current scope", () => {
  test("scopes carries the per-scope breakdown from Storage.scopeCounts", () => {
    const d = new Dejavu({ path: ":memory:", skipGc: true, scope: "repo:doctor-test" });
    d.keep([d.remember("mine").id], { noChainRollup: true });
    d.keep([d.remember("theirs", { scope: "repo:elsewhere" }).id], { noChainRollup: true });

    const report = buildDoctorReport(d);
    const scopeNames = report.scopes.map((s) => s.scope);
    expect(scopeNames).toContain("repo:doctor-test");
    expect(scopeNames).toContain("repo:elsewhere");
    expect(report.scopes.find((s) => s.scope === "repo:doctor-test")!.kept).toBe(1);
    expect(report.scopes.find((s) => s.scope === "repo:elsewhere")!.kept).toBe(1);
    d.close();
  });

  test("session reports unclaimed when no harness has claimed this scope", () => {
    const d = fileBacked();
    const report = buildDoctorReport(d);
    expect(report.currentScope.scope).toBe("repo:doctor");
    expect(report.currentScope.session.claimed).toBe(false);
    expect(report.currentScope.session.harness).toBeNull();
    d.close();
  });

  test("session reports a claim written by a harness", () => {
    const d = fileBacked();
    writeSessionPointer(d.scope, "claimed-session-id", "claude-code", { dbPath: d.storage.path });
    const report = buildDoctorReport(d);
    expect(report.currentScope.session.claimed).toBe(true);
    expect(report.currentScope.session.harness).toBe("claude-code");
    expect(report.currentScope.session.ageMs).toBeGreaterThanOrEqual(0);
    d.close();
  });

  test("anchor tally counts verified and drifted anchors in the current scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "dejavu-doctor-anchor-"));
    dirs.push(dir);
    Bun.write(join(dir, "a.ts"), "export const a = 1;\n");
    const d = new Dejavu({ path: join(dir, "dejavu.db"), skipGc: true, scope: "repo:doctor-anchor", anchorRoot: dir });
    const slip = d.remember("about a.ts", { anchors: ["a.ts"] });
    d.keep([slip.id], { noChainRollup: true });

    let report = buildDoctorReport(d);
    expect(report.currentScope.anchors).toEqual({ total: 1, verified: 1, drifted: 0, orphaned: 0, unknown: 0 });

    Bun.write(join(dir, "a.ts"), "export const a = 2;\n");
    report = buildDoctorReport(d);
    expect(report.currentScope.anchors).toEqual({ total: 1, verified: 0, drifted: 1, orphaned: 0, unknown: 0 });
    d.close();
  });
});

describe("collectWarnings", () => {
  const healthyOk = { sqlite: "ok", slips: 5, indexed: 5 };

  test("no warnings for a healthy, small database", () => {
    expect(collectWarnings(healthyOk, 1024)).toEqual([]);
  });

  test("warns on a failed integrity check", () => {
    const warnings = collectWarnings({ sqlite: "corruption found", slips: 5, indexed: 5 }, 1024);
    expect(warnings.some((w) => w.includes("integrity check failed"))).toBe(true);
  });

  test("warns when the FTS index count disagrees with the slip count", () => {
    const warnings = collectWarnings({ sqlite: "ok", slips: 5, indexed: 4 }, 1024);
    expect(warnings.some((w) => w.includes("FTS index"))).toBe(true);
  });

  test("warns once the database file crosses the large-file threshold", () => {
    expect(collectWarnings(healthyOk, LARGE_DB_BYTES - 1)).toEqual([]);
    const warnings = collectWarnings(healthyOk, LARGE_DB_BYTES + 1);
    expect(warnings.some((w) => w.includes("MB"))).toBe(true);
  });

  test("a null size (in-memory db) never triggers the size warning", () => {
    expect(collectWarnings(healthyOk, null)).toEqual([]);
  });
});

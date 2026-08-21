import { describe, expect, test } from "bun:test";
import { formatDoctorReport } from "../src/format.ts";
import type { DoctorReport } from "../src/doctor.ts";

function report(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    version: "0.1.0",
    generatedAt: "2026-01-01T00:00:00.000Z",
    runtime: { bun: "1.3.0", platform: "linux", git: "found" },
    database: {
      path: "/home/user/.dejavu/dejavu.db",
      sizeBytes: 4096,
      walSizeBytes: null,
      sqlite: "ok",
      ftsIndexed: 3,
      ftsTotal: 3,
      ftsInSync: true,
    },
    scopes: [],
    currentScope: {
      scope: "repo:test",
      source: "git-remote",
      session: { id: "01SESSION", claimed: false, harness: null, ageMs: null },
      anchors: { total: 0, verified: 0, drifted: 0, orphaned: 0, unknown: 0 },
    },
    warnings: [],
    ...overrides,
  };
}

describe("formatDoctorReport", () => {
  test("small databases show KB, not a misleadingly rounded 0.00 MB", () => {
    const text = formatDoctorReport(report({ database: { ...report().database, sizeBytes: 4096 } }));
    expect(text).toContain("4.0 KB");
  });

  test("larger databases show MB", () => {
    const text = formatDoctorReport(report({ database: { ...report().database, sizeBytes: 5 * 1024 * 1024 } }));
    expect(text).toContain("5.00 MB");
  });

  test("an unmeasurable (in-memory) database size reads unknown, not null", () => {
    const text = formatDoctorReport(report({ database: { ...report().database, sizeBytes: null } }));
    expect(text).toContain("(unknown)");
  });

  test("no scopes reads explicitly empty rather than an empty list", () => {
    const text = formatDoctorReport(report({ scopes: [] }));
    expect(text).toContain("scopes (0):");
    expect(text).toContain("(none yet)");
  });

  test("renders each scope's counts on one line", () => {
    const text = formatDoctorReport(
      report({
        scopes: [
          { scope: "repo:a", slips: 5, kept: 3, drafts: 1, expired: 1, handoffs: 2, activeHandoffs: 1, anchoredSlips: 1 },
        ],
      }),
    );
    expect(text).toContain("repo:a: 5 slips (3 kept, 1 draft, 1 expired), 2 handoffs (1 active), 1 anchored");
  });

  test("no warnings reads explicitly none", () => {
    expect(formatDoctorReport(report({ warnings: [] }))).toContain("warnings: none");
  });

  test("warnings are listed, not just counted", () => {
    const text = formatDoctorReport(report({ warnings: ["database file is 250.0 MB — consider dejavu forget-session for a stale scope"] }));
    expect(text).toContain("warnings:");
    expect(text).toContain("- database file is 250.0 MB");
  });

  test("an FTS mismatch is flagged inline", () => {
    const text = formatDoctorReport(
      report({ database: { ...report().database, ftsIndexed: 2, ftsTotal: 3, ftsInSync: false } }),
    );
    expect(text).toContain("2/3 indexed — OUT OF SYNC");
  });

  test("a claimed session names the harness and its age", () => {
    const text = formatDoctorReport(
      report({
        currentScope: {
          ...report().currentScope,
          session: { id: "01SESSION", claimed: true, harness: "claude-code", ageMs: 4200 },
        },
      }),
    );
    expect(text).toContain("claimed by claude-code, 4s old");
  });
});

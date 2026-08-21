/**
 * `dejavu doctor` — a redacted diagnostic bundle.
 *
 * `dejavu verify` already checks integrity for the whole database and
 * the caller's current scope. This is a superset: everything verify
 * shows, plus a per-scope breakdown across every repository this one
 * database has ever seen memory from, current-scope anchor drift,
 * session-pointer health, and runtime info — built to be pasted into a
 * bug report.
 *
 * Redaction is structural, not a filter step: this module only ever
 * reads counts, enums, ids, and scope strings out of storage. No slip,
 * handoff, or anchor `text`/`tags` value is read into the report, so
 * there is nothing to strip afterward.
 */

import { statSync } from "node:fs";
import { rollupDrift } from "./anchors.ts";
import { currentSessionId } from "./lifecycle.ts";
import { readSessionPointer } from "./session.ts";
import type { ScopeCounts } from "./storage.ts";
import { VERSION } from "./version.ts";
import type { Dejavu } from "./index.ts";

/** Database files past this size get a warning — this is meant to stay a small local file. */
export const LARGE_DB_BYTES = 200 * 1024 * 1024;

export interface DoctorReport {
  version: string;
  generatedAt: string;
  runtime: { bun: string; platform: string; git: "found" | "not found" };
  database: {
    path: string;
    sizeBytes: number | null;
    walSizeBytes: number | null;
    sqlite: string;
    ftsIndexed: number;
    ftsTotal: number;
    ftsInSync: boolean;
  };
  /** Every repository scope this database has memory from, not just the current one. */
  scopes: ScopeCounts[];
  currentScope: {
    scope: string;
    source: string;
    session: { id: string; claimed: boolean; harness: string | null; ageMs: number | null };
    anchors: { total: number; verified: number; drifted: number; orphaned: number; unknown: number };
  };
  warnings: string[];
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function gitAvailable(): boolean {
  try {
    return Bun.spawnSync(["git", "--version"], { stdout: "ignore", stderr: "ignore" }).success;
  } catch {
    return false;
  }
}

/**
 * Tally, not a listing: how many of the current scope's anchored slips
 * are verified/drifted/orphaned/unknown.
 *
 * Reuses the same `listAnchoredSlips` + `anchorStates` + `rollupDrift`
 * calls `dejavu anchors` already makes, kept as its own small loop here
 * rather than a shared refactor — `dejavu anchors` also needs each
 * slip's text and per-anchor detail to print, which this tally has no
 * use for, so sharing the loop would mean one caller iterating for work
 * the other doesn't need.
 */
function anchorTally(d: Dejavu): DoctorReport["currentScope"]["anchors"] {
  const tally = { total: 0, verified: 0, drifted: 0, orphaned: 0, unknown: 0 };
  for (const slip of d.storage.listAnchoredSlips(d.scope, d.options.includeLegacy)) {
    const drift = rollupDrift(d.anchorStates(slip.id));
    tally.total += 1;
    if (drift) tally[drift] += 1;
  }
  return tally;
}

/**
 * The warning conditions, factored out so the thresholds are testable
 * without needing a real multi-hundred-megabyte file on disk. No
 * editorializing about anchor drift here — drift is a label, not an
 * alarm, everywhere else in this project, and doctor keeps that rule.
 */
export function collectWarnings(
  health: { sqlite: string; slips: number; indexed: number },
  sizeBytes: number | null,
): string[] {
  const warnings: string[] = [];
  if (health.sqlite !== "ok") warnings.push(`sqlite integrity check failed: ${health.sqlite}`);
  if (health.slips !== health.indexed) {
    warnings.push(`FTS index (${health.indexed}) does not match slip count (${health.slips})`);
  }
  if (sizeBytes !== null && sizeBytes > LARGE_DB_BYTES) {
    warnings.push(
      `database file is ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB — consider dejavu forget-session for a stale scope`,
    );
  }
  return warnings;
}

export function buildDoctorReport(d: Dejavu): DoctorReport {
  const health = d.storage.health();
  const path = d.storage.path;
  const size = fileSize(path);
  const claimed = readSessionPointer(d.scope, { dbPath: path });

  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    runtime: { bun: Bun.version, platform: process.platform, git: gitAvailable() ? "found" : "not found" },
    database: {
      path,
      sizeBytes: size,
      walSizeBytes: fileSize(`${path}-wal`),
      sqlite: health.sqlite,
      ftsIndexed: health.indexed,
      ftsTotal: health.slips,
      ftsInSync: health.slips === health.indexed,
    },
    scopes: d.storage.scopeCounts(),
    currentScope: {
      scope: d.scope,
      source: d.context.source,
      session: {
        id: claimed?.sessionId ?? currentSessionId(),
        claimed: claimed !== null,
        harness: claimed?.harness ?? null,
        ageMs: claimed ? Date.now() - claimed.updatedAt : null,
      },
      anchors: anchorTally(d),
    },
    warnings: collectWarnings(health, size),
  };
}

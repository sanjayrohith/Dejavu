/**
 * Replaying recorded retrievals.
 *
 * Every recall, reverse lookup, and session orientation already leaves a
 * content-free receipt: the query, the repository scope, the ids that came
 * back, and when. That was recorded so retrieval could be evaluated later
 * without copying memory text anywhere. This is the later.
 *
 * Replay re-runs each receipt through the real retrieval pipeline, as of
 * the instant it was originally served, and diffs the ids. It needs
 * nothing from any agent — which matters, because the project's own
 * evaluation plan has been waiting on agents choosing to call `assess`
 * after they have already finished the task, and Loop 4 established twice
 * that discretionary agent behaviour does not survive task pressure.
 * Every retrieval that has already happened is a recorded case.
 *
 * ## What this measures, and what it does not
 *
 * It measures **stability and coverage**: does today's implementation
 * return what it returned then, and how much of the corpus can be
 * reproduced at all. It does **not** measure truth. A memory can be
 * retrieved identically every time and still be the wrong memory; only an
 * assessment says otherwise, and only the assessed subset carries one.
 *
 * A difference is therefore **not automatically a regression**. An
 * intentional retrieval improvement shows up here as `changed`, and is
 * supposed to. The number's job is to make the change visible and
 * quantified before it ships, not to approve or reject it.
 *
 * ## Two ways to use it
 *
 * 1. **Agreement with what was served** — the report below. Answers "how
 *    far has retrieval moved from what real sessions actually got".
 * 2. **Regression detection** — `dejavu eval --replay --json` before a
 *    change and after it, then diff the two. This is the stronger use,
 *    because it does not depend on reconstructing the past perfectly, only
 *    on replay being deterministic. It is.
 *
 * ## Fidelity
 *
 * Slips are append-only, so what was visible at a past instant is exactly
 * reconstructible (see `storage.ts`). Three things are not:
 *
 * - **Evidence counters.** `used_count` and `wrong_count` have no history,
 *   so anything ordered by trust cannot be restored. That is orientation.
 * - **The working tree.** Anchor drift is whatever it is now, so drift
 *   ordering is not restorable either. Replay suppresses drift labelling
 *   rather than pretending.
 * - **Retrieval parameters.** Limits and token budgets were never
 *   recorded. Replay works around this by asking for exactly as many hits
 *   as were served and lifting the token budget, so the comparison is
 *   "the top N, where N is what you got" rather than a guess at the
 *   original budget.
 *
 * So recall, recents, and reverse lookups replay `exact` — set and order
 * both meaningful. Orientation replays `approximate` — set compared,
 * order not, because the counters that ordered it are gone.
 */

import type { Dejavu } from "./index.ts";
import type { RecallAssessment, RecallTrace } from "./types.ts";

/** Which retrieval produced a receipt, recovered from its query field. */
export type ReplayKind = "recall" | "recents" | "touching" | "orientation";

/** How faithfully this kind of receipt can be reproduced. */
export type ReplayTier = "exact" | "approximate";

export type ReplayVerdict =
  /** The same ids came back, in the same order (exact tier) or as the same set. */
  | "identical"
  /** The same ids, in a different order. Exact tier only. */
  | "reordered"
  /** A different set of ids. */
  | "changed"
  /** Could not be replayed at all; `reason` says why. */
  | "skipped";

export interface ReplayCase {
  traceId: string;
  kind: ReplayKind;
  tier: ReplayTier;
  /** The recorded query, verbatim. */
  query: string;
  /** When the original retrieval was served. */
  createdAt: number;
  /** Ids the original retrieval returned. */
  expected: string[];
  /** Ids the current implementation returns for the same moment. */
  actual: string[];
  /** In `actual` but not `expected`. */
  gained: string[];
  /** In `expected` but not `actual`. */
  lost: string[];
  verdict: ReplayVerdict;
  /** Why a case was skipped. */
  reason?: string;
  /** The agent's own verdict on the original retrieval, if it left one. */
  assessment: RecallAssessment | null;
}

export interface ReplayTierSummary {
  replayed: number;
  identical: number;
  reordered: number;
  changed: number;
}

export interface ReplayReport {
  scope: string;
  /** Receipts considered. */
  traces: number;
  skipped: number;
  exact: ReplayTierSummary;
  approximate: ReplayTierSummary;
  /** Assessed cases, split by what the agent said at the time. */
  assessed: { total: number; useful: number; wrong: number; missed: number; noMemoryNeeded: number };
  cases: ReplayCase[];
}

export interface ReplayOptions {
  /** Most receipts to replay, newest first. Default: all of them. */
  limit?: number;
  /**
   * Hits to ask for when the original returned none.
   *
   * A receipt with no hits is the interesting "we found nothing" case, and
   * replaying it with a real limit is how a later implementation finding
   * something becomes visible.
   */
  emptyLimit?: number;
}

/** Recover which retrieval wrote a receipt from the query it recorded. */
export function classifyTrace(query: string): { kind: ReplayKind; tier: ReplayTier } {
  if (query.startsWith("touching:")) return { kind: "touching", tier: "exact" };
  if (query.startsWith("orientation:")) return { kind: "orientation", tier: "approximate" };
  if (query.trim().length === 0) return { kind: "recents", tier: "exact" };
  return { kind: "recall", tier: "exact" };
}

/**
 * Split an `orientation:<branch> <path>...` query back into its inputs.
 *
 * Branch names cannot contain spaces, so the first token is unambiguous.
 * A path containing a space would be split wrongly — rare enough to
 * accept, and it surfaces as a `changed` verdict rather than as silent
 * corruption.
 */
export function parseOrientationQuery(query: string): { branch: string | null; paths: string[] } {
  const body = query.slice("orientation:".length).trim();
  if (body.length === 0) return { branch: null, paths: [] };
  const [branch, ...paths] = body.split(/\s+/);
  return { branch: branch === "-" || !branch ? null : branch, paths };
}

/** Split a `touching:<path>...` query back into its paths. */
export function parseTouchingQuery(query: string): string[] {
  const body = query.slice("touching:".length).trim();
  return body.length === 0 ? [] : body.split(/\s+/);
}

function diff(expected: string[], actual: string[]): { gained: string[]; lost: string[] } {
  const before = new Set(expected);
  const after = new Set(actual);
  return {
    gained: actual.filter((id) => !before.has(id)),
    lost: expected.filter((id) => !after.has(id)),
  };
}

function verdictFor(
  tier: ReplayTier,
  expected: string[],
  actual: string[],
  gained: string[],
  lost: string[],
): ReplayVerdict {
  if (gained.length > 0 || lost.length > 0) return "changed";
  // Same set. For the approximate tier that is as far as the comparison
  // can honestly go, since the ordering inputs are not recoverable.
  if (tier === "approximate") return "identical";
  const sameOrder = expected.every((id, index) => actual[index] === id);
  return sameOrder ? "identical" : "reordered";
}

/**
 * Re-run one receipt through the real retrieval pipeline.
 *
 * The token budget is deliberately lifted and the limit set to what was
 * actually served, so the comparison isolates *what retrieval selected*
 * from *how much of it fitted* — the latter was never recorded and
 * varies by caller.
 */
function rerun(dejavu: Dejavu, trace: RecallTrace, kind: ReplayKind, limit: number): string[] {
  const maxTokens = Number.MAX_SAFE_INTEGER;
  const asOf = trace.createdAt;

  switch (kind) {
    case "touching":
      return dejavu
        .touching(parseTouchingQuery(trace.query), { limit, asOf })
        .hits.map((hit) => hit.slip.id);
    case "orientation": {
      const { branch, paths } = parseOrientationQuery(trace.query);
      const packet = dejavu.orientation({ paths, branch, limit, maxTokens, asOf });
      return [...packet.hazards, ...packet.activeWork, ...packet.mustKnow, ...packet.other].map(
        (hit) => hit.slip.id,
      );
    }
    case "recents":
    case "recall":
      return dejavu.recall(trace.query, { limit, maxTokens, asOf }).hits.map((hit) => hit.slip.id);
  }
}

function emptySummary(): ReplayTierSummary {
  return { replayed: 0, identical: 0, reordered: 0, changed: 0 };
}

/**
 * Replay this repository's recorded retrievals against today's code.
 *
 * Receipts from other repositories are never touched: replay is scoped
 * exactly the way retrieval is.
 */
export function replay(dejavu: Dejavu, options: ReplayOptions = {}): ReplayReport {
  const traces = dejavu.storage.recentRecallTraces(options.limit ?? 10_000, dejavu.scope);
  const emptyLimit = options.emptyLimit ?? 8;

  const report: ReplayReport = {
    scope: dejavu.scope,
    traces: traces.length,
    skipped: 0,
    exact: emptySummary(),
    approximate: emptySummary(),
    assessed: { total: 0, useful: 0, wrong: 0, missed: 0, noMemoryNeeded: 0 },
    cases: [],
  };

  for (const trace of traces) {
    const { kind, tier } = classifyTrace(trace.query);
    const expected = trace.hitIds;
    const limit = expected.length > 0 ? expected.length : emptyLimit;

    let actual: string[];
    try {
      actual = rerun(dejavu, trace, kind, limit);
    } catch (error) {
      report.skipped += 1;
      report.cases.push({
        traceId: trace.id,
        kind,
        tier,
        query: trace.query,
        createdAt: trace.createdAt,
        expected,
        actual: [],
        gained: [],
        lost: [],
        verdict: "skipped",
        reason: error instanceof Error ? error.message : String(error),
        assessment: trace.assessment,
      });
      continue;
    }

    const { gained, lost } = diff(expected, actual);
    const verdict = verdictFor(tier, expected, actual, gained, lost);
    const summary = tier === "exact" ? report.exact : report.approximate;
    summary.replayed += 1;
    summary[verdict === "skipped" ? "changed" : verdict] += 1;

    if (trace.assessment) {
      report.assessed.total += 1;
      if (trace.assessment === "useful") report.assessed.useful += 1;
      else if (trace.assessment === "wrong") report.assessed.wrong += 1;
      else if (trace.assessment === "missed") report.assessed.missed += 1;
      else report.assessed.noMemoryNeeded += 1;
    }

    report.cases.push({
      traceId: trace.id,
      kind,
      tier,
      query: trace.query,
      createdAt: trace.createdAt,
      expected,
      actual,
      gained,
      lost,
      verdict,
      assessment: trace.assessment,
    });
  }

  return report;
}

/** Percentage of replayed cases that came back identical, or null when none ran. */
export function agreement(summary: ReplayTierSummary): number | null {
  if (summary.replayed === 0) return null;
  return (summary.identical / summary.replayed) * 100;
}

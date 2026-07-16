/**
 * Lifecycle helpers — session derivation, GC, trust bucketing.
 *
 * State machine:
 *   draft  -> kept     (via keep())
 *   draft  -> expired  (via forget() or 24h GC)
 *   kept   -> expired  (via forget() — explicit only)
 *
 * No state transitions back. Slips are append-only.
 */

import { ulid } from "./ulid.ts";
import type { MemoryKind, Slip, Trust } from "./types.ts";

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Derive a stable session id for the current process.
 *
 * Priority:
 *   1. DEJAVU_SESSION env var (caller-controlled, e.g. an MCP wrapper)
 *   2. PID + start time (one session per process)
 *
 * Sessions don't need to map 1:1 to "agent conversations". They're a
 * grouping primitive — drafts in the same session can be promoted together.
 */
let _cachedSessionId: string | null = null;
export function currentSessionId(): string {
  if (_cachedSessionId) return _cachedSessionId;
  const fromEnv = process.env.DEJAVU_SESSION;
  _cachedSessionId = fromEnv && fromEnv.length > 0 ? fromEnv : ulid();
  return _cachedSessionId;
}

/** Test/CLI helper to reset memoized session. */
export function _resetSessionForTesting(): void {
  _cachedSessionId = null;
}

export function currentAuthor(): string {
  return process.env.DEJAVU_AUTHOR ?? "unknown-agent";
}

/**
 * Trust describes memory evidence, not lexical relevance.
 *
 * BM25 answers "does this text match the query?"; it cannot establish that
 * the claim is true. A kept memory starts at medium, repeated successful use
 * can promote it to high, and any unresolved wrong signal makes it low.
 */
export function trustForSlip(slip: Slip): Trust {
  if (slip.state !== "kept" || slip.wrongCount > 0) return "low";
  if (slip.usedCount >= 2) return "high";
  return "medium";
}

/** ms cutoff for "drafts older than this should be expired". */
export function draftCutoff(now: number = Date.now()): number {
  return now - DRAFT_TTL_MS;
}

/**
 * Heuristic: does this slip text/tag combination look "chain-shaped"?
 *
 * Chain-shaped slips are ones a future agent picking up the work should
 * encounter. Decisions, preferences, work-in-progress, configuration —
 * anything where the *next* session would want to know about it.
 *
 * One-off facts ("the user once said the sky is blue") are not
 * chain-shaped. Project-shaping facts ("we're using bun for the runtime")
 * are.
 *
 * Used by `Dejavu.keep()` to decide whether to auto-rollup into a session
 * handoff. Conservative: the heuristic must be obvious enough that an
 * agent would not be surprised by the rollup.
 */
const CHAIN_TEXT_PATTERN =
  /\b(decision|decided|chose|prefer|preference|using|use this|setup|setting|configured|wip|in.progress|todo|next|will use|going to use|we picked|we chose)\b/i;
const CHAIN_TAG_PATTERN = /\b(decision|preference|wip|todo|setup|config|chain)\b/i;

export function isChainShaped(text: string, tags: string[]): boolean {
  if (CHAIN_TEXT_PATTERN.test(text)) return true;
  if (CHAIN_TAG_PATTERN.test(tags.join(" "))) return true;
  return false;
}

/** Conservative, deterministic fallback. Agents can always provide `kind`. */
export function inferMemoryKind(text: string, tags: string[] = []): MemoryKind {
  const value = `${tags.join(" ")} ${text}`.toLowerCase();
  if (/\b(pitfall|gotcha|sharp edge|do not|don't|never|failed|failure|broke|wrong)\b/.test(value)) return "pitfall";
  if (/\b(procedure|steps?|runbook|how to|workflow|recipe)\b/.test(value)) return "procedure";
  if (/\b(preference|prefers?|always wants?|likes?)\b/.test(value)) return "preference";
  if (/\b(decision|decided|chose|we picked|will use)\b/.test(value)) return "decision";
  if (/\b(wip|in progress|blocked|todo|next step|currently)\b/.test(value)) return "wip";
  if (/\b(fact|confirmed|verified|finding|observation)\b/.test(value)) return "fact";
  return "note";
}

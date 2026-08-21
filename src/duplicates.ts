/**
 * Write-time near-duplicate and topical-overlap detection.
 *
 * remember() writes freely — nothing here blocks a write. This only
 * answers "does this text already look like something kept," so a caller
 * can decide whether to link a supersession instead of leaving two
 * unlinked slips to compete on BM25 score forever. Pure and DB-free: the
 * caller fetches a small, already-scoped candidate set and this just
 * scores it.
 */

import type { DuplicateSuggestion, Slip } from "./types.ts";

/** Near-identical text: the caller is almost certainly re-writing the same slip. */
export const DUPLICATE_THRESHOLD = 0.82;

/** Strong topical overlap: worth a supersedes suggestion, not necessarily identical. */
export const RELATED_THRESHOLD = 0.5;

/**
 * Common words that would otherwise inflate overlap between two sentences
 * that merely share ordinary structure ("we should use X" vs "we should
 * use Y"). Kept local to this module rather than shared with
 * `next-agent.ts`'s private stopword list, which belongs to a separate,
 * fenced-off, off-by-default ranking experiment.
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "with", "that", "this",
  "these", "those", "from", "what", "were", "was", "are", "you", "use",
  "uses", "using", "used", "to", "of", "in", "on", "at", "is", "it", "be",
  "as", "we", "should", "before", "after", "always", "never", "not",
]);

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
  );
}

/**
 * Token-Jaccard overlap between two texts, stopwords excluded. 0..1.
 *
 * 0 whenever either side has no signal left after stripping stopwords —
 * two short, mostly-stopword sentences should never register as
 * duplicates just because they happen to share "the" and "use".
 */
export function textOverlap(a: string, b: string): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * The strongest overlapping candidate, if any clears {@link RELATED_THRESHOLD}.
 *
 * Ties and near-ties keep the first candidate seen — callers pass
 * candidates newest-first, so a tie prefers the most recent standing
 * memory.
 */
export function findNearDuplicate(
  candidates: Array<{ slip: Slip }>,
  text: string,
): DuplicateSuggestion | null {
  let best: DuplicateSuggestion | null = null;
  for (const candidate of candidates) {
    const overlap = textOverlap(text, candidate.slip.text);
    if (overlap < RELATED_THRESHOLD) continue;
    if (best && overlap <= best.overlap) continue;
    best = {
      slip: candidate.slip,
      overlap,
      kind: overlap >= DUPLICATE_THRESHOLD ? "duplicate" : "related",
    };
  }
  return best;
}

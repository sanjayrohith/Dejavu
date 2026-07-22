# Final go/no-go after extra pass

## Decision

**NO for adding this to Dejavu now.**

**YES for keeping the eval harness and one future experiment:** query-gated next-agent ranking.

Do not add standalone novelty/notice. Do not add the current reasons+penalties ranker to Dejavu core yet.

## Why this is not enough

The second pass fixed the synthetic filler problem with variable-size cutoff. Deterministically, cutoff improved precision a lot:

- security: n=4, recall=1.00, precision=1.00
- realish: n=5, recall=1.00, precision=1.00
- repetitive: n=6, recall=1.00, precision=1.00

But when Kimi chose from cutoff prompts, the ranker became too conservative on drift/contradiction:

- drift ranker_cutoff: recall .71 vs rules_cutoff 1.00
- contradiction ranker_cutoff: recall .75 vs rules_cutoff 1.00

Then real Dejavu DB dogfood exposed a bigger issue: rules/ranker can select an important but wrong-project incident because it lacks a query/project relevance gate.

## Strong findings

1. Standalone novelty is not worthwhile.
2. Explicit reasons/penalties are useful signals.
3. Variable-size cutoff is necessary; forcing exactly 8 creates filler.
4. Rules-only is a very strong baseline.
5. Without query relevance, reasons/penalties can over-rank unrelated important memory.

## What to keep

Keep `eval/next-agent` as the proof harness.

Do not keep the prototype package as product code.

## Only future experiment worth doing

Candidate C3:

1. Start from current Dejavu recall / FTS / query-relevant candidates.
2. Apply reasons+penalties only inside that relevant set.
3. Use variable-size cutoff.
4. Compare against current recall and rules-only.

If C3 wins on real Dejavu DB + synthetic datasets, then consider a tiny internal helper. Until then, no feature.

## Product answer

Should Dejavu add these features now?

**No.** The value is plausible but not proven enough, and current rankers risk surfacing the wrong project's important memory.

Should Dejavu explore further?

**Yes, narrowly:** query-gated read-first ranking, no vectors, no external store, no public API until eval passes.

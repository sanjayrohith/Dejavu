# Real Dejavu DB dogfood

Source: `~/.dejavu/dejavu.db`, 73 kept slips.

Generated three top-15 lists for query `what should next agent know about current Dejavu work`:

- `real/current.md`
- `real/rules.md`
- `real/ranker.md`

## Observation

The simple query/current baseline surfaced some relevant Dejavu/process slips, but also duplicates and broad unrelated operational memory.

Rules/ranker both heavily favored a long incident slip from an unrelated project. That slip was important in its own scope but irrelevant to current Dejavu feature-evaluation work. This exposes a real-data failure mode: generic reason words like `incident`, `decision`, and `fix options` can over-rank long unrelated memories.

## Readout

Synthetic eval says ranker is useful on noisy retrieval. Real dogfood says the ranker needs project/query relevance before product integration.

Minimal next candidate should be:

`query relevance gate` first, then `reasons/penalties` within relevant candidates.

Without that, Dejavu would sometimes read-first the wrong project's important memory.

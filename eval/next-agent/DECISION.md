# Next-agent ranking go/no-go

## Decision

**DEFER, with a narrow YES to further exploration.**

Do **not** add the old standalone `notice` / novelty feature to Dejavu.

Continue evaluating a smaller feature: a local `read first` ranker based on explicit reasons and penalties. Difference/novelty may be a tiny boost, not the product.

## Why

The original idea — score slips by how different they are from recent memory — is not sufficient. It can promote random or stale-but-different slips.

The newer candidate — explicit reasons + penalties — is promising because it consistently rescues weak/current retrieval on repetitive/noisy datasets and avoids stale assumptions.

## Evidence

Datasets: obvious, repetitive, drift, security, contradiction, realish.

Models:

- Kimi K2.6 full matrix
- Sonnet 4.6 confirmation on repetitive/drift/realish

### Kimi K2.6 highlights

| dataset | current | rules | ranker | readout |
|---|---:|---:|---:|---|
| obvious | 16 | 20 | 20 | ranker/rules improve recall |
| repetitive | -16 | 16 | 16 | ranker rescues noisy retrieval |
| drift | 2 | 10 | 22 | ranker avoids stale/harmful context best |
| security | 7 | 7 | 6 | ranker not better; too much filler when few musts exist |
| contradiction | 10 | 10 | 10 | no advantage |
| realish | -16 | 10 | 10 | ranker rescues noisy retrieval |

### Sonnet 4.6 confirmation

| dataset | current | ranker | readout |
|---|---:|---:|---|
| repetitive | -16 | 16 | ranker helps strongly |
| drift | 22 | 22 | Sonnet handles current; ranker ties |
| realish | -16 | 10 | ranker helps strongly |

## Benefits if added later

- Cheap local prefilter: reduce noisy memory before model sees it.
- Helps weaker models: Kimi improves a lot on noisy/repetitive cases.
- Auditable output: reasons/penalties are easier to trust than vector scores.
- Safer drift handling: stale plans/old assumptions can be penalized.
- No external infra needed: no Vectorize/Workers AI required for v0.

## Problems / blockers

- Rules-only ties the ranker on several datasets. If simple rules are enough, do not add extra complexity.
- Security dataset shows ranker can include filler when there are fewer than 8 good slips. The system needs variable-size output or a `minScore` cutoff.
- Current datasets are synthetic. Need one real Dejavu DB dogfood pass before integration.
- The feature should not be a new package yet. If added, it belongs as a small internal Dejavu ranking helper.

## Minimal feature if this later graduates

Not `notice`.

Maybe:

```ts
nextAgent: {
  read: "first" | "maybe" | "skip";
  score: number;
  reasons: string[];
  penalties: string[];
}
```

But only for internal ranking / MCP recall output, not persisted schema at first.

## Next proof required

1. Add variable-size cutoff: do not force exactly 8 reads.
2. Compare rules-only vs ranker with cutoff.
3. Run on a real Dejavu memory export.
4. If ranker still beats/ties rules-only while reducing noise, then consider a tiny Dejavu core helper.

Current status: **worth one more evaluation loop, not worth product integration yet.**

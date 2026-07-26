# dejavu behavioral bench latest

Generated: 2026-06-11T10:29:53.106Z

Summary: **3/3 experiments passed**

These are small behavioral experiments for product claims. They are not a substitute for LLM-in-the-loop runs; they are cheap fixtures that make the desired behavior explicit before it becomes API.

| Experiment | Result | Key metrics | Recommendation |
|---|---:|---|---|
| handoff-structure | PASS | freeformCoverage: 0.429; structuredCoverage: 1; gain: 0.571 | Run an LLM-in-the-loop A/B next; if completion improves, add optional structured handoff fields. |
| stale-preference | PASS | naiveChoice: jest; supersedingChoice: vitest; linkedSupersedesOld: true | Add recall formatting/tests for supersedes and contradicts links before adding heavier memory taxonomy. |
| recall-trigger-policy | PASS | bestPolicy: specific-trigger; bestCorrect: 6/6; bestFalsePositive: 0; bestFalseNegative: 0 | Keep MCP recall descriptions benchmarked. Next step: replace this proxy with real agent transcripts over the same prompt battery. |

## handoff-structure PASS

Structured handoff packets preserve more continuation-critical facts than a prose-only summary.

### Metrics

- freeformCoverage: 0.429
- structuredCoverage: 1
- gain: 0.571

### Evidence

- required facts: auth.ts, 142, parseToken, lib/jwt.ts, tests, imports, failing
- structured variant carries explicit files, next steps, validation, and risks

### Recommendation

Run an LLM-in-the-loop A/B next; if completion improves, add optional structured handoff fields.

## stale-preference PASS

Recency plus explicit supersedes links prevent old preferences from overriding newer ones.

### Metrics

- naiveChoice: jest
- supersedingChoice: vitest
- linkedSupersedesOld: true

### Evidence

- old slip says jest
- newer slip says vitest and links supersedes:old
- a recall formatter should surface the conflict/supersession, not just raw ranked hits

### Recommendation

Add recall formatting/tests for supersedes and contradicts links before adding heavier memory taxonomy.

## recall-trigger-policy PASS

Specific trigger wording should increase appropriate recall without increasing world-knowledge recall.

### Metrics

- bestPolicy: specific-trigger
- bestCorrect: 6/6
- bestFalsePositive: 0
- bestFalseNegative: 0

### Evidence

- recall: Continue where we left off. (prior work / handoff)
- recall: What test runner should I use in this repo? (project convention / preference)
- recall: Add tests for this module. (preference-sensitive action)
- recall: How do I pronounce my project name? (user-specific fact)
- skip: What is the capital of France? (pure world knowledge)
- skip: What is pi to 10 digits? (pure world knowledge)

### Recommendation

Keep MCP recall descriptions benchmarked. Next step: replace this proxy with real agent transcripts over the same prompt battery.

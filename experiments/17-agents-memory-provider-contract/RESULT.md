# Experiment 17 result

- **Date:** 2026-06-11
- **Package under test:** `agents@0.15.0`
- **Runtime:** Wrangler local workerd, SQLite Durable Object

## Result: PASS

The proposed provider boundary represented both immediate operational memory
and asynchronously indexed semantic memory without exposing storage or vector
concepts. The example ran inside a real `MemoryAgent extends Agent` Durable
Object, not an in-process mock.

Commands:

```text
$ npm run typecheck
> tsc --noEmit
(exit 0)

$ npm test
PASS: agents.Agent DO exercised both MemoryProvider adapters
PASS: receipt/freshness/scope/budget/provenance/delete/resolution assertions
PASS: async retrieval transitions pending -> fresh without vector assumptions
(exit 0)
```

## Proven behavior

The local run demonstrated:

| Assertion | Result |
| --- | --- |
| `agents@0.15.0` `Agent` subclasses run as a SQLite DO under local workerd | PASS |
| A contract adapter can use the Agent through public `SqlProvider` / `Agent.sql` | PASS |
| Operational write receipt is immediately recallable in the same scope | PASS |
| Identical query in a different scope does not see the memory | PASS |
| Recall returns original provenance | PASS |
| `maxTokens` prevents over-budget context and reports truncation/use | PASS |
| Superseded memory stops appearing; receipt names replacement/reason | PASS |
| Deleted memory stops appearing | PASS |
| Async source write is durable while retrieval reports receipt-linked pending work | PASS |
| Before processing, async recall does not pretend pending content is indexed | PASS |
| After processing, freshness becomes `fresh` and the content is recalled | PASS |
| Async adapter works with lexical facets and no vectors | PASS |

Inspection of the exact installed public declarations also established that
`agents@0.15.0` exports experimental session/context provider seams, but no
general memory-provider contract carrying all tested lifecycle semantics. See
README's “actually provides” section for the precise separation.

## Product conclusion (recommendation, not existing API)

Ship the storage-neutral types in `src/contract.ts` as a small independent
companion library/plugin **on top of** `agents`; do not propose or wait for an
Agents SDK change. The highest-value rule is that **durability and retrieval
freshness are separate fields**. That allows one Agent application to compose
immediate SQL memory and delayed richer retrieval without treating a committed
write as immediately indexed or hard-coding vectors.

The companion layer should cover receipts, scope, freshness/pending work,
context budgets, provenance, deletion, and resolution while consuming only
public Agent/SQL/Workflow seams. Implementations remain free to use Agent SQL,
Postgres, R2, a service, lexical search, knowledge graphs, vectors, or hybrids.

This swims alongside the current experimental `SessionProvider` and context
provider APIs. It neither forks nor patches them. Shipping outside the SDK keeps
the experiment loop independent from upstream design consensus, compatibility
review, and release cadence.

## Caveats

This is local-runtime and API-shape evidence. It does not prove deployed
Cloudflare durability/latency, semantic retrieval quality, scheduler choice, or
that the proposed naming is final. The semantic processor is intentionally
explicit and deterministic so pending/fresh behavior can be asserted.

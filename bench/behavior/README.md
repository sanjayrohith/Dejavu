# Behavioral experiments

These are small, runnable experiments for dejavu's product claims. Retrieval scores
matter, but the stronger question is behavioral: does memory change what an
agent does?

The harness starts with deterministic, cheap experiments that do not require an
LLM. Each experiment states a hypothesis, runs a baseline and one or more
variants, and reports whether the variant would improve an agent-facing behavior
signal. When we add LLM-in-the-loop runs later, they should reuse these same
fixtures and success criteria.

Run all experiments:

```bash
bun run bench:behavior
```

Current experiments:

- `handoff-structure`: freeform vs structured handoff packets for interrupted work.
- `stale-preference`: old preference vs newer superseding preference.
- `recall-trigger-policy`: candidate MCP recall-trigger wording scored against a small prompt battery.

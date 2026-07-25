# Experiment 10 — shared-MCP local dogfood RESULT

started: 2026-05-24T10:07:38.028Z
finished: 2026-05-24T10:07:39.726Z
gateway: http://127.0.0.1:8793
mirror A: /Users/jcoeyman/cloudflare/dejavu/experiments/10-shared-mcp-local-dogfood/.tmp/a.sqlite
mirror B: /Users/jcoeyman/cloudflare/dejavu/experiments/10-shared-mcp-local-dogfood/.tmp/b.sqlite
tag: exp10-mpjm611v
recall marker: exptenmpjm611v
slip id: 01KSCQ8Q6MR5Y1D2S3JE985BGV

## Tools listed by both clients

`handoff, recall, remember, signal, status`

## Real MCP JSON-RPC stdio call log

```text
2026-05-24T10:07:38.029Z spawn — starting two shared-MCP stdio servers
2026-05-24T10:07:38.700Z tools/list A
2026-05-24T10:07:38.702Z tools/list A ok — handoff, recall, remember, signal, status
2026-05-24T10:07:38.702Z tools/list B
2026-05-24T10:07:38.703Z A status
2026-05-24T10:07:38.707Z A status ok — shared memory: live; mirror revision 0; authority head 0; behind 0; fresh=true
2026-05-24T10:07:38.707Z A remember
2026-05-24T10:07:38.712Z A remember ok — kept shared slip 01KSCQ8Q6MR5Y1D2S3JE985BGV — committed revision 1; immediately recallable
2026-05-24T10:07:38.712Z A remember slip — 01KSCQ8Q6MR5Y1D2S3JE985BGV
2026-05-24T10:07:38.712Z A handoff
2026-05-24T10:07:38.715Z A handoff ok — shared handoff 01KSCQ8Q6STENQ595JWGRR2PWQ — committed revision 2
2026-05-24T10:07:38.715Z settle — waiting 500ms for live feed
2026-05-24T10:07:39.216Z B status refresh
2026-05-24T10:07:39.220Z B status ok — shared memory: live; mirror revision 2; authority head 2; behind 0; fresh=true
2026-05-24T10:07:39.220Z B recall (expect slip + handoff)
2026-05-24T10:07:39.221Z B recall1 result — # latest shared handoff [rev 2] | Client A done; B should continue (exp10-mpjm611v) | next: B to recall and forget the slip |  | # shared recall("exptenmpjm611v") — mirror revision 2 | - 01KSCQ8Q6MR5Y1D2S3JE985BGV [rev 1] Decision: shared MCP local dogfood works end to end exptenmpjm611v (exp10-mpjm611v) [exp10-mpjm611v]
2026-05-24T10:07:39.221Z B signal forget — 01KSCQ8Q6MR5Y1D2S3JE985BGV
2026-05-24T10:07:39.223Z B signal ok — shared signal: 01KSCQ8Q6MR5Y1D2S3JE985BGV forget — committed revision 3
2026-05-24T10:07:39.724Z B recall (expect slip gone, handoff still present)
2026-05-24T10:07:39.725Z B recall2 result — # latest shared handoff [rev 2] | Client A done; B should continue (exp10-mpjm611v) | next: B to recall and forget the slip |  | # shared recall("exptenmpjm611v") — no local mirror hits at revision 3
2026-05-24T10:07:39.725Z A recall (cross-mirror convergence)
2026-05-24T10:07:39.726Z A recall result — # latest shared handoff [rev 2] | Client A done; B should continue (exp10-mpjm611v) | next: B to recall and forget the slip |  | # shared recall("exptenmpjm611v") — no local mirror hits at revision 3
2026-05-24T10:07:39.726Z done — all assertions passed
```

## Outcome

- A remember+handoff through MCP tool calls → real shared-server HTTP POST.
- B's mirror (separate sqlite) saw both events through the live feed, refresh, or
  pre-recall catch-up — recall returned the slip with the tag and the handoff.
- B signal forget through MCP propagated through the authority to A's mirror,
  proving the cross-client revisioned event path end-to-end via real MCP stdio.
- Handoffs are not slip-scoped and stayed visible after the slip was forgotten.

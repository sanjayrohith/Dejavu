# Experiment 09 — deployed live mirror feed

Experiment 08 proved the protocol locally: authoritative ordered events + SSE
feed + local SQLite/FTS mirror can make peer writes locally searchable quickly,
with `/events?since=` gap repair. Experiment 09 ports that authority into a real
Worker + Durable Object SQL shape so it can be measured over a deployed URL.

## Surfaces

- `POST /remember` — DO SQL commit; monotonic `revision` receipt.
- `GET /stream?since=N` — SSE feed from the DO.
- `GET /events?since=N` — ordered catch-up/gap repair.
- `GET /recall?q=...` — authoritative search sanity endpoint.
- `GET /health` — head revision + subscriber count.

The mirror client copied from experiment 08 maintains a contiguous applied
watermark and local SQLite FTS5 mirror. The harness measures:

- writer write → own local recall;
- authority write → peer mirror locally visible over feed;
- warm local recall;
- disconnect, stale freshness, reconnect catch-up;
- concurrent authority revision convergence.

## Run local first

```bash
cd experiments/09-deployed-live-mirror-feed
./run-local.sh
```

Writes `RESULT-local.md`. Local workerd proves shape only.

## Remote deploy is account-mutating

This experiment intentionally does **not** deploy automatically. To measure real
network/feed latency:

```bash
cd experiments/09-deployed-live-mirror-feed
wrangler whoami
wrangler deploy
REMOTE_URL=https://dejavu-exp09-deployed-live-mirror-feed.<subdomain>.workers.dev \
  ./remote-harness.sh
wrangler delete --name dejavu-exp09-deployed-live-mirror-feed --force
```

The disposable Workers.dev endpoint is unauthenticated experiment code. Delete it
after measurement. Product shared Dejavu must have authentication and connection
authorization.

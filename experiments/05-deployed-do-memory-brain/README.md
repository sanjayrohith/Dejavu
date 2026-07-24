# Experiment 05 — deployed real Cloudflare DO memory brain

## Hypothesis

Experiment 03 showed that a single Cloudflare Durable Object using
`ctx.storage.sql` satisfies Dejavu's shared-memory contract under
`wrangler dev --local`:

- receipt-then-recall is unconditional,
- cross-client visibility is free,
- 64 concurrent writers serialize cleanly with contiguous ids,
- there is no eventual anywhere.

Experiment 05 asks the natural next question:

> Does that contract hold the same way when the Worker + DO is actually
> deployed to Cloudflare and reached over the public internet, and what
> is the real, deployed-URL latency cost?

Local `wrangler dev` proves the *shape* of the system. Only a deployed
worker proves the *deployed-system numbers* (cold start, edge → DO
placement RTT, real storage commit path). Experiment 05 keeps the contract
tests identical to experiments 01 and 03 so the RESULT files line up, and
adds remote-mode runs that measure what happens over a real workers.dev
URL.

## Account-mutating note

**This experiment is the first in the Dejavu series that can mutate your
Cloudflare account.** Local proof (`run-local.sh`) does not — it runs
`wrangler dev --local` against loopback and never touches the CF API. But
to measure deployed latency you have to run `wrangler deploy`, which:

- creates / updates a Worker named `dejavu-exp05-deployed-do-memory-brain`
  in your authenticated CF account,
- registers a Durable Object class `BrainDO` and provisions DO storage
  for the `singleton` id on first request,
- (if you also set `workers_dev = true` in `wrangler.toml`) publishes a
  `*.workers.dev` URL.

Nothing in this directory deploys for you. `remote-harness.sh` refuses to
do anything except `curl` and `node ./harness.mjs` against a URL you pass
in via `REMOTE_URL`. Deployment is an explicit decision made by the human
running this experiment, never by the harness.

To clean up later:

```bash
wrangler delete                  # deletes the worker
# DO storage for the singleton DO is released along with the worker;
# see https://developers.cloudflare.com/durable-objects/ for current
# behavior on DO deletion.
```

## Architecture (same as experiment 03)

```text
        HTTP clients (harness, MCP, agents)
        ┌────────┬────────┐
        │ alice  │ bob    │   ... separate fetch() callers
        └───┬────┴───┬────┘
            ▼        ▼
        ┌──────────────────┐
        │  Worker (router)  │   ← env.BRAIN.idFromName("singleton")
        └────────┬──────────┘
                 ▼
        ┌──────────────────────────────┐
        │  Durable Object: BrainDO     │   ← single-threaded execution
        │  ┌────────────────────────┐  │
        │  │ ctx.storage.sql        │  │   ← real DO SQL (libSQL/SQLite)
        │  │   memory(id, ulid, …)  │  │
        │  │   memory_fts (FTS5)    │  │   ← or LIKE fallback
        │  └────────────────────────┘  │
        └──────────────────────────────┘
```

Differences from experiment 03's worker:

- Unique worker name `dejavu-exp05-deployed-do-memory-brain` — never
  collides with experiment 03 or any other worker in the account.
- `/health` returns a `build` tag and `lastId` so the harness can confirm
  it hit the build it expected and anchor concurrency assertions.
- `/reset` is exposed only when the worker was deployed with
  `DEJAVU_EXP_ALLOW_RESET=1` in its env (or `wrangler secret put` it).
  Without that env var the endpoint returns 403. This keeps a destructive
  endpoint off by default but lets `remote-harness.sh --reset` start from
  a clean DO when you explicitly opt in.

## Files

- `wrangler.toml` — worker name `dejavu-exp05-deployed-do-memory-brain`,
  DO binding `BRAIN` → class `BrainDO`, `new_sqlite_classes = ["BrainDO"]`,
  `workers_dev = false` (flip to `true` in your own copy if you want a
  public preview URL).
- `src/worker.ts` — Worker + `BrainDO`. Adapted from experiment 03 with
  the deployed-shape additions above.
- `harness.mjs` — Node 22 native `fetch` runner. Supports `--mode local`
  and `--mode remote`, `--reset`, configurable `--concurrent`/`--sequential`
  /`--warm`.
- `run-local.sh` — boots `wrangler dev --local`, runs the harness, writes
  `RESULT-local.md`. Never deploys.
- `remote-harness.sh` — points the harness at a URL you provide via
  `REMOTE_URL`. Never deploys. Refuses loopback and non-https URLs.
- `package.json` — `npm run dev`, `npm run run:local`, `npm run run:remote`.
  `npm run deploy` deliberately prints instructions instead of running
  `wrangler deploy` — deployment is a human decision.

## Run it

### Local proof (no account mutation)

```bash
bash ./run-local.sh
```

Defaults to port `8875`; override with `PORT=9000 bash ./run-local.sh`.
Writes `RESULT-local.md`.

### Deploy (account-mutating — your call, not the harness's)

```bash
# 1. Make sure you are logged into the account you want to deploy to.
wrangler whoami

# 2. Optional: enable /reset on the deployed worker so the remote harness
#    can start from a clean DO. Skip this if you want /reset disabled.
wrangler secret put DEJAVU_EXP_ALLOW_RESET   # paste: 1

# 3. Deploy.
wrangler deploy

# 4. Note the workers.dev URL printed by wrangler (only printed if
#    `workers_dev = true` in wrangler.toml). If you keep workers_dev=false
#    you'll need a route or a custom domain to reach the worker — set up
#    however you normally reach Workers in your account.
```

### Remote harness (no deploy, just measure)

```bash
REMOTE_URL=https://dejavu-exp05-deployed-do-memory-brain.<your-subdomain>.workers.dev \
  bash ./remote-harness.sh
```

Optional env vars: `LABEL`, `RESET=1`, `CONCURRENT`, `SEQUENTIAL`, `WARM`,
`OUT`. The script refuses to run against loopback or http URLs — those
are run-local territory.

Writes `RESULT-remote.md` (or `$OUT`).

### Side-by-side comparison

Run both, then diff:

```bash
bash ./run-local.sh
REMOTE_URL=https://... bash ./remote-harness.sh
diff RESULT-local.md RESULT-remote.md
```

The contract sections (tests 1–3) should match. The latency section
(test 4) is where local-vs-deployed reality shows up.

## What this experiment will NOT do

- It will not deploy on its own. `wrangler deploy` is a human keystroke.
- It will not delete the worker on its own. `wrangler delete` is a human
  keystroke.
- It will not run against an arbitrary URL silently. `remote-harness.sh`
  preflights `/health`, refuses loopback, refuses http, and prints the
  URL it's about to hit.

## Honest limitations

- Single DO id (`idFromName("singleton")`). Sharding / placement across
  many DOs is not modeled.
- `workers.dev` hostnames have different routing characteristics than
  zones with a route or custom domain. The latency number you get is for
  whichever URL you point `REMOTE_URL` at.
- Test 3's burst is bounded by the harness host's outbound HTTP
  concurrency, not by the DO itself.
- ULID is `crypto.getRandomValues`-based, not time-sortable. Matches the
  rest of the series; not production-grade.
- No auth, no quotas, no eviction, no embeddings — orthogonal to the
  contract this experiment exists to retest under real network conditions.

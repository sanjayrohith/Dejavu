# Contributing to Dejavu

Thanks for your interest in improving this project. Contributions are
welcome through GitHub Issues and Pull Requests, subject to the terms
below.

## Before You Contribute

This project is licensed under a proprietary license, not a standard
open-source license. See [LICENSE.md](LICENSE.md) for the full terms.
The short version:

- The Owner (Sanjay Rohith) retains full ownership of this project and
  everything in it, including any code you contribute.
- You may not copy, resell, or use this project (or any part of it) as
  the base for another project.
- You *can* open Issues and submit Pull Requests.

**By opening a Pull Request, submitting a patch, or filing an Issue with
code or content attached, you agree to the terms in LICENSE.md,
including Section 3 (Contributions).** In short: you're granting the
Owner an irrevocable, royalty-free license to use and incorporate your
contribution into the project, and you won't gain any ownership stake or
usage rights beyond what LICENSE.md already permits.

If you don't agree to those terms, please don't submit a Contribution —
opening an Issue to report a bug or suggest an idea without attaching
code is always fine and doesn't require agreement to Section 3.

## How to Contribute

1. **Open an Issue first** for anything beyond a trivial fix (typos,
   small bug fixes). This lets us agree on the approach before you spend
   time on it.
2. **Fork and branch** from the latest `main`.
3. **Keep Pull Requests focused** — one fix or feature per PR makes
   review faster.
4. **Describe your change** in the PR: what it does, why it's needed,
   and how you tested it.
5. **Be responsive to review feedback.** The Owner has final say on
   whether a contribution is merged.

## Verifying a Change

One command runs the whole release gate:

```bash
bun run check
```

`.github/workflows/ci.yml` runs the same command on every push and pull
request against `main`, plus the `shared-server` unit tests `bun run
check` doesn't cover on its own — run it locally first so a red PR isn't
the first you hear of a regression.

That is the test suite, a strict TypeScript check, and four benchmarks
that each fail the build rather than merely reporting a number:

| Benchmark | Guards |
|---|---|
| `bench/recall.ts` | lexical recall@1 across the smoke corpus |
| `bench:anchors` | anchor drift-check overhead inside the recall budget |
| `bench:session` | cold-process session hook latency inside the harness exit budget |
| `bench:behavior` | tool-wording proxy experiments |

`bench:session` carries its own `--no-worktree` control arm, so the cost
of a change to session startup is measured against itself on your
machine rather than against a number recorded on somebody else's.

Two conventions worth knowing before you propose a change:

- **Retrieval changes need evidence.** Anything that alters what recall
  returns, or in what order, is expected to come with an eval rather than
  an argument. `eval/next-agent/` is a retained negative result — a
  ranker that sounded sensible and was rejected on measurement.

  There is now a tool for this. Capture what today's retrieval does,
  make your change, and capture it again:

  ```bash
  dejavu eval --replay --json > before.json
  #   ...change retrieval...
  dejavu eval --replay --json > after.json
  diff before.json after.json
  ```

  That re-runs every retrieval recorded in your own database, as of the
  moment each one was served, so memory written since your receipts
  can't be mistaken for an improvement. Paste the diff into the PR. Note
  what it is *not*: a difference is not automatically a regression — an
  intentional improvement shows up in the same `changed` column, and
  that is a fine thing to argue for as long as the number is on the
  table.

- **Claims live in [`docs/bench/claims.md`](docs/bench/claims.md).** If a
  change lets the project say something new, add the row and mark it
  honestly. "Hypothesis" with a named next experiment is a perfectly good
  state for a shipped feature to be in.

## What Happens After You Submit

- The Owner will review your Issue or PR and may accept it, request
  changes, or decline it.
- Accepted contributions become part of the project under the terms of
  LICENSE.md. You will not receive ownership, royalties, or a separate
  license to reuse the merged code outside this project.
- Credit for contributions may be given (e.g., in commit history or
  release notes) as a courtesy, but is not an obligation under the
  license.

## Questions

For anything not covered here, reach out to sanjayrohith1802@gmail.com.

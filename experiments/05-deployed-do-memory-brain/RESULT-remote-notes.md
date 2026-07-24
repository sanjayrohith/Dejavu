# Experiment 05 — remote run notes

Remote harness was run on 2026-05-18 against a disposable deployed Worker:

- worker: `dejavu-exp05-deployed-do-memory-brain`
- URL: `https://dejavu-exp05-deployed-do-memory-brain.cloudflare-support-chat.workers.dev`
- account selected by Wrangler: `Agent Experience` (`31b91e7f9954ad8aa334d46f012bd8ed`)
- version id from deploy: `27b0c3e8-52e3-4c22-ac66-6e03c355aca0`

The public Worker was deleted immediately after measurement:

```text
Successfully deleted dejavu-exp05-deployed-do-memory-brain
```

A follow-up `wrangler deployments status --name dejavu-exp05-deployed-do-memory-brain`
returned Worker-not-found (`code: 10007`), confirming cleanup.

## Guardrail note

The deployment guardrail correctly warned that the disposable Workers.dev test
endpoint was unauthenticated. That openness was acceptable only for this short,
disposable experiment endpoint; it is **not** acceptable for shared Dejavu itself.
The Worker was removed after the remote harness completed.

## Harness note

The first remote-harness invocation exposed a Bash `set -u` bug when the optional
reset flag array was empty. `remote-harness.sh` was fixed to construct an argument
array conditionally, then the remote run completed and wrote `RESULT-remote.md`.

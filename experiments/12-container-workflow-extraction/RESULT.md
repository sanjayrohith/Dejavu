# Result: durable lifecycle proven, combined extraction not reliable locally

- **Date:** 2026-06-11
- **Wrangler:** 4.99.0
- **Supermemory:** real local server at `127.0.0.1:6767`
- **Verdict:** **No**, not end-to-end in this local setup.

## Combined Container + Workflow observation

Wrangler accepted both real bindings, built the bridge image, and started the local Workflow runtime. The Workflow made three durable attempts to execute its `start container bridge` step. Every attempt failed at the Container supervisor boundary:

```text
Uncaught Error: Network connection lost.
Container error: [Error: Container failed to start]
container health HTTP 500: Failed to start container: Container failed to start
```

The named Workflow instance ended as `errored` with that error available from `GET /receipts/:id`. This is not an application-level fake or a Supermemory failure: Supermemory had not yet been called.

The boundary was further isolated:

- Docker was live under the `colima` context.
- Wrangler successfully built `cloudflare-dev/extractioncontainer:...`.
- The same image ran directly with Docker despite its amd64/arm64 emulation warning.
- Direct requests to its `/health` returned 200.
- Requests through its `/supermemory/` bridge returned the real Supermemory HTML from the host.

Thus the image, process, exposed port, host bridge, and Supermemory connectivity all work independently. Local Wrangler's Container lifecycle/supervisor failed to start that image on this arm64 Colima environment. `MODE=container ./run.sh` reproduces it.

## Workflow-only control

`MODE=workflow-only ./run.sh` removed the Container/DO binding but retained the same real `WorkflowEntrypoint`, durable steps, sleeps, retries, API calls, and receipt endpoint. It passed.

Observed run:

- marker / Workflow ID: `exp12-1781170984492-43fc80c5e6a340518f5b162b31b9645e`
- Supermemory document ID: `XuBNZfn91ipbUe1EEwEEaN`
- Workflow status: `complete`
- transport: `direct`
- durable status observations: `embedding`, then 17 `indexing` polls, then `failed`
- receipt preserved the exact marker in `customId`, metadata, and content
- replaying `POST /v3/documents` with the same `customId` returned `XuBNZfn91ipbUe1EEwEEaN`, proving safe submit retry behavior

The polling occurred across named `step.do` calls separated by `step.sleep`; the final structured output was inspectable via the real local Workflow instance API exposed by the Worker.

## Interpretation

Cloudflare Workflows materially improve reliability of the **control plane**:

- submit and poll are bounded, retryable durable steps;
- submission is idempotent through Supermemory `customId`;
- intermediate states survive as Workflow progress;
- terminal failure is explicit and inspectable rather than mistaken for success.

They did not make extraction itself succeed. The real local Supermemory server accepted and stored the synthetic document, spent about 18 seconds embedding/indexing, and ended at `failed` with no summary. In addition, local Container parity blocked the intended combined topology before submission.

The experiment therefore rejects the broad claim that Containers + Workflows currently make local asynchronous Supermemory extraction reliable. It supports the narrower claim that the Workflow contract reliably reports and safely retries the lifecycle. A deployed Container test (or a fixed local Container supervisor) plus diagnosis of Supermemory's terminal `failed` state is required before claiming end-to-end reliability.
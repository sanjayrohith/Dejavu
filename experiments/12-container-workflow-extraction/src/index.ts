import { Container } from "@cloudflare/containers";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { assertMarker, extractionBody, TERMINAL_STATUSES } from "./contract";

interface Params { marker: string; apiKey: string; baseUrl?: string; maxPolls?: number }
interface Poll { attempt: number; status: string; observedAt: string }
interface Receipt {
  workflowId: string;
  marker: string;
  documentId: string;
  transport: "container" | "direct";
  terminalStatus: string;
  polls: Poll[];
  submittedAt: string;
  finishedAt: string;
  document: unknown;
}
interface Env {
  EXTRACTION_WORKFLOW: Workflow<Params>;
  EXTRACTION_CONTAINER?: DurableObjectNamespace;
}

export class ExtractionContainer extends Container {
  defaultPort = 8080;
  requiredPorts = [8080];
  pingEndpoint = "health";
  sleepAfter = "2m";
}

async function checkedJson(response: Response, operation: string): Promise<any> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${operation} HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

export class ExtractionWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<Receipt> {
    assertMarker(event.payload.marker);
    const { marker, apiKey } = event.payload;
    if (!apiKey) throw new Error("apiKey is required");
    const container = this.env.EXTRACTION_CONTAINER?.getByName("supermemory-bridge");
    const transport = container ? "container" : "direct";
    const baseUrl = event.payload.baseUrl ?? "http://127.0.0.1:6767";
    const call = (path: string, init?: RequestInit) => container
      ? container.fetch(`http://container/supermemory${path}`, init)
      : fetch(`${baseUrl}${path}`, init);

    if (container) {
      await step.do("start container bridge", { retries: { limit: 2, delay: "1 second", backoff: "linear" }, timeout: "2 minutes" }, async () => {
        const response = await container.fetch("http://container/health");
        return checkedJson(response, "container health");
      });
    }

    const submission = await step.do("idempotent submit", { retries: { limit: 3, delay: "1 second", backoff: "exponential" }, timeout: "30 seconds" }, async () => {
      return checkedJson(await call("/v3/documents", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(extractionBody(marker))
      }), "submit");
    });
    if (typeof submission.id !== "string") throw new Error("Supermemory submit response had no document id");
    const documentId = submission.id;
    const submittedAt = new Date().toISOString();
    const polls: Poll[] = [];
    let document: any = submission;
    const maxPolls = Math.min(Math.max(event.payload.maxPolls ?? 30, 1), 120);

    for (let attempt = 1; attempt <= maxPolls; attempt++) {
      document = await step.do(`poll document ${attempt}`, { retries: { limit: 3, delay: "1 second", backoff: "exponential" }, timeout: "30 seconds" }, async () =>
        checkedJson(await call(`/v3/documents/${encodeURIComponent(documentId)}`, {
          headers: { authorization: `Bearer ${apiKey}` }
        }), "poll"));
      const status = String(document.status ?? "unknown");
      polls.push({ attempt, status, observedAt: new Date().toISOString() });
      if (TERMINAL_STATUSES.has(status)) {
        return {
          workflowId: event.instanceId,
          marker,
          documentId,
          transport,
          terminalStatus: status,
          polls,
          submittedAt,
          finishedAt: new Date().toISOString(),
          document
        };
      }
      await step.sleep(`wait after poll ${attempt}`, "1 second");
    }
    throw new Error(`document ${documentId} did not reach a terminal state after ${maxPolls} polls`);
  }
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, workflow: true, containerBinding: Boolean(env.EXTRACTION_CONTAINER) });
      }
      if (request.method === "POST" && url.pathname === "/extractions") {
        const params = await request.json<Params>();
        assertMarker(params.marker);
        const id = params.marker;
        const instance = await env.EXTRACTION_WORKFLOW.create({ id, params });
        return json({ id: instance.id, statusUrl: `/receipts/${encodeURIComponent(instance.id)}` }, 202);
      }
      if (request.method === "GET" && url.pathname.startsWith("/receipts/")) {
        const id = decodeURIComponent(url.pathname.slice("/receipts/".length));
        const status = await (await env.EXTRACTION_WORKFLOW.get(id)).status();
        return json({ id, ...status });
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }
} satisfies ExportedHandler<Env>;

import http from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ResponseItemCache, ReferenceError, expandReferences } from "./adapter-core.mjs";
import { requestFeatures, responseFeatures, sanitizeFailure } from "./redaction.mjs";

const port = Number(process.env.ADAPTER_PORT ?? 18981);
const upstream = new URL(process.env.OLLAMA_URL ?? "http://127.0.0.1:11434");
const artifact = process.env.ADAPTER_ARTIFACT;
if (!artifact) throw new Error("ADAPTER_ARTIFACT is required");
await mkdir(dirname(artifact), { recursive: true });
const cache = new ResponseItemCache({ maxEntries: Number(process.env.ADAPTER_MAX_ENTRIES ?? 256), ttlMs: Number(process.env.ADAPTER_TTL_MS ?? 600_000) });
const variant = process.env.ADAPTER_VARIANT ?? "exact";
let sequence = 0;
let passthrough = 0;

async function record(event) {
  await appendFile(artifact, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/__adapter/stats") return sendJson(res, 200, { ...cache.stats(), passthrough_requests: passthrough, variant });
  const started = performance.now();
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawRequest = Buffer.concat(chunks).toString("utf8");
  let body;
  try { body = rawRequest ? JSON.parse(rawRequest) : null; } catch { body = null; }
  const id = ++sequence;
  const endpoint = req.url?.split("?")[0];
  const incoming = body ? requestFeatures(body) : null;
  let forwardedBody = body;
  let expanded = 0;
  try {
    if (endpoint === "/v1/responses" && req.method === "POST") {
      if (rawRequest && !body) throw new ReferenceError("invalid_json", "Responses request must be valid JSON");
      ({ body: forwardedBody, expanded } = expandReferences(body, cache, { variant }));
    } else passthrough++;
    await record({ schemaVersion: 1, id, at: new Date().toISOString(), direction: "request", method: req.method, endpoint, authorization_present: Boolean(req.headers.authorization), incoming, adaptation: { variant, expanded_references: expanded, forwarded_input_types: Array.isArray(forwardedBody?.input) ? forwardedBody.input.map((x) => x?.type ?? "message") : [] } });
    const target = new URL(req.url ?? "/", upstream);
    const forwardedRaw = body ? JSON.stringify(forwardedBody) : rawRequest;
    const response = await fetch(target, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([key]) => !["host", "content-length", "connection"].includes(key))),
      body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : forwardedRaw
    });
    const rawResponse = await response.text();
    if (endpoint === "/v1/responses" && response.ok) {
      let parsed;
      try { parsed = JSON.parse(rawResponse); } catch { throw new ReferenceError("invalid_upstream_response", "successful Responses output was not JSON"); }
      cache.store(parsed);
    }
    await record({ schemaVersion: 1, id, at: new Date().toISOString(), direction: "response", endpoint, duration_ms: Math.round(performance.now() - started), adaptation: { expanded_references: expanded }, ...responseFeatures(response.status, response.headers, rawResponse) });
    res.writeHead(response.status, Object.fromEntries([...response.headers].filter(([key]) => !["content-encoding", "content-length", "transfer-encoding"].includes(key))));
    res.end(rawResponse);
  } catch (error) {
    const closed = error instanceof ReferenceError;
    await record({ schemaVersion: 1, id, at: new Date().toISOString(), direction: "adapter_failure", endpoint, duration_ms: Math.round(performance.now() - started), fail_closed: closed, code: closed ? error.code : "upstream_failure", failure: sanitizeFailure(error) });
    sendJson(res, closed ? (error.code === "reference_collision" ? 502 : 409) : 502, { error: { type: "adapter_fail_closed", code: closed ? error.code : "upstream_failure", message: "request rejected by local Responses compatibility adapter; see redacted evidence" } });
  }
});

server.listen(port, "127.0.0.1", () => console.log(`Responses adapter listening on ${port}; variant=${variant}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));

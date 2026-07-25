import http from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { requestFeatures, responseFeatures, sanitizeFailure } from "./redaction.mjs";

const port = Number(process.env.PROXY_PORT ?? 18880);
const upstream = new URL(process.env.OLLAMA_URL ?? "http://127.0.0.1:11434");
const artifact = process.env.PROXY_ARTIFACT;
if (!artifact) throw new Error("PROXY_ARTIFACT is required");
await mkdir(dirname(artifact), { recursive: true });
let sequence = 0;

async function record(event) {
  await appendFile(artifact, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

const server = http.createServer(async (req, res) => {
  const started = performance.now();
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawRequest = Buffer.concat(chunks).toString("utf8");
  let body;
  try { body = rawRequest ? JSON.parse(rawRequest) : null; } catch { body = null; }
  const id = ++sequence;
  const requestRecord = {
    schemaVersion: 1,
    id,
    at: new Date().toISOString(),
    direction: "request",
    method: req.method,
    endpoint: req.url?.split("?")[0],
    authorization_present: Boolean(req.headers.authorization),
    content_type: req.headers["content-type"] ?? null,
    body_parse: rawRequest ? (body ? "json" : "non-json") : "empty",
    features: body ? requestFeatures(body) : null
  };
  await record(requestRecord);

  try {
    const target = new URL(req.url ?? "/", upstream);
    const response = await fetch(target, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([key]) => !["host", "content-length", "connection"].includes(key))),
      body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : rawRequest
    });
    const rawResponse = await response.text();
    await record({ schemaVersion: 1, id, at: new Date().toISOString(), direction: "response", endpoint: requestRecord.endpoint, duration_ms: Math.round(performance.now() - started), ...responseFeatures(response.status, response.headers, rawResponse) });
    res.writeHead(response.status, Object.fromEntries([...response.headers].filter(([key]) => !["content-encoding", "content-length", "transfer-encoding"].includes(key))));
    res.end(rawResponse);
  } catch (error) {
    await record({ schemaVersion: 1, id, at: new Date().toISOString(), direction: "proxy_failure", endpoint: requestRecord.endpoint, duration_ms: Math.round(performance.now() - started), failure: sanitizeFailure(error) });
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "proxy_upstream_failure", message: "upstream request failed; see redacted artifact" } }));
  }
});

server.listen(port, "127.0.0.1", () => console.log(`recording proxy listening on ${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));

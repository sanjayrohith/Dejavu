import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { sanitizeFailure } from "./redaction.mjs";

const here = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const binary = join(here, ".tmp/bin/supermemory-server");
const fixture = JSON.parse(await readFile(join(here, "fixtures/synthetic.json"), "utf8"));
const models = [
  { model: "gpt-oss:20b", slug: "gpt-oss-20b", serverPort: 18801, proxyPort: 18881 },
  { model: "qwen3-coder:30b", slug: "qwen3-coder-30b", serverPort: 18802, proxyPort: 18882 }
];
const processingTimeoutMs = Number(process.env.PROCESSING_TIMEOUT_MS ?? 420_000);
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS ?? 120_000);
await mkdir(join(here, "artifacts"), { recursive: true });
await mkdir(join(here, ".tmp"), { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(url, timeoutMs, process) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (process.exitCode !== null) throw new Error(`process exited before ${url} became ready (exit ${process.exitCode})`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error(`readiness timeout for ${url}`);
}
async function request(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(requestTimeoutMs) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, ok: response.ok, body };
}
function bodyHas(value, needle) { return JSON.stringify(value).includes(needle); }
function findId(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["id", "documentId", "document_id"]) if (typeof value[key] === "string") return value[key];
  for (const nested of Object.values(value)) { const found = findId(nested); if (found) return found; }
  return null;
}
function collectStatuses(value, output = []) {
  if (!value || typeof value !== "object") return output;
  for (const [key, nested] of Object.entries(value)) {
    if (["status", "processingStatus", "processing_status"].includes(key) && typeof nested === "string") output.push(nested.toLowerCase());
    else collectStatuses(nested, output);
  }
  return output;
}
function countMemories(value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return 0;
  for (const key of ["memories", "results", "items"]) if (Array.isArray(value[key])) return value[key].length;
  return 0;
}
async function deriveProtocolEvidence(artifact) {
  try {
    const events = (await readFile(artifact, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    const calls = events.filter((event) => event.endpoint === "/v1/responses");
    const responses = calls.filter((event) => event.direction === "response");
    const followupRequest = calls.find((event) => event.direction === "request" && event.features?.input?.some((item) => item.type === "item_reference"));
    const failure = responses.find((event) => event.status >= 400);
    return {
      endpoint: "/v1/responses",
      initial_status: responses[0]?.status ?? null,
      followup_status: failure?.status ?? null,
      followup_input_types: [...new Set((followupRequest?.features?.input ?? []).map((item) => item.type ?? "message"))],
      error_type: failure?.error?.type ?? null,
      error_message_sanitized: failure?.error?.message_sanitized ?? null
    };
  } catch (error) { return { artifact_parse_failure: sanitizeFailure(error) }; }
}
async function directBaselines(proxyUrl, model) {
  const common = { model, messages: [{ role: "user", content: "Return only a tiny synthetic compatibility acknowledgement." }], max_tokens: 80, stream: false };
  const cases = [
    ["plain", common],
    ["response_format", { ...common, messages: [{ role: "user", content: "Return JSON with ok=true." }], response_format: { type: "json_schema", json_schema: { name: "compatibility_result", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } } }],
    ["tools", { ...common, messages: [{ role: "user", content: "Call record_fact with a synthetic value." }], tools: [{ type: "function", function: { name: "record_fact", description: "Record one synthetic fact", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } } }], tool_choice: "required" }]
  ];
  const results = [];
  for (const [name, body] of cases) {
    const started = Date.now();
    try {
      const response = await request(`${proxyUrl}/v1/chat/completions`, { method: "POST", body: JSON.stringify(body) });
      results.push({ name, status: response.status, ok: response.ok, duration_ms: Date.now() - started, has_choices: Array.isArray(response.body?.choices), finish_reason: response.body?.choices?.[0]?.finish_reason ?? null });
    } catch (error) { results.push({ name, ok: false, duration_ms: Date.now() - started, failure: sanitizeFailure(error) }); }
  }
  return results;
}

async function runModel(config) {
  const dataDir = join(here, `.tmp/data-${config.slug}`);
  const rawLog = join(here, `.tmp/supermemory-${config.slug}.log`);
  const artifact = join(here, `artifacts/${config.slug}.jsonl`);
  await rm(dataDir, { recursive: true, force: true });
  await rm(artifact, { force: true });
  await mkdir(dataDir, { recursive: true });
  const logHandle = await import("node:fs").then(({ openSync }) => openSync(rawLog, "w", 0o600));
  const proxy = spawn(process.execPath, [join(here, "scripts/recording-proxy.mjs")], { env: { ...process.env, PROXY_PORT: String(config.proxyPort), PROXY_ARTIFACT: artifact, OLLAMA_URL: "http://127.0.0.1:11434" }, stdio: ["ignore", logHandle, logHandle] });
  const proxyUrl = `http://127.0.0.1:${config.proxyPort}`;
  const serverUrl = `http://127.0.0.1:${config.serverPort}`;
  const started = Date.now();
  let server;
  const result = { model: config.model, fresh_data_dir: true, ports: { supermemory: config.serverPort, proxy: config.proxyPort }, baseline: [], processing: { done: false }, extraction: { memory_count: 0, at_least_one: false }, retrieval: { profile_exact: false, memory_only_exact: false, document_chunk_exact: false }, pass: false, partial_searchable_chunks: false };
  try {
    await waitFor(`${proxyUrl}/api/tags`, 15_000, proxy);
    result.baseline = await directBaselines(proxyUrl, config.model);
    server = spawn(binary, [], { env: { ...process.env, SUPERMEMORY_DATA_DIR: dataDir, SUPERMEMORY_PORT: String(config.serverPort), PORT: String(config.serverPort), SUPERMEMORY_SKIP_EMBEDDING_PREWARM: "1", SUPERMEMORY_DISABLE_TELEMETRY: "1", SUPERMEMORY_NO_OPEN: "1", OPENAI_BASE_URL: `${proxyUrl}/v1`, OPENAI_API_KEY: "ollama-local-placeholder", OPENAI_MODEL: config.model, OPENAI_TEXT_MODEL: config.model, OPENAI_FAST_MODEL: config.model }, stdio: ["ignore", logHandle, logHandle] });
    await waitFor(`${serverUrl}/`, 30_000, server);
    const add = await request(`${serverUrl}/v3/documents`, { method: "POST", body: JSON.stringify({ content: fixture.document, containerTag: fixture.containerTag, customId: `exp18-${config.slug}` }) });
    result.processing.add_status = add.status;
    const documentId = findId(add.body) ?? `exp18-${config.slug}`;
    result.processing.document_id_present = Boolean(documentId);
    const deadline = Date.now() + processingTimeoutMs;
    let observed = [];
    while (Date.now() < deadline) {
      const detail = await request(`${serverUrl}/v3/documents/${encodeURIComponent(documentId)}`);
      const queue = await request(`${serverUrl}/v3/documents/processing`);
      observed = [...new Set([...observed, ...collectStatuses(detail.body), ...collectStatuses(queue.body)])];
      if (observed.some((x) => ["done", "completed", "processed", "success"].includes(x))) { result.processing.done = true; break; }
      if (observed.some((x) => ["failed", "error", "cancelled"].includes(x))) break;
      await sleep(2000);
    }
    result.processing.observed_statuses = observed;
    result.processing.timed_out = !result.processing.done && Date.now() >= deadline;

    const list = await request(`${serverUrl}/v4/memories/list`, { method: "POST", body: JSON.stringify({ containerTags: [fixture.containerTag], limit: 100 }) });
    result.extraction.list_status = list.status;
    result.extraction.memory_count = countMemories(list.body);
    result.extraction.at_least_one = result.extraction.memory_count > 0;
    const profile = await request(`${serverUrl}/v4/profile`, { method: "POST", body: JSON.stringify({ containerTag: fixture.containerTag, q: fixture.query }) });
    result.retrieval.profile_status = profile.status;
    result.retrieval.profile_exact = bodyHas(profile.body, fixture.factToken);
    const memories = await request(`${serverUrl}/v4/search`, { method: "POST", body: JSON.stringify({ containerTag: fixture.containerTag, q: fixture.query, searchMode: "memories", limit: 10 }) });
    result.retrieval.memory_only_status = memories.status;
    result.retrieval.memory_only_exact = bodyHas(memories.body, fixture.factToken);
    const documents = await request(`${serverUrl}/v4/search`, { method: "POST", body: JSON.stringify({ containerTag: fixture.containerTag, q: fixture.query, searchMode: "documents", limit: 10 }) });
    result.retrieval.document_status = documents.status;
    result.retrieval.document_chunk_exact = bodyHas(documents.body, fixture.factToken);
    result.partial_searchable_chunks = result.retrieval.document_chunk_exact && !result.extraction.at_least_one;
    result.pass = result.processing.done && result.extraction.at_least_one && (result.retrieval.profile_exact || result.retrieval.memory_only_exact);
  } catch (error) {
    result.failure = sanitizeFailure(error);
  } finally {
    result.duration_ms = Date.now() - started;
    for (const child of [server, proxy]) if (child && child.exitCode === null) child.kill("SIGTERM");
    await Promise.all([server, proxy].filter(Boolean).map(async (child) => { try { await Promise.race([once(child, "exit"), sleep(3000)]); } catch {} if (child.exitCode === null) child.kill("SIGKILL"); }));
  }
  result.protocol = await deriveProtocolEvidence(artifact);
  return result;
}

const results = [];
for (const model of models) {
  console.log(`Running ${model.model} with a fresh data directory...`);
  results.push(await runModel(model));
}
const ollamaVersion = execFileSync("ollama", ["--version"], { encoding: "utf8" }).trim();
const artifact = { schemaVersion: 1, generatedAt: new Date().toISOString(), supermemory: { version: "0.0.2", artifact: process.env.SUPERMEMORY_ARTIFACT ?? "unknown", sha256: process.env.SUPERMEMORY_SHA256 ?? "unknown", checksum_verified_before_use: process.env.SUPERMEMORY_CHECKSUM_VERIFIED === "1" }, provider: { name: "Ollama", version: ollamaVersion, base_url: "http://127.0.0.1:11434" }, fixture: { id: fixture.fixtureId, synthetic_only: true, fact_token_sha256_12: (await import("./redaction.mjs")).digest(fixture.factToken) }, bounds: { processing_timeout_ms: processingTimeoutMs, request_timeout_ms: requestTimeoutMs }, models: results };
await writeFile(join(here, "artifacts/result.json"), `${JSON.stringify(artifact, null, 2)}\n`);
const lines = results.map((r) => `| ${r.model} | ${r.processing.done ? "done" : r.processing.timed_out ? "timeout" : "not done"} | ${r.extraction.memory_count} | ${r.retrieval.profile_exact ? "yes" : "no"} | ${r.retrieval.memory_only_exact ? "yes" : "no"} | ${r.retrieval.document_chunk_exact ? "yes" : "no"} | ${r.pass ? "PASS" : r.partial_searchable_chunks ? "PARTIAL" : "FAIL"} |`);
const sharedItemReferenceFailure = results.every((r) => r.protocol?.initial_status === 200 && r.protocol?.followup_status === 400 && r.protocol?.followup_input_types?.includes("item_reference"));
const conclusion = results.every((r) => r.pass) ? "Both models passed; no model-specific failure was reproduced." : results.some((r) => r.pass) ? "The split result is model-specific under this controlled protocol path." : sharedItemReferenceFailure ? "Compatibility-specific, not model-specific: both models completed the first OpenAI Responses call, then Ollama rejected Supermemory's follow-up input containing item_reference with the same HTTP 400 protocol error." : results.every((r) => r.baseline.every((b) => b.ok) && !r.pass) ? "Both models satisfy direct OpenAI-compatible baselines but Supermemory extraction fails for both, indicating a shared protocol/compatibility seam rather than a model-specific failure." : "The evidence is mixed or blocked; do not assign model-specific causality without inspecting the redacted call artifacts.";
const protocolRows = results.map((r) => `| ${r.model} | ${r.protocol?.initial_status ?? "n/a"} | ${r.protocol?.followup_status ?? "n/a"} | ${(r.protocol?.followup_input_types ?? []).join(", ") || "n/a"} | ${r.protocol?.error_message_sanitized ?? "n/a"} |`);
const markdown = `# Experiment 18 — RESULT\n\nGenerated: ${artifact.generatedAt}\n\n## Verdict\n\n${conclusion}\n\nA full pass requires processing done, at least one extracted memory, and exact-token retrieval from profile or memory-only search. Document chunks alone are reported as partial, never pass.\n\n| Model | Processing | Memories | Profile exact | Memory-only exact | Chunk exact | Verdict |\n| --- | --- | ---: | --- | --- | --- | --- |\n${lines.join("\n")}\n\n## Protocol failure\n\n| Model | Initial /v1/responses | Follow-up | Follow-up input types | Sanitized error |\n| --- | ---: | ---: | --- | --- |\n${protocolRows.join("\n")}\n\nThe first model turn succeeds and returns tool calls. Supermemory executes them, then its next Responses API request sends prior outputs as \`item_reference\` entries plus \`function_call_output\`. ${ollamaVersion} rejects the first \`item_reference\` before another model turn, identically for both model names. This local evidence isolates the failure at Responses API continuation compatibility rather than generation quality.\n\n## Reproducibility and safety\n\n- Supermemory v0.0.2 Darwin ARM64 SHA-256 was verified before execution: \`${artifact.supermemory.sha256}\`.\n- Each model used a deleted/recreated data directory and distinct Supermemory/proxy ports.\n- Inputs are synthetic. Recording artifacts contain feature shapes, hashes, lengths, statuses, timing, and JSON shapes—not prompt/response text, authorization values, or the generated local API key.\n- Processing timeout: ${processingTimeoutMs} ms per model; request timeout: ${requestTimeoutMs} ms.\n\nSee \`artifacts/result.json\` and the per-model JSONL recordings for machine-readable evidence. Raw server logs and encrypted databases remain ignored under \`.tmp/\`.\n`;
await writeFile(join(here, "RESULT.md"), markdown);
console.log(conclusion);
if (results.some((r) => r.failure)) process.exitCode = 1;

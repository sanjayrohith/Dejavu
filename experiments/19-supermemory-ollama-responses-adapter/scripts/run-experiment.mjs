import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { sanitizeFailure, digest } from "./redaction.mjs";

const here = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const binary = join(here, ".tmp/bin/supermemory-server");
const fixture = JSON.parse(await readFile(join(here, "fixtures/synthetic.json"), "utf8"));
const processingTimeoutMs = Number(process.env.PROCESSING_TIMEOUT_MS ?? 420_000);
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS ?? 120_000);
const models = [{ model: "qwen3-coder:30b", slug: "qwen3-coder-30b" }];
if (process.env.RUN_GPT_OSS === "1") models.push({ model: "gpt-oss:20b", slug: "gpt-oss-20b" });
await mkdir(join(here, "artifacts"), { recursive: true });
await mkdir(join(here, ".tmp"), { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(url, timeoutMs, child) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`process exited before readiness (exit ${child.exitCode})`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error("readiness timeout");
}
async function request(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(requestTimeoutMs) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, ok: response.ok, body };
}
function findId(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["id", "documentId", "document_id"]) if (typeof value[key] === "string") return value[key];
  for (const nested of Object.values(value)) { const found = findId(nested); if (found) return found; }
  return null;
}
function statuses(value, out = []) {
  if (!value || typeof value !== "object") return out;
  for (const [key, nested] of Object.entries(value)) {
    if (["status", "processingStatus", "processing_status"].includes(key) && typeof nested === "string") out.push(nested.toLowerCase());
    else statuses(nested, out);
  }
  return out;
}
function memoryCount(value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return 0;
  for (const key of ["memoryEntries", "memories", "results", "items"]) if (Array.isArray(value[key])) return value[key].length;
  return 0;
}
const hasToken = (value) => JSON.stringify(value).includes(fixture.factToken);
async function protocolSummary(path) {
  try {
    const events = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    const requests = events.filter((x) => x.direction === "request" && x.endpoint === "/v1/responses");
    const failures = events.filter((x) => x.direction === "adapter_failure");
    const responses = events.filter((x) => x.direction === "response" && x.endpoint === "/v1/responses");
    return {
      responses_statuses: responses.map((x) => x.status),
      followups_seen: requests.filter((x) => x.incoming?.input?.some((i) => i.type === "item_reference")).length,
      references_expanded: requests.reduce((n, x) => n + (x.adaptation?.expanded_references ?? 0), 0),
      forwarded_item_reference: requests.some((x) => x.adaptation?.forwarded_input_types?.includes("item_reference")),
      function_call_output_forwarded: requests.some((x) => x.adaptation?.forwarded_input_types?.includes("function_call_output")),
      fail_closed_codes: failures.map((x) => x.code),
      upstream_rejected_after_expansion: responses.some((x) => x.status >= 400 && (x.adaptation?.expanded_references ?? 0) > 0)
    };
  } catch (error) { return { artifact_failure: sanitizeFailure(error) }; }
}
async function stop(children) {
  for (const child of children) if (child && child.exitCode === null) child.kill("SIGTERM");
  await Promise.all(children.filter(Boolean).map(async (child) => { try { await Promise.race([once(child, "exit"), sleep(3000)]); } catch {} if (child.exitCode === null) child.kill("SIGKILL"); }));
}

async function runAttempt(config, variant, index) {
  const serverPort = 18901 + index;
  const adapterPort = 18981 + index;
  const suffix = variant === "exact" ? "exact" : variant;
  const dataDir = join(here, `.tmp/data-${config.slug}-${suffix}`);
  const artifactPath = join(here, `artifacts/${config.slug}-${suffix}.jsonl`);
  const rawLog = join(here, `.tmp/supermemory-${config.slug}-${suffix}.log`);
  await rm(dataDir, { recursive: true, force: true });
  await rm(artifactPath, { force: true });
  await mkdir(dataDir, { recursive: true });
  const logFd = (await import("node:fs")).openSync(rawLog, "w", 0o600);
  const adapter = spawn(process.execPath, [join(here, "scripts/responses-adapter.mjs")], { env: { ...process.env, ADAPTER_PORT: String(adapterPort), ADAPTER_ARTIFACT: artifactPath, ADAPTER_VARIANT: variant, OLLAMA_URL: "http://127.0.0.1:11434" }, stdio: ["ignore", logFd, logFd] });
  const adapterUrl = `http://127.0.0.1:${adapterPort}`;
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  let server;
  const result = { model: config.model, variant, fresh_data_dir: true, baseline_passthrough: {}, processing: { done: false }, extraction: { memory_count: 0, at_least_one: false }, retrieval: { profile_exact: false, memory_only_exact: false, document_chunk_exact: false }, pass: false, partial: false };
  try {
    await waitFor(`${adapterUrl}/__adapter/stats`, 15_000, adapter);
    const chat = await request(`${adapterUrl}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: "Return only OK." }], max_tokens: 16, stream: false }) });
    const responses = await request(`${adapterUrl}/v1/responses`, { method: "POST", body: JSON.stringify({ model: config.model, input: [{ role: "user", content: "Return only OK." }], max_output_tokens: 16 }) });
    result.baseline_passthrough = { chat_status: chat.status, responses_status: responses.status, ok: chat.ok && responses.ok };
    server = spawn(binary, [], { env: { ...process.env, SUPERMEMORY_DATA_DIR: dataDir, SUPERMEMORY_PORT: String(serverPort), PORT: String(serverPort), SUPERMEMORY_SKIP_EMBEDDING_PREWARM: "1", SUPERMEMORY_DISABLE_TELEMETRY: "1", SUPERMEMORY_NO_OPEN: "1", OPENAI_BASE_URL: `${adapterUrl}/v1`, OPENAI_API_KEY: "ollama-local-placeholder", OPENAI_MODEL: config.model, OPENAI_TEXT_MODEL: config.model, OPENAI_FAST_MODEL: config.model }, stdio: ["ignore", logFd, logFd] });
    await waitFor(`${serverUrl}/`, 30_000, server);
    const add = await request(`${serverUrl}/v3/documents`, { method: "POST", body: JSON.stringify({ content: fixture.document, containerTag: fixture.containerTag, customId: `exp19-${config.slug}-${suffix}` }) });
    result.processing.add_status = add.status;
    const documentId = findId(add.body) ?? `exp19-${config.slug}-${suffix}`;
    const deadline = Date.now() + processingTimeoutMs;
    let observed = [];
    while (Date.now() < deadline) {
      const detail = await request(`${serverUrl}/v3/documents/${encodeURIComponent(documentId)}`);
      const queue = await request(`${serverUrl}/v3/documents/processing`);
      observed = [...new Set([...observed, ...statuses(detail.body), ...statuses(queue.body)])];
      if (observed.some((x) => ["done", "completed", "processed", "success"].includes(x))) { result.processing.done = true; break; }
      if (observed.some((x) => ["failed", "error", "cancelled"].includes(x))) break;
      await sleep(2000);
    }
    result.processing.observed_statuses = observed;
    result.processing.timed_out = !result.processing.done && Date.now() >= deadline;
    const list = await request(`${serverUrl}/v4/memories/list`, { method: "POST", body: JSON.stringify({ containerTags: [fixture.containerTag], limit: 100 }) });
    result.extraction.list_status = list.status;
    result.extraction.memory_count = memoryCount(list.body);
    result.extraction.at_least_one = result.extraction.memory_count > 0;
    const profile = await request(`${serverUrl}/v4/profile`, { method: "POST", body: JSON.stringify({ containerTag: fixture.containerTag, q: fixture.query }) });
    result.retrieval.profile_status = profile.status;
    result.retrieval.profile_exact = hasToken(profile.body);
    const memories = await request(`${serverUrl}/v4/search`, { method: "POST", body: JSON.stringify({ containerTag: fixture.containerTag, q: fixture.query, searchMode: "memories", limit: 10 }) });
    result.retrieval.memory_only_status = memories.status;
    result.retrieval.memory_only_exact = hasToken(memories.body);
    const documents = await request(`${serverUrl}/v4/search`, { method: "POST", body: JSON.stringify({ containerTag: fixture.containerTag, q: fixture.query, searchMode: "documents", limit: 10 }) });
    result.retrieval.document_status = documents.status;
    result.retrieval.document_chunk_exact = hasToken(documents.body);
    result.pass = result.processing.done && result.extraction.at_least_one && (result.retrieval.profile_exact || result.retrieval.memory_only_exact);
    result.partial = !result.pass && result.retrieval.document_chunk_exact;
    result.adapter_stats = (await request(`${adapterUrl}/__adapter/stats`)).body;
  } catch (error) { result.failure = sanitizeFailure(error); }
  finally { await stop([server, adapter]); }
  result.protocol = await protocolSummary(artifactPath);
  return result;
}

const attempts = [];
let index = 0;
for (const model of models) {
  const exact = await runAttempt(model, "exact", index++);
  attempts.push(exact);
  if (!exact.pass && exact.protocol?.upstream_rejected_after_expansion) attempts.push(await runAttempt(model, "strip-output-metadata", index++));
}
const generatedAt = new Date().toISOString();
const evidence = { schemaVersion: 1, generatedAt, supermemory: { version: "0.0.2", artifact: process.env.SUPERMEMORY_ARTIFACT, sha256: process.env.SUPERMEMORY_SHA256, checksum_verified_before_use: process.env.SUPERMEMORY_CHECKSUM_VERIFIED === "1" }, provider: { name: "Ollama", version: execFileSync("ollama", ["--version"], { encoding: "utf8" }).trim() }, adapter: { max_entries: 256, ttl_ms: 600000, normalization_policy: "exact first; metadata stripping only after an upstream rejection" }, fixture: { id: fixture.fixtureId, synthetic_only: true, token_sha256_12: digest(fixture.factToken) }, bounds: { processing_timeout_ms: processingTimeoutMs, request_timeout_ms: requestTimeoutMs }, attempts };
await writeFile(join(here, "artifacts/result.json"), `${JSON.stringify(evidence, null, 2)}\n`);
const rows = attempts.map((r) => `| ${r.model} | ${r.variant} | ${r.baseline_passthrough.ok ? "yes" : "no"} | ${r.processing.done ? "done" : r.processing.timed_out ? "timeout" : "not done"} | ${r.extraction.memory_count} | ${r.retrieval.profile_exact ? "yes" : "no"} | ${r.retrieval.memory_only_exact ? "yes" : "no"} | ${r.retrieval.document_chunk_exact ? "yes" : "no"} | ${r.pass ? "PASS" : r.partial ? "PARTIAL" : "FAIL"} |`);
const winner = attempts.find((x) => x.pass);
const verdict = winner ? `PASS: ${winner.model} completed extraction through the ${winner.variant} adapter and returned the exact synthetic token from an allowed memory surface.` : attempts.some((x) => x.partial) ? "PARTIAL: document chunks were searchable, but the strict extraction and memory retrieval criteria were not met." : "FAIL: the strict extraction and memory retrieval criteria were not met.";
const resultMd = `# Experiment 19 — RESULT\n\nGenerated: ${generatedAt}\n\n## Verdict\n\n${verdict}\n\n| Model | Variant | Baseline passthrough | Processing | Memories | Profile exact | Memory-only exact | Chunk exact | Verdict |\n| --- | --- | --- | --- | ---: | --- | --- | --- | --- |\n${rows.join("\n")}\n\n## Adapter evidence\n\nThe adapter cached successful Responses output by response and item IDs, expanded references in place, and preserved function-call outputs. Exact expansion was always attempted first. The metadata-stripping variant was run only if Ollama rejected a follow-up after expansion. Unknown, expired/evicted, and colliding IDs fail closed. See the redacted JSONL and \`artifacts/result.json\` for statuses, expansion counts, forwarded type order, cache bounds, and fail-closed counters.\n\nChunk-only retrieval is PARTIAL, never PASS. Raw prompts, model output, credentials, generated API keys, databases, and server logs are excluded. Supermemory checksum verified before execution: \`${evidence.supermemory.sha256}\`.\n`;
await writeFile(join(here, "RESULT.md"), resultMd);
console.log(verdict);

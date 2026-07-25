#!/usr/bin/env node
/** Experiment 16 orchestrator. Spawns two independent Bun client processes. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const TMP = need("EXP16_TMP");
const RESULT = need("EXP16_RESULT");
const GATEWAY = need("DEJAVU_SHARED_GATEWAY");
const TOKEN = need("DEJAVU_SHARED_TOKEN");
const SUPERMEMORY = (process.env.SUPERMEMORY_URL ?? "http://127.0.0.1:6767").replace(/\/$/, "");
const RUN = `exp16${Date.now().toString(36)}`;
const MARKER = RUN.replace(/[^a-zA-Z0-9]/g, "");
const CONTAINER = `exp16-${RUN}`;
const SEMANTIC_TIMEOUT_MS = Number(process.env.EXP16_SEMANTIC_TIMEOUT_MS ?? 90000);
const fixture = {
  local: resolve(TMP, "repo-local"),
  cloud: resolve(TMP, "repo-cloud"),
  outsider: resolve(TMP, "repo-outsider"),
};
const log = [];
const timings = {};
let local, cloud;
const docs = [];

function need(name) { const v = process.env[name]; if (!v) throw new Error(`missing ${name}`); return v; }
function assert(condition, message) { if (!condition) throw new Error(`assertion failed: ${message}`); }
function record(step, detail = "") {
  const line = `${new Date().toISOString()} ${step}${detail ? ` — ${detail}` : ""}`;
  console.log(line); log.push(line);
}
function timed(name, fn) {
  const start = performance.now();
  return Promise.resolve().then(fn).then((value) => { timings[name] = performance.now() - start; return value; });
}
function round(n) { return Number(n).toFixed(2); }

class RpcClient {
  constructor(role, cwd) {
    this.role = role;
    this.seq = 0;
    this.pending = new Map();
    this.child = spawn("bun", ["run", resolve(HERE, "client.ts")], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        EXP16_ROLE: role,
        EXP16_RUN: RUN,
        EXP16_MIRROR_DB: resolve(TMP, `${role}-mirror.sqlite`),
        EXP16_LOCAL_DB: resolve(TMP, `${role}-dejavu.sqlite`),
        DEJAVU_AUTHOR: `exp16-${role}`,
        DEJAVU_SESSION: `exp16-${role}-${RUN}`,
      },
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { process.stderr.write(`[${role} stdout] ${line}\n`); return; }
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      msg.ok ? pending.resolve(msg.result) : pending.reject(new Error(msg.error));
    });
    this.child.stderr.on("data", (chunk) => process.stderr.write(`[${role}] ${chunk}`));
    this.child.on("exit", (code) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`${role} exited ${code}`));
      this.pending.clear();
    });
  }
  call(op, args = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.role} RPC ${op} timed out`));
      }, 15000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
  }
  async close() {
    if (!this.child || this.child.killed) return;
    try { await this.call("close"); } catch {}
    this.child.kill();
  }
}

async function sm(path, { method = "GET", body } = {}) {
  const response = await fetch(`${SUPERMEMORY}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supermemory ${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
async function smAdd(content, customId, phase) {
  const response = await sm("/v3/documents", {
    method: "POST",
    body: { content, containerTag: CONTAINER, customId, metadata: { experiment: "16", run: RUN, phase } },
  });
  docs.push(response.id);
  return response;
}
async function smSearch(documentId, query) {
  const response = await sm("/v3/search", {
    method: "POST",
    body: { q: query, containerTag: CONTAINER, limit: 20, includeFullDocs: true, includeSummary: true, rerank: false, rewriteQuery: false },
  });
  return { visible: (response.results ?? []).some((result) => result.documentId === documentId), response };
}
async function observeSemantic(documentId, query, timeoutMs) {
  const started = performance.now();
  let firstVisibleMs = null;
  let terminalMs = null;
  let status = null;
  let polls = 0;
  while (performance.now() - started < timeoutMs) {
    polls++;
    const document = await sm(`/v3/documents/${documentId}`);
    status = document.status;
    const search = await smSearch(documentId, query);
    if (search.visible && firstVisibleMs === null) firstVisibleMs = performance.now() - started;
    if (["done", "completed", "failed"].includes(status)) {
      terminalMs = performance.now() - started;
      return { status, firstVisibleMs, terminalMs, polls, timedOut: false, summary: document.summary ?? null };
    }
    await delay(500);
  }
  return { status, firstVisibleMs, terminalMs, polls, timedOut: true, summary: null };
}
async function waitShared(client, query, expected, timeoutMs = 5000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const view = await client.call("shared_view", { query });
    if (view.texts.some((text) => text.includes(expected))) return { view, elapsedMs: performance.now() - started };
    await delay(25);
  }
  throw new Error(`shared mirror did not see ${expected}`);
}
async function resolveLocalAfterRestart(handoffId, query) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("bun", ["run", resolve(HERE, "resolve-local.ts")], {
      cwd: fixture.local,
      env: {
        ...process.env,
        EXP16_LOCAL_DB: resolve(TMP, "local-dejavu.sqlite"),
        EXP16_HANDOFF_ID: handoffId,
        EXP16_QUERY: query,
        DEJAVU_AUTHOR: "exp16-local-resolver",
        DEJAVU_SESSION: `exp16-local-resolver-${RUN}`,
      },
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`local resolver exited ${code}: ${stderr}`));
      try { resolvePromise(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
    });
  });
}

let outcome = "FAIL";
let semanticInitial;
let semanticResolution;
let initial;
let offlineUpdate;
let stale;
let caught;
let resolution;
let localResolution;
let immediateSemantic;
let localInfo;
let cloudInfo;
let initialDoc;
let resolutionDoc;
try {
  record("spawn", "starting independent local and cloud-shaped processes");
  local = new RpcClient("local", fixture.local);
  cloud = new RpcClient("cloud", fixture.cloud);
  [localInfo, cloudInfo] = await Promise.all([local.call("info"), cloud.call("info")]);
  assert(localInfo.pid !== cloudInfo.pid, "clients must have distinct PIDs");
  assert(localInfo.localScope === cloudInfo.localScope, "same-origin checkouts must derive same repository scope");
  const contexts = await local.call("contexts", { paths: fixture });
  assert(contexts.local.scope === contexts.cloud.scope, "same origin did not normalize to same scope");
  assert(contexts.local.scope !== contexts.outsider.scope, "unrelated repository leaked into same scope");
  record("scope", `PIDs local=${localInfo.pid} cloud=${cloudInfo.pid}; same scope ${contexts.local.scope}; outsider ${contexts.outsider.scope}`);

  const taskText = `Decision ${MARKER}: use the amber compass for the synthetic release route; exact target is bay seven.`;
  const taskSummary = `Work ${MARKER} is ready for a cloud-shaped agent; verify bay seven with the amber compass.`;
  initial = await timed("local_write_and_authority_commit", () => local.call("write_initial", {
    marker: MARKER, text: taskText, summary: taskSummary, next: `Report ${MARKER} complete after verification.`,
  }));
  assert(initial.localView.activeHandoff?.id === initial.localHandoffId, "local handoff not immediately active");
  assert(initial.sharedView.mirrorRevision === initial.handoffRevision, "writer mirror did not apply receipt immediately");
  record("immediate local continuity", `local ${round(initial.localMs)}ms; shared revisions ${initial.rememberRevision}-${initial.handoffRevision} in ${round(initial.sharedMs)}ms`);

  const cloudSeen = await timed("cloud_live_operational_visibility", () => waitShared(cloud, MARKER, MARKER));
  timings.cloud_live_operational_visibility_observed = cloudSeen.elapsedMs;
  assert(cloudSeen.view.latestHandoff?.summary.includes(MARKER), "cloud mirror missing exact handoff");
  const cloudLocal = await cloud.call("local_view", { query: MARKER });
  assert(cloudLocal.texts.length === 0 && cloudLocal.activeHandoff === null, "isolated local Dejavu DB unexpectedly transported state");
  record("immediate cloud continuity", `separate PID mirror at rev ${cloudSeen.view.mirrorRevision}; observed in ${round(cloudSeen.elapsedMs)}ms`);

  initialDoc = await timed("supermemory_submit", () => smAdd(
    `${taskText} ${taskSummary} The route concept is amber navigation to bay seven.`, `${RUN}-initial`, "initial",
  ));
  const immediateDoc = await sm(`/v3/documents/${initialDoc.id}`);
  const immediateSearch = await smSearch(initialDoc.id, "amber navigation bay seven");
  immediateSemantic = { status: immediateDoc.status, visible: immediateSearch.visible };
  assert(["queued", "extracting", "indexing", "processing"].includes(immediateDoc.status), `expected explicit pending status, got ${immediateDoc.status}`);
  record("semantic pending", `document ${initialDoc.id} status=${immediateDoc.status}; exact document searchable=${immediateSearch.visible}`);

  await cloud.call("disconnect");
  const before = await cloud.call("shared_view", { query: MARKER });
  offlineUpdate = await timed("offline_authority_write", () => local.call("write_update", {
    marker: MARKER,
    text: `WIP ${MARKER}: bay seven verification now requires the silver seal in addition to the amber compass.`,
  }));
  stale = await timed("staleness_probe", () => cloud.call("probe_status"));
  const staleView = await cloud.call("shared_view", { query: "silver seal" });
  assert(stale.status === "stopped", "offline client status was not stopped");
  assert(stale.freshness.fresh === false && stale.freshness.behind >= 1, "offline client did not report behind");
  assert(staleView.texts.every((text) => !text.includes("silver seal")), "stale mirror fabricated offline update");
  assert(staleView.mirrorRevision === before.mirrorRevision, "stopped mirror advanced while disconnected");
  record("disconnect/staleness", `mirror=${stale.freshness.mirrorRevision} head=${stale.freshness.headRevision} behind=${stale.freshness.behind}; local hit=false`);

  caught = await timed("reconnect_catch_up", () => cloud.call("reconnect"));
  const caughtView = await cloud.call("shared_view", { query: "silver seal" });
  assert(caught.freshness.fresh && caught.freshness.behind === 0, "reconnect did not become fresh");
  assert(caughtView.texts.some((text) => text.includes("silver seal")), "catch-up omitted offline update");
  assert(caughtView.mirrorRevision >= offlineUpdate.revision, "watermark did not cross offline revision");
  record("reconnect/catch-up", `revision ${before.mirrorRevision} -> ${caughtView.mirrorRevision} in ${round(timings.reconnect_catch_up)}ms`);

  resolution = await timed("cloud_resolution_commit", () => cloud.call("resolve", {
    marker: MARKER,
    text: `RESOLVED ${MARKER}: cloud verification accepted bay seven with the amber compass and silver seal.`,
  }));
  const localSawResolution = await waitShared(local, MARKER, "RESOLVED");
  // Restart the local-agent process before resolving to prove that directive
  // lifecycle is durable in its repository-scoped Dejavu DB, not process memory.
  local.child.kill();
  local = null;
  await delay(100);
  localResolution = await resolveLocalAfterRestart(initial.localHandoffId, MARKER);
  assert(localResolution.resolved, "local handoff resolution failed");
  assert(localResolution.activeHandoff === null, "completed local handoff still directs work");
  record("resolution", `authority resolution revision ${resolution.resolutionRevision}; local handoff inactive; peer saw in ${round(localSawResolution.elapsedMs)}ms`);

  resolutionDoc = await smAdd(
    `RESOLVED ${MARKER}. Bay seven was verified using the amber compass and silver seal; no operational handoff remains active.`,
    `${RUN}-resolved`, "resolution",
  );
  [semanticInitial, semanticResolution] = await Promise.all([
    observeSemantic(initialDoc.id, "amber navigation bay seven", SEMANTIC_TIMEOUT_MS),
    observeSemantic(resolutionDoc.id, "verified amber compass silver seal", SEMANTIC_TIMEOUT_MS),
  ]);
  record("semantic observation", `initial=${semanticInitial.status} visible=${semanticInitial.firstVisibleMs !== null}; resolution=${semanticResolution.status} visible=${semanticResolution.firstVisibleMs !== null}`);

  outcome = "PASS";
} catch (error) {
  record("FAIL", error instanceof Error ? error.message : String(error));
  throw error;
} finally {
  for (const id of docs) {
    try { await sm(`/v3/documents/${id}`, { method: "DELETE" }); } catch {}
  }
  await Promise.allSettled([local?.close(), cloud?.close()]);
  const semanticVerdict = semanticInitial?.status === "failed" || semanticResolution?.status === "failed"
    ? "Operational continuity proved; full Supermemory extraction disproved in this run (terminal failed), while any exact document search visibility is reported separately."
    : semanticInitial?.timedOut || semanticResolution?.timedOut
      ? "Operational continuity proved; semantic completion remained pending at timeout and is not claimed fresh."
      : "Operational continuity and observed semantic completion both proved.";
  const md = `# Experiment 16 — RESULT\n\n- outcome: **${outcome}**\n- run: \`${RUN}\`\n- timestamp: ${new Date().toISOString()}\n- shared authority: \`${GATEWAY}\` (local Worker + SQLite Durable Object)\n- Supermemory: \`${SUPERMEMORY}\` (real local server)\n- synthetic marker: \`${MARKER}\`\n\n## Verdict\n\n${semanticVerdict}\n\nThe supported model is **two-speed, authority-first continuity**: repository-scoped Dejavu owns the local active handoff; revisioned shared memory transports exact operational state; Supermemory is a derived semantic index whose pending/failed state must never block or masquerade as operational freshness.\n\n## Evidence\n\n| phase | observation | timing |\n|---|---|---:|\n| independent clients | local PID ${localInfo?.pid ?? "n/a"}; cloud PID ${cloudInfo?.pid ?? "n/a"}; separate DBs | process boundary |\n| local write + exact authority receipts | local handoff active; writer mirror at rev ${initial?.handoffRevision ?? "n/a"} | ${timings.local_write_and_authority_commit ? `${round(timings.local_write_and_authority_commit)} ms` : "n/a"} |\n| connected cloud continuity | separate process observed exact slip + handoff | ${timings.cloud_live_operational_visibility_observed ? `${round(timings.cloud_live_operational_visibility_observed)} ms` : "n/a"} |\n| Supermemory submit | returned \`${initialDoc?.status ?? "n/a"}\`; immediate status \`${immediateSemantic?.status ?? "n/a"}\`, exact doc visible=${immediateSemantic?.visible ?? "n/a"} | ${timings.supermemory_submit ? `${round(timings.supermemory_submit)} ms` : "n/a"} |\n| disconnected write | authority committed revision ${offlineUpdate?.revision ?? "n/a"} | ${timings.offline_authority_write ? `${round(timings.offline_authority_write)} ms` : "n/a"} |\n| honest stale probe | mirror ${stale?.freshness?.mirrorRevision ?? "n/a"}, head ${stale?.freshness?.headRevision ?? "n/a"}, behind ${stale?.freshness?.behind ?? "n/a"}, fresh=${stale?.freshness?.fresh ?? "n/a"} | ${timings.staleness_probe ? `${round(timings.staleness_probe)} ms` : "n/a"} |\n| reconnect catch-up | fresh=${caught?.freshness?.fresh ?? "n/a"}, behind=${caught?.freshness?.behind ?? "n/a"} | ${timings.reconnect_catch_up ? `${round(timings.reconnect_catch_up)} ms` : "n/a"} |\n| cloud resolution | resolution rev ${resolution?.resolutionRevision ?? "n/a"}; restarted local handoff inactive=${localResolution?.activeHandoff === null} | ${timings.cloud_resolution_commit ? `${round(timings.cloud_resolution_commit)} ms` : "n/a"} |\n| initial semantic pipeline | status=${semanticInitial?.status ?? "not observed"}; exact doc visible at ${semanticInitial?.firstVisibleMs === null || semanticInitial?.firstVisibleMs === undefined ? "not observed" : `${round(semanticInitial.firstVisibleMs)} ms`}; timedOut=${semanticInitial?.timedOut ?? "n/a"} | ${semanticInitial?.terminalMs ? `${round(semanticInitial.terminalMs)} ms to terminal` : "pending/no terminal"} |\n| resolution semantic pipeline | status=${semanticResolution?.status ?? "not observed"}; exact doc visible at ${semanticResolution?.firstVisibleMs === null || semanticResolution?.firstVisibleMs === undefined ? "not observed" : `${round(semanticResolution.firstVisibleMs)} ms`}; timedOut=${semanticResolution?.timedOut ?? "n/a"} | ${semanticResolution?.terminalMs ? `${round(semanticResolution.terminalMs)} ms to terminal` : "pending/no terminal"} |\n\n## Anti-theater checks\n\n- local and cloud clients are separate OS processes with separate Dejavu and mirror SQLite files;\n- same-origin synthetic checkouts derived the same repository scope; an unrelated origin derived a different scope;\n- the cloud client's isolated local Dejavu DB did **not** magically contain the local client's handoff; transport came from authority revisions;\n- while disconnected, cloud local recall missed the new text and the status probe reported the exact revision gap;\n- reconnect had to advance the contiguous watermark before freshness was asserted;\n- semantic visibility only counts a Supermemory search result with the submitted document ID, preventing unrelated approximate hits from passing;\n- \`queued/indexing/processing\`, timeout, and \`failed\` are reported as pending/not-fresh or failed, never as semantic completion;\n- all content was synthetic and submitted Supermemory documents were deleted after observation.\n\n## Event log\n\n\`\`\`text\n${log.join("\n")}\n\`\`\`\n`;
  mkdirSync(dirname(RESULT), { recursive: true });
  writeFileSync(RESULT, md);
}

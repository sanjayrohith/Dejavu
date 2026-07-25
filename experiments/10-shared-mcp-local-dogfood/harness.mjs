#!/usr/bin/env node
/**
 * Experiment 10 — shared-MCP local dogfood harness.
 *
 * Two MCP stdio clients ("A" and "B") each spawn their own
 * `bun run src/shared-mcp.ts` instance, pointing at the same locally booted
 * shared-server and gateway token, but at *different* local mirror sqlite files
 * (DEJAVU_SHARED_MIRROR_DB). This proves real MCP JSON-RPC stdio behaviour and
 * cross-client convergence through the shared authority.
 *
 * Flow exercised, all through MCP tool calls (never the in-process API):
 *   A: tools/list
 *   A: status
 *   A: remember (slip captured)
 *   A: handoff
 *   B: status (refresh — should catch up)
 *   B: recall — must see A's slip + handoff
 *   B: signal forget the slip
 *   B: recall again — slip must be gone, handoff still present
 *   A: recall — A's mirror must converge to the same forgotten state
 *
 * Anything else fails the harness with a non-zero exit.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setTimeout as delay } from "node:timers/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

const GATEWAY = required("DEJAVU_SHARED_GATEWAY");
const TOKEN = required("DEJAVU_SHARED_TOKEN");
const MIRROR_A = required("EXP10_MIRROR_A");
const MIRROR_B = required("EXP10_MIRROR_B");
const RESULT_PATH = required("EXP10_RESULT");

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`harness: missing required env ${name}`);
    process.exit(2);
  }
  return value;
}

/** Spawn one shared-MCP server pointed at the given local mirror db. */
async function spawnSharedMcp(label, mirrorDb) {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", "src/shared-mcp.ts"],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DEJAVU_SHARED_GATEWAY: GATEWAY,
      DEJAVU_SHARED_TOKEN: TOKEN,
      DEJAVU_SHARED_MIRROR_DB: mirrorDb,
      DEJAVU_AUTHOR: `exp10-${label}`,
      DEJAVU_SESSION: `exp10-${label}-session`,
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: `exp10-harness-${label}`, version: "0.0.1" },
    { capabilities: {} },
  );
  // Pipe child stderr for debug visibility.
  transport.stderr?.on("data", (chunk) => {
    process.stderr.write(`[${label} mcp] ${chunk}`);
  });
  await client.connect(transport);
  return { client, transport, label };
}

async function call(c, name, args = {}) {
  const res = await c.client.callTool({ name, arguments: args });
  const text = (res.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (res.isError) throw new Error(`tool ${name} (${c.label}) errored: ${text}`);
  return text;
}

function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

const log = [];
function record(step, detail) {
  const line = `${new Date().toISOString()} ${step}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  log.push(line);
}

let A, B;
const startedAt = new Date().toISOString();

try {
  record("spawn", "starting two shared-MCP stdio servers");
  A = await spawnSharedMcp("a", MIRROR_A);
  B = await spawnSharedMcp("b", MIRROR_B);

  record("tools/list A");
  const toolsA = await A.client.listTools();
  const toolNames = (toolsA.tools ?? []).map((t) => t.name).sort();
  assert(
    JSON.stringify(toolNames) === JSON.stringify(["handoff", "recall", "remember", "signal", "status"]),
    `tools list mismatch: ${JSON.stringify(toolNames)}`,
  );
  record("tools/list A ok", toolNames.join(", "));

  record("tools/list B");
  const toolsB = await B.client.listTools();
  assert((toolsB.tools ?? []).length === 5, "B did not list 5 tools");

  record("A status");
  const statusA0 = await call(A, "status", { refresh: true });
  record("A status ok", statusA0);

  // Use a unique single-word marker so FTS can find this run's slip even
  // though FTS5's unicode61 tokenizer treats `-` as a separator and our
  // recall sanitizer strips non-alphanumerics from each whitespace token.
  // Keep the marker alphanumeric and well-stemmed.
  const marker = `expten${Date.now().toString(36)}`;
  const tag = `exp10-${Date.now().toString(36)}`;
  const memoryText = `Decision: shared MCP local dogfood works end to end ${marker} (${tag})`;
  const recallQuery = marker;

  record("A remember");
  const rememberOut = await call(A, "remember", { text: memoryText, tags: [tag] });
  record("A remember ok", rememberOut);
  // shared-mcp.ts format: "kept shared slip <id> — committed revision N; immediately recallable"
  const slipMatch = rememberOut.match(/kept shared slip (\S+)/);
  assert(slipMatch, `could not parse slip id from: ${rememberOut}`);
  const slipId = slipMatch[1];
  record("A remember slip", slipId);

  record("A handoff");
  const handoffOut = await call(A, "handoff", {
    summary: `Client A done; B should continue (${tag})`,
    next: ["B to recall and forget the slip"],
  });
  record("A handoff ok", handoffOut);

  // Give the SSE feed a moment to push the receipts to B's mirror.
  record("settle", "waiting 500ms for live feed");
  await delay(500);

  record("B status refresh");
  const statusB0 = await call(B, "status", { refresh: true });
  record("B status ok", statusB0);

  record("B recall (expect slip + handoff)");
  const recallB1 = await call(B, "recall", { query: recallQuery, limit: 8 });
  record("B recall1 result", recallB1.replace(/\n/g, " | "));
  assert(recallB1.includes(slipId), `B recall1 missing slip ${slipId}: ${recallB1}`);
  assert(recallB1.includes(marker), `B recall1 missing marker ${marker}`);
  assert(recallB1.includes("Client A done"), `B recall1 missing handoff text`);

  record("B signal forget", slipId);
  const signalOut = await call(B, "signal", { id: slipId, action: "forget" });
  record("B signal ok", signalOut);

  // Forget is a revision event; let it propagate to all mirrors.
  await delay(500);

  record("B recall (expect slip gone, handoff still present)");
  const recallB2 = await call(B, "recall", { query: recallQuery, limit: 8 });
  record("B recall2 result", recallB2.replace(/\n/g, " | "));
  assert(!recallB2.includes(slipId), `B recall2 still has forgotten slip ${slipId}: ${recallB2}`);
  assert(recallB2.includes("Client A done"), `B recall2 lost handoff (handoffs are not forgotten by slip signal)`);

  record("A recall (cross-mirror convergence)");
  const recallA = await call(A, "recall", { query: recallQuery, limit: 8 });
  record("A recall result", recallA.replace(/\n/g, " | "));
  assert(!recallA.includes(slipId), `A mirror did not converge to forgotten state: ${recallA}`);
  assert(recallA.includes("Client A done"), `A mirror lost the handoff after forget`);

  record("done", "all assertions passed");

  const summary = [
    `# Experiment 10 — shared-MCP local dogfood RESULT`,
    "",
    `started: ${startedAt}`,
    `finished: ${new Date().toISOString()}`,
    `gateway: ${GATEWAY}`,
    `mirror A: ${MIRROR_A}`,
    `mirror B: ${MIRROR_B}`,
    `tag: ${tag}`,
    `recall marker: ${marker}`,
    `slip id: ${slipId}`,
    "",
    `## Tools listed by both clients`,
    "",
    `\`${toolNames.join(", ")}\``,
    "",
    `## Real MCP JSON-RPC stdio call log`,
    "",
    "```text",
    ...log,
    "```",
    "",
    `## Outcome`,
    "",
    "- A remember+handoff through MCP tool calls → real shared-server HTTP POST.",
    "- B's mirror (separate sqlite) saw both events through the live feed, refresh, or",
    "  pre-recall catch-up — recall returned the slip with the tag and the handoff.",
    "- B signal forget through MCP propagated through the authority to A's mirror,",
    "  proving the cross-client revisioned event path end-to-end via real MCP stdio.",
    "- Handoffs are not slip-scoped and stayed visible after the slip was forgotten.",
    "",
  ].join("\n");
  mkdirSync(dirname(RESULT_PATH), { recursive: true });
  writeFileSync(RESULT_PATH, summary);
  record("wrote", RESULT_PATH);
} catch (err) {
  record("FAIL", err instanceof Error ? err.message : String(err));
  mkdirSync(dirname(RESULT_PATH), { recursive: true });
  writeFileSync(
    RESULT_PATH,
    `# Experiment 10 — shared-MCP local dogfood RESULT (FAIL)\n\n` +
      `started: ${startedAt}\nfailed: ${new Date().toISOString()}\n\nerror: ${err instanceof Error ? err.stack || err.message : String(err)}\n\n` +
      "## Log\n\n```text\n" + log.join("\n") + "\n```\n",
  );
  process.exitCode = 1;
} finally {
  try { await A?.client.close(); } catch {}
  try { await B?.client.close(); } catch {}
}

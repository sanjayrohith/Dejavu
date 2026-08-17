#!/usr/bin/env bun
/**
 * dejavu CLI — local introspection + MCP launcher.
 *
 * Subcommands:
 *   dejavu init              Create the DB + print MCP wiring snippet
 *   dejavu mcp               Run the MCP server (stdio)
 *   dejavu verify            Check DB exists and is readable
 *   dejavu recall <query>    Search slips
 *   dejavu ls [--session]    List kept slips (or current session)
 *   dejavu show <id>         Show a slip + its links
 *   dejavu stats             Counts and DB path
 *   dejavu handoffs          List recent handoffs
 *
 * The CLI is for humans poking at the DB. Agents use `dejavu mcp`.
 *
 * dejavu deliberately does NOT write a SKILL.md. The MCP tool descriptions
 * are the spec the agent works from. Bullets in a markdown file are
 * decaying prompts; the tool is the prompt.
 */

import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { Dejavu, SharedDejavu, defaultDbPath, driftIsSuspect, rollupDrift } from "./index.ts";
import { formatTouching } from "./format.ts";
import { checkpoint, describePreserve, finish, orient, parseHarnessEvent } from "./harness.ts";
import { currentSessionId } from "./lifecycle.ts";

function usage(): never {
  console.log(`dejavu — local-first agent memory

Usage:
  dejavu as <author> <command...>  Run a command as an agent identity
  dejavu init                  Create the DB + print MCP wiring snippet
  dejavu mcp                   Run the MCP server (stdio — for agent clients)
  dejavu verify                Check schema, SQLite integrity, and FTS coverage
  dejavu recall [query] [--tokens=N] [--kind=decision,pitfall]
  dejavu remember <text> [--keep] [--kind=decision] [--anchor=src/a.ts:42#fn]
  dejavu touching <path...>     Memory anchored to these files
  dejavu touching --diff        Memory anchored to your uncommitted changes
  dejavu anchors [--drifted]    Anchored memory and whether its code moved
  dejavu handoff <summary>     Leave one active handoff for this session
  dejavu resolve <id> [completed|abandoned]
  dejavu link <from> <supersedes|contradicts|related> <to>
  dejavu assess <trace> <useful|wrong|missed|no_memory_needed> [note]
  dejavu eval                  Show scoped recall-quality evidence
  dejavu forget-session <id> --yes  Expire a session's scoped slips
  dejavu session start [--harness=claude-code]   Orient a new session (reads hook JSON on stdin)
  dejavu session checkpoint    Preserve this session's work before compaction
  dejavu session end           Preserve, then release the session claim
  dejavu ls [--session]        List kept slips (or current session's slips)
  dejavu show <id>             Show a slip + its links
  dejavu stats                 Print counts and DB path
  dejavu handoffs              List recent handoffs
  dejavu send <to> <message>   Send async mailbox message
  dejavu inbox [to]            Read unread mailbox messages
  dejavu read <id>             Mark message read
  dejavu reply <id> <message>  Reply to a message
  dejavu shared status          Check shared local copy/current state
  dejavu shared recall <query>  Search shared local copy
  dejavu shared remember <text> Save shared memory
  dejavu shared handoff <text>  Leave shared handoff
  dejavu shared signal <id> <used|wrong|forget>
  dejavu shared delete <id>     Delete shared memory content locally + from server replay
  dejavu shared mcp             Run shared MCP server

Env:
  DEJAVU_AUTHOR    Identity recorded with new slips (default: unknown-agent)
  DEJAVU_SESSION   Override session id (default: derived per-process)
  DEJAVU_DB        Override DB path (default: ~/.dejavu/dejavu.db)
  DEJAVU_SCOPE     Override automatic git-repository scope (use global deliberately)
  DEJAVU_INCLUDE_LEGACY  Set to 1 to search pre-scope rows during migration
  DEJAVU_SHARED_GATEWAY  Shared memory server URL (required for shared commands)
  DEJAVU_SHARED_TOKEN    Bearer token for the shared memory server
  DEJAVU_SHARED_MIRROR_DB Local searchable shared-copy DB path (optional)
`);
  process.exit(1);
}

function dbPath(): string {
  return process.env.DEJAVU_DB ?? defaultDbPath();
}

function author(): string {
  return process.env.DEJAVU_AUTHOR ?? "unknown-agent";
}

function fmtSlip(s: ReturnType<Dejavu["get"]> & object): string {
  const tags = s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : "";
  const state = s.state.padEnd(7);
  const date = new Date(s.createdAt).toISOString().slice(0, 19);
  return `${s.id}  ${state}  ${date}  ${s.authoredBy}${tags}\n  scope: ${s.scope}\n  ${s.text.replace(/\n/g, "\n  ")}`;
}

async function cmdInit(): Promise<void> {
  const path = dbPath();
  const d = new Dejavu({ path });
  d.close();
  console.log(`dejavu: db ready at ${path}`);

  console.log(`
Wire dejavu into your MCP client. Tool descriptions are the spec — no SKILL.md, no AGENTS.md.

If you ran this via 'bunx github:sanjayrohith/Dejavu init', the MCP server is reachable
the same way: 'bunx github:sanjayrohith/Dejavu mcp'. If you cloned, use the local path.

Claude Code (~/.config/claude-code/mcp.json):

  {
    "mcpServers": {
      "dejavu": {
        "command": "bunx",
        "args": ["github:sanjayrohith/Dejavu", "mcp"]
      }
    }
  }

OpenCode (~/.config/opencode/opencode.jsonc):

  "mcp": {
    "dejavu": {
      "type": "local",
      "command": ["bunx", "github:sanjayrohith/Dejavu", "mcp"]
    }
  }

pi (~/.pi/agent/mcp.json):

  {
    "mcpServers": {
      "dejavu": {
        "command": "bunx",
        "args": ["github:sanjayrohith/Dejavu", "mcp"]
      }
    }
  }

(Cloned the repo instead? Replace 'bunx github:sanjayrohith/Dejavu' with
 'bun run ${import.meta.dir}/cli.ts' in any of the above.)
`);
}

function cmdVerify(): void {
  const path = dbPath();
  const exists = existsSync(path);
  console.log(`db:    ${path} ${exists ? "OK" : "MISSING"}`);
  if (!exists) process.exit(1);

  const d = new Dejavu({ path, skipGc: true });
  const health = d.storage.health();
  const c = d.counts();
  console.log(`scope: ${d.scope}`);
  console.log(`sqlite: ${health.sqlite}`);
  console.log(`fts: ${health.indexed}/${health.slips} indexed`);
  console.log(`slips: ${c.slips} (${c.kept} kept, ${c.drafts} draft)`);
  console.log(`handoffs: ${c.handoffs}`);
  console.log(`messages: ${c.messages} (${c.pending} pending)`);
  d.close();
  console.log(`session: ${currentSessionId()}`);
  if (!health.ok) process.exit(1);
}

function cmdRecall(args: string[]): void {
  const maxTokens = Number(args.find((arg) => arg.startsWith("--tokens="))?.split("=")[1] ?? 1200);
  const kindArg = args.find((arg) => arg.startsWith("--kind="))?.split("=")[1];
  const kinds = kindArg ? kindArg.split(",") as import("./types.ts").MemoryKind[] : undefined;
  const query = args.filter((arg) => !arg.startsWith("--tokens=") && !arg.startsWith("--kind=")).join(" ").trim();
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  const r = d.recall(query, { limit: 10, maxTokens, kinds });
  console.log(`receipt: ${r.traceId}`);
  if (r.activeHandoff) {
    console.log(`-- active handoff (${r.activeHandoff.scope}) --`);
    console.log(`  ${r.activeHandoff.summary}`);
    if (r.activeHandoff.next.length > 0) {
      console.log(`  next:`);
      for (const n of r.activeHandoff.next) console.log(`    - ${n}`);
    }
    console.log();
  }
  if (r.hits.length === 0) {
    console.log(query ? `(no hits for "${query}")` : "(no recent scoped memory)");
  } else {
    for (const h of r.hits) {
      console.log(`[${h.trust}] ${fmtSlip(h.slip)}`);
      console.log();
    }
  }
  d.close();
}

function cmdRemember(args: string[]): void {
  const keep = args.includes("--keep");
  const kindArg = args.find((arg) => arg.startsWith("--kind="))?.split("=")[1] as import("./types.ts").MemoryKind | undefined;
  const anchors = args
    .filter((arg) => arg.startsWith("--anchor="))
    .map((arg) => arg.slice("--anchor=".length))
    .filter((value) => value.length > 0);
  const text = args
    .filter((arg) => arg !== "--keep" && !arg.startsWith("--kind=") && !arg.startsWith("--anchor="))
    .join(" ")
    .trim();
  if (!text) throw new Error("usage: dejavu remember <text> [--keep] [--kind=decision] [--anchor=path:line#symbol]");
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  try {
    const slip = d.remember(text, { kind: kindArg, anchors });
    if (keep) d.keep([slip.id]);
    console.log(`${keep ? "kept" : "drafted"} ${slip.kind} ${slip.id} in ${slip.scope}`);
    for (const anchor of d.anchorsFor(slip.id)) {
      console.log(`  anchored to ${anchor.path}@${anchor.blobSha.slice(0, 8)}`);
    }
  } finally {
    d.close();
  }
}

/** Repository-relative paths of the working tree's uncommitted changes. */
function changedPaths(root: string): string[] {
  const git = Bun.spawnSync(["git", "diff", "--name-only", "HEAD"], { cwd: root });
  if (!git.success) {
    throw new Error("dejavu touching --diff: could not read the diff (is this a git checkout with commits?)");
  }
  return new TextDecoder()
    .decode(git.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function cmdTouching(args: string[]): void {
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  try {
    const paths = args.includes("--diff")
      ? changedPaths(d.anchorRoot)
      : args.filter((arg) => !arg.startsWith("--"));
    if (paths.length === 0) {
      console.log(
        args.includes("--diff")
          ? "(no uncommitted changes)"
          : "usage: dejavu touching <path...> | dejavu touching --diff",
      );
      return;
    }
    console.log(formatTouching(d.touching(paths), d.storage));
  } finally {
    d.close();
  }
}

function cmdAnchors(args: string[]): void {
  const onlyDrifted = args.includes("--drifted");
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  try {
    const slips = d.storage.listAnchoredSlips(d.scope, d.options.includeLegacy);
    const tally = { verified: 0, drifted: 0, orphaned: 0, unknown: 0 };
    let shown = 0;

    for (const slip of slips) {
      const states = d.anchorStates(slip.id);
      const drift = rollupDrift(states);
      if (drift) tally[drift] += 1;
      if (onlyDrifted && !driftIsSuspect(drift)) continue;
      shown += 1;
      console.log(`${slip.id}  ${slip.kind.padEnd(10)}  ${drift ?? "unanchored"}`);
      console.log(`  ${slip.text.replace(/\n/g, "\n  ")}`);
      for (const state of states) console.log(`  ${state.detail}`);
      console.log();
    }

    if (shown === 0) {
      console.log(onlyDrifted ? "(no anchored memory has drifted)" : "(no anchored memory in this scope)");
    }
    console.log(
      `scope: ${d.scope}\nanchored: ${slips.length}  verified: ${tally.verified}  drifted: ${tally.drifted}  orphaned: ${tally.orphaned}  unknown: ${tally.unknown}`,
    );
  } finally {
    d.close();
  }
}

function cmdWriteHandoff(args: string[]): void {
  const summary = args.join(" ").trim();
  if (!summary) throw new Error("usage: dejavu handoff <summary>");
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  const handoff = d.handoff({ summary });
  console.log(`active handoff ${handoff.id} (${handoff.kept.length} slip(s) kept)`);
  d.close();
}

function cmdResolve(args: string[]): void {
  const id = args[0];
  const status = (args[1] ?? "completed") as "completed" | "abandoned";
  if (!id || !["completed", "abandoned"].includes(status)) throw new Error("usage: dejavu resolve <id> [completed|abandoned]");
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  if (!d.resolveHandoff(id, status)) throw new Error(`active handoff ${id} not found`);
  console.log(`handoff ${id}: ${status}`);
  d.close();
}

function cmdLink(args: string[]): void {
  const [from, kind, to] = args as [string | undefined, import("./types.ts").LinkKind | undefined, string | undefined];
  if (!from || !to || !kind || !["supersedes", "contradicts", "related"].includes(kind)) throw new Error("usage: dejavu link <from> <supersedes|contradicts|related> <to>");
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  if (!d.link(from, to, kind)) throw new Error("both slips must exist in the current repository scope");
  console.log(`linked ${from} ${kind} ${to}`);
  d.close();
}

function cmdAssess(args: string[]): void {
  const [traceId, assessment, ...noteParts] = args as [string | undefined, import("./types.ts").RecallAssessment | undefined, ...string[]];
  if (!traceId || !assessment || !["useful", "wrong", "missed", "no_memory_needed"].includes(assessment)) throw new Error("usage: dejavu assess <trace> <useful|wrong|missed|no_memory_needed> [note]");
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  if (!d.assessRecall(traceId, assessment, noteParts.join(" "))) throw new Error(`recall trace ${traceId} not found`);
  console.log(`recall ${traceId}: ${assessment}`);
  d.close();
}

function cmdEval(): void {
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  const report = d.recallReport();
  console.log(`scope: ${d.scope}`);
  console.log(`recalls: ${report.total}`);
  console.log(`assessed: ${report.assessed}`);
  console.log(`  useful: ${report.useful}`);
  console.log(`  wrong: ${report.wrong}`);
  console.log(`  missed: ${report.missed}`);
  console.log(`  no memory needed: ${report.noMemoryNeeded}`);
  const actionable = report.useful + report.wrong + report.missed;
  if (actionable > 0) console.log(`useful share of actionable recalls: ${((report.useful / actionable) * 100).toFixed(1)}%`);
  d.close();
}

function cmdForgetSession(args: string[]): void {
  const sessionId = args.find((arg) => arg !== "--yes");
  if (!sessionId || !args.includes("--yes")) throw new Error("usage: dejavu forget-session <id> --yes");
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  console.log(`expired ${d.forgetSession(sessionId)} slip(s) from ${sessionId} in ${d.scope}`);
  d.close();
}

/**
 * Session lifecycle, driven by a harness hook.
 *
 * The hook payload arrives as JSON on stdin. Every phase is written to be
 * unfailing: a hook that exits non-zero or throws degrades the user's
 * session, which is a far worse outcome than missing one memory packet.
 * So the whole body is wrapped, and any error becomes a quiet note on
 * stderr with a zero exit.
 *
 * Output shape differs per phase because harnesses consume them
 * differently. `start` writes the memory packet to stdout, which Claude
 * Code adds to the agent's context on a zero exit. `checkpoint` and `end`
 * have no context channel, so they emit a JSON `systemMessage` for the
 * human instead.
 */
async function cmdSession(args: string[]): Promise<void> {
  const phase = args[0] as import("./harness.ts").HarnessPhase | undefined;
  if (!phase || !["start", "checkpoint", "end"].includes(phase)) {
    console.error("usage: dejavu session <start|checkpoint|end> [--harness=name] [--tokens=N]");
    process.exit(1);
  }
  const rest = args.slice(1);
  const harness = rest.find((a) => a.startsWith("--harness="))?.split("=")[1] || "unknown";
  const maxTokens = Number(rest.find((a) => a.startsWith("--tokens="))?.split("=")[1] ?? 700);
  const quiet = rest.includes("--quiet");

  let d: Dejavu | null = null;
  try {
    const payload = rest.includes("--no-stdin") ? "" : await readStdin();
    const event = parseHarnessEvent(payload, phase, harness);
    // The harness knows the working directory better than we do; a hook
    // may well run from somewhere else entirely.
    if (event.cwd) process.chdir(event.cwd);

    d = new Dejavu({ path: dbPath(), skipGc: phase === "start" ? false : true });

    if (phase === "start") {
      const result = orient(d, event, { maxTokens });
      if (result.context) process.stdout.write(`${result.context}\n`);
      return;
    }

    const result = phase === "checkpoint" ? checkpoint(d, event) : finish(d, event);
    if (!quiet) {
      console.log(JSON.stringify({ systemMessage: describePreserve(result, phase) }));
    }
  } catch (err) {
    // Never fail a session over memory bookkeeping.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`dejavu session ${phase}: skipped (${message})`);
  } finally {
    d?.close();
  }
}

/** Read a hook payload from stdin, tolerating a closed or empty pipe. */
async function readStdin(): Promise<string> {
  try {
    if (process.stdin.isTTY) return "";
    return await new Response(Bun.stdin.stream()).text();
  } catch {
    return "";
  }
}

function cmdLs(args: string[]): void {
  const useSession = args.includes("--session");
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  const slips = useSession ? d.listSession() : d.listKept(50);
  if (slips.length === 0) {
    console.log(useSession ? "(no slips in this session)" : "(no kept slips)");
  } else {
    for (const s of slips) {
      console.log(fmtSlip(s));
      console.log();
    }
  }
  d.close();
}

function cmdShow(args: string[]): void {
  const id = args[0];
  if (!id) {
    console.error("usage: dejavu show <id>");
    process.exit(1);
  }
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  const s = d.get(id);
  if (!s) {
    console.error(`(no slip ${id})`);
    process.exit(1);
  }
  console.log(fmtSlip(s));
  console.log(`  used: ${s.usedCount}, wrong: ${s.wrongCount}`);
  const anchors = d.anchorStates(s.id);
  if (anchors.length > 0) {
    console.log(`  anchors:`);
    for (const state of anchors) {
      const where = state.anchor.symbol
        ? `${state.anchor.path}#${state.anchor.symbol}`
        : state.anchor.line
          ? `${state.anchor.path}:${state.anchor.line}`
          : state.anchor.path;
      const commit = state.anchor.commit ? ` @ ${state.anchor.commit.slice(0, 8)}` : "";
      console.log(`    ${state.status.padEnd(9)} ${where}${commit}`);
      console.log(`      ${state.detail}`);
    }
  }
  const links = d.storage.linksFrom(s.id);
  if (links.length > 0) {
    console.log(`  links:`);
    for (const l of links) console.log(`    ${l.kind} -> ${l.toId}`);
  }
  d.close();
}

function cmdStats(): void {
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  const c = d.counts();
  console.log(`db:       ${d.storage.path}`);
  console.log(`scope:    ${d.scope} (${d.context.source})`);
  console.log(`root:     ${d.context.root}`);
  console.log(`slips:    ${c.slips}`);
  console.log(`  kept:   ${c.kept}`);
  console.log(`  drafts: ${c.drafts}`);
  console.log(`  expired:${c.slips - c.kept - c.drafts}`);
  console.log(`handoffs: ${c.handoffs}`);
  console.log(`messages: ${c.messages}`);
  console.log(`  pending:${c.pending}`);
  d.close();
}

function fmtMsg(m: ReturnType<Dejavu["inbox"]>[number]): string {
  const date = new Date(m.createdAt).toISOString().slice(0, 19);
  const delivery = m.delivery
    ? m.delivery.ok
      ? `\n  delivered via ${m.delivery.transport}: ${m.delivery.path}`
      : `\n  mailbox-only: ${m.delivery.reason}`
    : "";
  return `${m.id}  ${m.state}  ${date}  ${m.from} -> ${m.to}  thread ${m.threadId}\n  ${m.body.replace(/\n/g, "\n  ")}${delivery}`;
}

function cmdSend(args: string[]): void {
  const to = args[0];
  const body = args.slice(1).join(" ").trim();
  if (!to || !body) {
    console.error("usage: dejavu send <to> <message>");
    process.exit(1);
  }
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  const m = d.send({ to, body });
  console.log(fmtMsg(m));
  d.close();
}

function cmdInbox(args: string[]): void {
  const to = args.find((a) => a !== "--all") ?? author();
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  const msgs = d.inbox(to, { includeRead: args.includes("--all") });
  if (msgs.length === 0) console.log(`(no unread messages for ${to})`);
  for (const m of msgs) console.log(fmtMsg(m) + "\n");
  d.close();
}

function cmdRead(args: string[]): void {
  const id = args[0];
  if (!id) {
    console.error("usage: dejavu read <id>");
    process.exit(1);
  }
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  console.log(d.read(id) ? `read ${id}` : `message ${id} not found`);
  d.close();
}

function cmdReply(args: string[]): void {
  const id = args[0];
  const body = args.slice(1).join(" ").trim();
  if (!id || !body) {
    console.error("usage: dejavu reply <id> <message>");
    process.exit(1);
  }
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  const m = d.reply(id, body);
  console.log(fmtMsg(m));
  d.close();
}

async function sharedClient(): Promise<SharedDejavu> {
  const gateway = process.env.DEJAVU_SHARED_GATEWAY;
  if (!gateway) throw new Error("DEJAVU_SHARED_GATEWAY is required for dejavu shared commands");
  return SharedDejavu.connect({ gateway, token: process.env.DEJAVU_SHARED_TOKEN });
}

async function cmdShared(args: string[]): Promise<void> {
  const sub = args.shift();
  if (sub === "mcp") {
    await import("./shared-mcp.ts");
    return;
  }
  const d = await sharedClient();
  try {
    switch (sub) {
      case "status": {
        const status = await d.refreshStatus();
        console.log(`shared: ${status.status}`);
        console.log(`local copy: ${status.mirrorRevision}`);
        console.log(`server: ${status.knownHeadRevision}`);
        console.log(`behind: ${status.freshness.behind}`);
        console.log(`current: ${status.freshness.fresh ? "yes" : "no"}`);
        return;
      }
      case "recall": {
        const query = args.join(" ").trim();
        if (!query) throw new Error("usage: dejavu shared recall <query>");
        const result = d.recall(query, 10);
        if (result.latestHandoff) {
          console.log(`-- latest handoff [change ${result.latestHandoff.revision}] --`);
          console.log(`  ${result.latestHandoff.summary}`);
          for (const next of result.latestHandoff.next) console.log(`  next: ${next}`);
          console.log();
        }
        if (result.hits.length === 0) console.log(`(no shared hits for "${query}"; local copy at change ${result.mirrorRevision})`);
        for (const hit of result.hits) console.log(`${hit.slipId}  change ${hit.revision}\n  ${hit.text}\n`);
        return;
      }
      case "remember": {
        const text = args.join(" ").trim();
        if (!text) throw new Error("usage: dejavu shared remember <text>");
        const saved = await d.remember(text);
        console.log(`saved shared memory ${saved.id} (change ${saved.receipt.revision}; immediately searchable here)`);
        return;
      }
      case "handoff": {
        const summary = args.join(" ").trim();
        if (!summary) throw new Error("usage: dejavu shared handoff <summary>");
        const saved = await d.handoff(summary);
        console.log(`saved shared handoff ${saved.id} (change ${saved.receipt.revision})`);
        return;
      }
      case "signal": {
        const id = args[0]; const action = args[1] as "used" | "wrong" | "forget" | undefined;
        if (!id || !action || !["used", "wrong", "forget"].includes(action)) throw new Error("usage: dejavu shared signal <id> <used|wrong|forget>");
        const saved = await d.signal(id, action);
        console.log(`saved shared signal ${id} ${action} (change ${saved.receipt.revision})`);
        return;
      }
      case "delete": {
        const id = args[0];
        if (!id) throw new Error("usage: dejavu shared delete <id>");
        const saved = await d.delete(id);
        console.log(`deleted shared memory ${id} (change ${saved.receipt.revision}; removed from synced local copies and redacted from server replay)`);
        return;
      }
      default:
        throw new Error("usage: dejavu shared <status|recall|remember|handoff|signal|delete|mcp> ...");
    }
  } finally {
    await d.close();
  }
}

function cmdHandoffs(): void {
  const d = new Dejavu({ path: dbPath(), skipGc: true });
  const hs = d.latestHandoffs(10);
  if (hs.length === 0) {
    console.log("(no handoffs)");
  } else {
    for (const h of hs) {
      const date = new Date(h.createdAt).toISOString().slice(0, 19);
      console.log(`${h.id}  ${date}  ${h.authoredBy}  (session ${h.sessionId})`);
      console.log(`  ${h.summary.replace(/\n/g, "\n  ")}`);
      if (h.kept.length > 0) console.log(`  kept: ${h.kept.length} slip(s)`);
      if (h.next.length > 0) {
        console.log(`  next:`);
        for (const n of h.next) console.log(`    - ${n}`);
      }
      console.log();
    }
  }
  d.close();
}

let [, , cmd, ...rest] = process.argv;
if (cmd === "as") {
  const who = rest.shift();
  if (!who || rest.length === 0) {
    console.error("usage: dejavu as <author> <command...>");
    process.exit(1);
  }
  process.env.DEJAVU_AUTHOR = who;
  cmd = rest.shift();
}
switch (cmd) {
  case "init":
    await cmdInit();
    break;
  case "mcp":
    // Boot the MCP stdio server in this process. Importing for side
    // effects: mcp.ts attaches to stdin/stdout and connects the
    // transport at module load. Agent clients launch us with
    // `dejavu mcp` and start sending JSON-RPC.
    await import("./mcp.ts");
    break;
  case "verify":
    cmdVerify();
    break;
  case "recall":
    cmdRecall(rest);
    break;
  case "remember":
    cmdRemember(rest);
    break;
  case "touching":
    cmdTouching(rest);
    break;
  case "anchors":
    cmdAnchors(rest);
    break;
  case "handoff":
    cmdWriteHandoff(rest);
    break;
  case "resolve":
    cmdResolve(rest);
    break;
  case "link":
    cmdLink(rest);
    break;
  case "assess":
    cmdAssess(rest);
    break;
  case "eval":
    cmdEval();
    break;
  case "forget-session":
    cmdForgetSession(rest);
    break;
  case "session":
    await cmdSession(rest);
    break;
  case "ls":
    cmdLs(rest);
    break;
  case "show":
    cmdShow(rest);
    break;
  case "stats":
    cmdStats();
    break;
  case "handoffs":
    cmdHandoffs();
    break;
  case "send":
    cmdSend(rest);
    break;
  case "inbox":
    cmdInbox(rest);
    break;
  case "read":
    cmdRead(rest);
    break;
  case "reply":
    cmdReply(rest);
    break;
  case "shared":
    await cmdShared(rest);
    break;
  default:
    usage();
}

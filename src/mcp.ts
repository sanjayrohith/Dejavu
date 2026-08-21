#!/usr/bin/env bun
/**
 * dejavu MCP server — local stdio.
 *
 * Agent tools:
 *   recall / touching / remember / handoff / resolve_handoff
 *   signal / link / assess
 *
 * Optional local coordination tools:
 *   send / inbox / read / reply
 *
 * `keep` is folded into `remember(keep: true)` because MCP clients tend
 * to treat tools as one-shot — promoting separately is friction. The
 * library still exposes keep() for in-process callers.
 *
 * Structural recall enforcement:
 * On the first `remember` or `handoff` call of a session where no
 * `recall` has happened yet, we surface the most recent prior handoff
 * (if any) in the tool response. This makes the previous agent's
 * signoff visible to a forgetful agent without requiring it to ask.
 * Cheap (one indexed row), additive, zero new state.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Dejavu, defaultDbPath } from "./index.ts";
import { formatDuplicateSuggestion, formatOrientation, formatRecall, formatRecents, formatTouching } from "./format.ts";
import { VERSION } from "./version.ts";

/**
 * Dispatch state. Exposed only for tests / harnesses that want to
 * exercise the MCP handler logic without spinning up a transport.
 */
export interface DispatchState {
  /** Has `recall` been called yet this process? Mutated by dispatch(). */
  recallSeen: boolean;
}

export function newDispatchState(): DispatchState {
  return { recallSeen: false };
}

/**
 * If the agent has not called recall yet, return a short banner pointing
 * at the most recent prior handoff (if any). Structural nudge — agents
 * that skipped recall still see context.
 */
function priorHandoffNudge(dejavu: Dejavu, state: DispatchState): string {
  if (state.recallSeen) return "";
  const latest = dejavu.latestHandoffs(1)[0];
  if (!latest) return "";
  const summary = latest.summary.length > 240
    ? latest.summary.slice(0, 240) + "…"
    : latest.summary;
  return `\n\n# fyi — most recent handoff (you have not called recall yet)\n${summary}\n\n(call \`recall\` with a query to search, or \`recall\` with empty query for recents.)`;
}

/**
 * Pure dispatch: maps (toolName, args) -> {text, isError}.
 * Mutates `state.recallSeen`. No transport, no I/O beyond the dejavu
 * instance. Test-friendly.
 */
export function dispatch(
  dejavu: Dejavu,
  state: DispatchState,
  name: string,
  args: Record<string, unknown> = {},
): { text: string; isError?: boolean } {
  try {
    switch (name) {
      case "recall": {
        const query = String(args.query ?? "");
        const limit = Number(args.limit ?? 8);
        const maxTokens = Number(args.maxTokens ?? 900);
        const kinds = Array.isArray(args.kinds) ? args.kinds as import("./types.ts").MemoryKind[] : undefined;
        state.recallSeen = true;

        if (query.trim().length === 0) {
          // An empty query is the "I do not know what to ask yet" case,
          // which is exactly what orientation answers: the working tree
          // first, then open work, then standing decisions. A caller who
          // passed `kinds` has asked a narrower question than that, so
          // the flat recents view still serves it.
          if (kinds && kinds.length > 0) {
            const recent = dejavu.recall("", { limit, maxTokens, kinds });
            return { text: formatRecents(recent.activeHandoff, recent.hits.map((hit) => hit.slip), recent.traceId) };
          }
          return { text: formatOrientation(dejavu.orientation({ limit, maxTokens }), dejavu.storage) };
        }

        const r = dejavu.recall(query, { limit, maxTokens, kinds });
        return { text: formatRecall(r, dejavu.storage) };
      }
      case "touching": {
        const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
        const limit = Number(args.limit ?? 20);
        if (paths.length === 0) {
          return { text: "error: paths is required (one or more file paths)", isError: true };
        }
        state.recallSeen = true;
        return { text: formatTouching(dejavu.touching(paths, { limit }), dejavu.storage) };
      }
      case "remember": {
        const text = String(args.text ?? "");
        const tags = args.tags as string[] | undefined;
        const kind = args.kind as import("./types.ts").MemoryKind | undefined;
        const keep = Boolean(args.keep ?? false);
        const supersedes = Array.isArray(args.supersedes) ? args.supersedes.map(String) : [];
        const contradicts = Array.isArray(args.contradicts) ? args.contradicts.map(String) : [];
        const anchors = Array.isArray(args.anchors) ? args.anchors.map(String) : [];
        const links = [
          ...supersedes.map((toId) => ({ toId, kind: "supersedes" as const })),
          ...contradicts.map((toId) => ({ toId, kind: "contradicts" as const })),
        ];
        // Checked before the write, so the new slip can never match itself.
        const duplicate = dejavu.findDuplicate(text);
        const slip = dejavu.remember(text, { tags, kind, links, anchors });

        let rolledUpHandoff: string | null = null;
        if (keep) {
          dejavu.keep([slip.id]);
          const sessionSlips = dejavu.listSession();
          if (sessionSlips.length > 0 && sessionSlips[0]) {
            const h = dejavu.storage.getHandoffBySession(sessionSlips[0].sessionId, dejavu.scope);
            if (h && Math.abs(h.createdAt - Date.now()) < 5000) {
              rolledUpHandoff = h.id;
            }
          }
        }

        const base = `${keep ? "kept" : "drafted"} slip ${slip.id}${
          keep ? "" : " (auto-expires in 24h unless kept)"
        }`;
        const anchored = dejavu.anchorsFor(slip.id);
        const anchorNote = anchored.length > 0
          ? ` — anchored to ${anchored.map((a) => a.path).join(", ")}; future recalls report when that code changes`
          : "";
        const trailer = rolledUpHandoff
          ? ` — auto-rolled into session handoff ${rolledUpHandoff}; visible to next agent on any recall`
          : "";
        const duplicateNote = duplicate
          ? `\n\n# ${formatDuplicateSuggestion(duplicate)}\nIf this replaces it, call remember again with supersedes: ["${duplicate.slip.id}"]. If it's genuinely separate, no action needed.`
          : "";
        return { text: base + anchorNote + trailer + duplicateNote + priorHandoffNudge(dejavu, state) };
      }
      case "handoff": {
        const summary = String(args.summary ?? "");
        const next = args.next as string[] | undefined;
        const h = dejavu.handoff({ summary, next });
        return {
          text:
            `handoff ${h.id} written (${h.kept.length} slip(s) kept)` +
            priorHandoffNudge(dejavu, state),
        };
      }
      case "assess": {
        const traceId = String(args.traceId ?? "");
        const assessment = String(args.assessment ?? "") as import("./types.ts").RecallAssessment;
        const note = args.note ? String(args.note) : undefined;
        if (!traceId || !["useful", "wrong", "missed", "no_memory_needed"].includes(assessment)) {
          return { text: "error: traceId and valid assessment are required", isError: true };
        }
        const ok = dejavu.assessRecall(traceId, assessment, note);
        return ok
          ? { text: `recall ${traceId} assessed ${assessment}` }
          : { text: `error: recall trace ${traceId} not found`, isError: true };
      }
      case "link": {
        const fromId = String(args.fromId ?? "");
        const toId = String(args.toId ?? "");
        const kind = String(args.kind ?? "") as import("./types.ts").LinkKind;
        if (!fromId || !toId || !["supersedes", "contradicts", "related"].includes(kind)) {
          return { text: "error: fromId, toId and valid kind are required", isError: true };
        }
        const ok = dejavu.link(fromId, toId, kind);
        return ok
          ? { text: `linked ${fromId} ${kind} ${toId}` }
          : { text: "error: both slips must exist in the current repository scope", isError: true };
      }
      case "resolve_handoff": {
        const id = String(args.id ?? "");
        const status = String(args.status ?? "completed") as "completed" | "abandoned";
        if (!id || !["completed", "abandoned"].includes(status)) {
          return { text: "error: id and valid status are required", isError: true };
        }
        const ok = dejavu.resolveHandoff(id, status);
        return ok
          ? { text: `handoff ${id} resolved ${status}` }
          : { text: `error: active handoff ${id} not found`, isError: true };
      }
      case "signal": {
        const id = String(args.id ?? "");
        const action = String(args.action ?? "");
        if (!id) return { text: "error: id is required", isError: true };
        switch (action) {
          case "used":
            dejavu.used(id);
            return { text: `signal: ${id} used (+1)` };
          case "wrong":
            dejavu.wrong(id);
            return { text: `signal: ${id} wrong (+1)` };
          case "forget": {
            const ok = dejavu.forget(id);
            return {
              text: ok
                ? `signal: ${id} forgotten (expired, no undo)`
                : `signal: ${id} not forgotten (already expired or not found)`,
            };
          }
          default:
            return {
              text: `error: unknown action '${action}' (expected used | wrong | forget)`,
              isError: true,
            };
        }
      }
      case "send": {
        const to = String(args.to ?? "");
        const body = String(args.body ?? "");
        const threadId = args.threadId ? String(args.threadId) : undefined;
        const msg = dejavu.send({ to, body, threadId });
        const delivery = msg.delivery
          ? msg.delivery.ok
            ? ` — delivered via ${msg.delivery.transport}: ${msg.delivery.path}`
            : ` — mailbox-only (${msg.delivery.reason})`
          : "";
        return { text: `sent ${msg.id} to ${msg.to} (thread ${msg.threadId})${delivery}` };
      }
      case "inbox": {
        const to = String(args.to ?? process.env.DEJAVU_AUTHOR ?? "unknown-agent");
        const limit = Number(args.limit ?? 20);
        const includeRead = Boolean(args.includeRead ?? false);
        const msgs = dejavu.inbox(to, { limit, includeRead });
        if (msgs.length === 0) return { text: `(no ${includeRead ? "" : "unread "}messages for ${to})` };
        return { text: msgs.map((m) => `${m.id}  ${m.state}  ${new Date(m.createdAt).toISOString()}  from ${m.from}  thread ${m.threadId}\n${m.body}`).join("\n\n") };
      }
      case "read": {
        const id = String(args.id ?? "");
        if (!id) return { text: "error: id is required", isError: true };
        const ok = dejavu.read(id);
        return { text: ok ? `read ${id}` : `message ${id} not found`, ...(ok ? {} : { isError: true }) };
      }
      case "reply": {
        const id = String(args.id ?? "");
        const body = String(args.body ?? "");
        const msg = dejavu.reply(id, body);
        return { text: `replied ${msg.id} to ${msg.to} (thread ${msg.threadId})` };
      }
      default:
        return { text: `unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `error: ${msg}`, isError: true };
  }
}

// Bootstrap is gated on `import.meta.main` so importing this module from
// tests / harnesses doesn't open ~/.dejavu/dejavu.db or hijack stdio. Only
// the top-level invocation (`bun run src/mcp.ts`) starts the server.
if (import.meta.main) {
  const dbPath = process.env.DEJAVU_DB ?? defaultDbPath();
  const dejavu = new Dejavu({ path: dbPath });
  const dispatchState = newDispatchState();
  await runServer(dejavu, dispatchState);
}

async function runServer(dejavu: Dejavu, dispatchState: DispatchState): Promise<void> {
  const server = new Server(
    { name: "dejavu", version: VERSION },
    { capabilities: { tools: {} } },
  );

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "recall",
      description:
        "Search agent memory for facts, decisions, preferences, and project-specific conventions the user (or a previous agent) wrote down. Use this BEFORE answering questions about: 'this project', 'this codebase', 'this repo', the user's preferences/setup/tools, decisions made in past sessions, work-in-progress, or anything where the answer could differ from generic best practice. Returns repository-scoped hits with evidence trust (high = repeatedly useful, medium = kept but unconfirmed, low = draft or disputed), provenance, and the most recent handoff from this repository. Trust is not truth: verify mutable facts against live state. Hits anchored to code also report whether that code has changed since the memory was written — 'CODE CHANGED' or 'CODE DELETED' means re-verify before relying on it, and is a good reason to write a superseding memory. Empty or whitespace-only query orients you instead of searching: the active handoff, memory anchored to the files you are already changing (drifted first), open work, then the standing decisions and preferences that override generic best practice. Cheap call — use it at session start when you don't know what to ask.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search. Broaden if the first query returns no hits. Pass empty string to orient: handoff + memory about the code you are changing + open work + standing decisions." },
          limit: {
            type: "number",
            description: "Max hits (default 8).",
            default: 8,
          },
          maxTokens: {
            type: "number",
            description: "Approximate context budget. Default 900 tokens.",
            default: 900,
          },
          kinds: {
            type: "array",
            items: { type: "string", enum: ["decision", "preference", "procedure", "pitfall", "fact", "wip", "note"] },
            description: "Optional memory-kind filter.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "remember",
      description:
        "Jot a memory. Default state is 'draft' (auto-expires in 24h). Pass keep=true to promote immediately. Tags are optional, free-form. If the text closely overlaps something already kept, the response names it and suggests linking a supersession instead of leaving two unlinked copies — this never blocks the write.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to remember." },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional free-form tags.",
          },
          kind: {
            type: "string",
            enum: ["decision", "preference", "procedure", "pitfall", "fact", "wip", "note"],
            description: "Memory class. Dejavu infers conservatively when omitted.",
          },
          supersedes: {
            type: "array",
            items: { type: "string" },
            description: "Older slip ids this memory replaces.",
          },
          contradicts: {
            type: "array",
            items: { type: "string" },
            description: "Slip ids this memory explicitly disputes.",
          },
          anchors: {
            type: "array",
            items: { type: "string" },
            description:
              "Files this memory is about, as 'path', 'path:line', 'path#symbol', or 'path:line#symbol', repository-relative. Anchor whenever the memory is a claim about specific code — a pitfall in a function, a decision embodied in a config file, a procedure that depends on a script. Dejavu records the file's content hash now and reports on every future recall whether that code has since changed or been deleted, so the next agent knows to re-verify. Anchoring a path that does not exist is an error, so pass paths you have actually read.",
          },
          keep: {
            type: "boolean",
            description:
              "Promote to kept immediately. Default false (drafts auto-GC at 24h).",
            default: false,
          },
        },
        required: ["text"],
      },
    },
    {
      name: "touching",
      description:
        "Ask what memory is anchored to specific files. This is the reverse of recall: instead of searching by words, you search by code. Use it BEFORE editing files you have not touched this session — pass the paths you are about to change, or the paths from your diff. It surfaces pitfalls, decisions, and procedures previously recorded about exactly that code, and leads with the ones whose code has since changed. Returns nothing when no memory is anchored there, which is itself useful: it means what you learn is worth writing down with remember(anchors: [...]).",
      inputSchema: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Repository-relative or absolute file paths. Paths outside the repository are ignored.",
          },
          limit: { type: "number", description: "Max hits (default 20).", default: 20 },
        },
        required: ["paths"],
      },
    },
    {
      name: "handoff",
      description:
        "Close this session with a note for the next agent. One handoff per session — write it once, in your own voice. All drafts in this session are auto-promoted to kept.",
      inputSchema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "What happened this session, in your voice.",
          },
          next: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional: things the next agent should do or watch for.",
          },
        },
        required: ["summary"],
      },
    },
    {
      name: "assess",
      description: "Evaluate a recall receipt after acting. This measures retrieval quality separately from whether one slip was useful.",
      inputSchema: {
        type: "object",
        properties: {
          traceId: { type: "string", description: "Recall receipt id shown at the top of recall output." },
          assessment: { type: "string", enum: ["useful", "wrong", "missed", "no_memory_needed"] },
          note: { type: "string", description: "Optional short evidence note; do not paste transcripts." },
        },
        required: ["traceId", "assessment"],
      },
    },
    {
      name: "link",
      description: "Relate two memories in the current repository. Use supersedes when a newer memory replaces an older one; contradictions remain visible for auditability.",
      inputSchema: {
        type: "object",
        properties: {
          fromId: { type: "string" },
          toId: { type: "string" },
          kind: { type: "string", enum: ["supersedes", "contradicts", "related"] },
        },
        required: ["fromId", "toId", "kind"],
      },
    },
    {
      name: "resolve_handoff",
      description: "Mark an active handoff completed or abandoned so it stops directing future agents.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["completed", "abandoned"], default: "completed" },
        },
        required: ["id"],
      },
    },
    {
      name: "signal",
      description:
        "Close the feedback loop on a recalled slip. Three actions: 'used' bumps usedCount (the slip was helpful — confirms the trust label), 'wrong' bumps wrongCount (the slip was misleading or stale — warns future recalls), 'forget' expires the slip permanently (no undo; use when something was written incorrectly with keep=true). Use 'used' when a memory materially helped; two successful uses promote a kept memory to high trust. Use 'wrong' when misleading. Use 'forget' only when you're sure the slip is wrong, not merely outdated.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Slip ULID to signal on (from a recall hit).",
          },
          action: {
            type: "string",
            enum: ["used", "wrong", "forget"],
            description:
              "'used' = helpful. 'wrong' = misleading. 'forget' = expire (irreversible).",
          },
        },
        required: ["id", "action"],
      },
    },
    {
      name: "send",
      description: "Send a short async message to another local agent identity. This is mailbox-only: the recipient must call inbox. Use to coordinate with Pi/OpenCode/Claude/etc. Set to the recipient's DEJAVU_AUTHOR.",
      inputSchema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" }, threadId: { type: "string" } }, required: ["to", "body"] },
    },
    {
      name: "inbox",
      description: "Read messages addressed to an agent identity (default: this process's DEJAVU_AUTHOR). Call this when starting, when asked to check for work, or after sending a message and waiting for a reply.",
      inputSchema: { type: "object", properties: { to: { type: "string" }, limit: { type: "number", default: 20 }, includeRead: { type: "boolean", default: false } } },
    },
    {
      name: "read",
      description: "Mark a mailbox message read by id.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    {
      name: "reply",
      description: "Reply to a mailbox message by id. The reply goes to the original sender and stays in the same thread.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, body: { type: "string" } }, required: ["id", "body"] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const result = dispatch(dejavu, dispatchState, name, args as Record<string, unknown>);
  return {
    content: [{ type: "text", text: result.text }],
    ...(result.isError ? { isError: true } : {}),
  };
});

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

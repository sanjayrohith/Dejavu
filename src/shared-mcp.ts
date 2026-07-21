#!/usr/bin/env bun
/** Shared Dejavu MCP server — remote authority + local live mirror. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SharedDejavu } from "./shared-client/index.ts";
import { VERSION } from "./version.ts";

export interface SharedDispatchClient {
  remember(text: string, opts?: { tags?: string[] }): Promise<{ id: string; receipt: { revision: number }; recallable: true }>;
  handoff(summary: string, opts?: { next?: string[] }): Promise<{ id: string; receipt: { revision: number }; recallable: true }>;
  signal(slipId: string, action: "used" | "wrong" | "forget"): Promise<{ id: string; receipt: { revision: number }; recallable: true }>;
  delete(slipId: string): Promise<{ id: string; receipt: { revision: number }; recallable: true }>;
  recall(query: string, limit?: number): { hits: Array<{ slipId: string; text: string; tags: string[]; revision: number; authoredBy: string; committedAt: string; usedCount?: number; wrongCount?: number }>; mirrorRevision: number; latestHandoff?: { summary: string; revision: number; next: string[] } | null };
  status(): { status: string; mirrorRevision: number; knownHeadRevision: number; freshness: { behind: number; fresh: boolean } };
  refreshStatus(): Promise<{ status: string; mirrorRevision: number; knownHeadRevision: number; freshness: { behind: number; fresh: boolean } }>;
}

export async function dispatchShared(
  client: SharedDispatchClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError?: boolean }> {
  try {
    switch (name) {
      case "remember": {
        const text = String(args.text ?? "");
        const tags = (args.tags as string[] | undefined) ?? [];
        const receipt = await client.remember(text, { tags });
        return { text: `kept shared slip ${receipt.id} — committed revision ${receipt.receipt.revision}; immediately recallable` };
      }
      case "handoff": {
        const receipt = await client.handoff(String(args.summary ?? ""), { next: (args.next as string[] | undefined) ?? [] });
        return { text: `shared handoff ${receipt.id} — committed revision ${receipt.receipt.revision}` };
      }
      case "signal": {
        const slipId = String(args.id ?? "");
        const action = String(args.action ?? "") as "used" | "wrong" | "forget";
        if (!( ["used", "wrong", "forget"] as string[]).includes(action)) return { text: `error: unknown action '${action}'`, isError: true };
        const receipt = await client.signal(slipId, action);
        return { text: `shared signal: ${slipId} ${action} — committed revision ${receipt.receipt.revision}` };
      }
      case "delete": {
        const slipId = String(args.id ?? "");
        const receipt = await client.delete(slipId);
        return { text: `deleted shared slip ${slipId} — committed revision ${receipt.receipt.revision}; removed from synced local copies and redacted from server replay history` };
      }
      case "recall": {
        const query = String(args.query ?? "");
        const limit = Number(args.limit ?? 8);
        const result = client.recall(query, limit);
        const handoff = result.latestHandoff ? `# latest shared handoff [rev ${result.latestHandoff.revision}]\n${result.latestHandoff.summary}${result.latestHandoff.next.length ? `\nnext: ${result.latestHandoff.next.join("; ")}` : ""}\n\n` : "";
        if (result.hits.length === 0) {
          return { text: `${handoff}# shared recall("${query}") — no local mirror hits at revision ${result.mirrorRevision}` };
        }
        const body = result.hits.map((hit) => `- ${hit.slipId} [rev ${hit.revision}] ${hit.text}${hit.tags.length ? ` [${hit.tags.join(", ")}]` : ""}${hit.usedCount || hit.wrongCount ? ` (used=${hit.usedCount ?? 0}, wrong=${hit.wrongCount ?? 0})` : ""}`).join("\n");
        return { text: `${handoff}# shared recall("${query}") — mirror revision ${result.mirrorRevision}\n${body}` };
      }
      case "status": {
        const result = Boolean(args.refresh ?? true) ? await client.refreshStatus() : client.status();
        return { text: `shared memory: ${result.status}; mirror revision ${result.mirrorRevision}; authority head ${result.knownHeadRevision}; behind ${result.freshness.behind}; fresh=${result.freshness.fresh}` };
      }
      default:
        return { text: `unknown shared tool: ${name}`, isError: true };
    }
  } catch (error) {
    return { text: `error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

export async function runSharedServer(client: SharedDispatchClient): Promise<void> {
  const server = new Server({ name: "dejavu-shared", version: `${VERSION}-preview` }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "recall", description: "Search the fresh local mirror of shared memory. Use for cross-session/project decisions and current work. If status says stale, refresh/reconnect before treating absence as authoritative.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number", default: 8 } }, required: ["query"] } },
    { name: "remember", description: "Keep a shared memory immediately. The authority commits it and returns a revision receipt; this client's mirror applies the receipt immediately.", inputSchema: { type: "object", properties: { text: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["text"] } },
    { name: "handoff", description: "Close this shared session with a durable handoff for the next connected agent.", inputSchema: { type: "object", properties: { summary: { type: "string" }, next: { type: "array", items: { type: "string" } } }, required: ["summary"] } },
    { name: "signal", description: "Record feedback on a recalled slip: used or wrong. The legacy forget signal hides a slip from recall; use delete when removal is intended.", inputSchema: { type: "object", properties: { id: { type: "string" }, action: { type: "string", enum: ["used", "wrong", "forget"] } }, required: ["id", "action"] } },
    { name: "delete", description: "Delete a shared slip. The numbered deletion makes disconnected local copies remove it during catch-up and redacts its remembered payload from server replay history.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { name: "status", description: "Show shared feed/mirror freshness: connection status, mirror revision, server head, and revision gap.", inputSchema: { type: "object", properties: { refresh: { type: "boolean", default: true } } } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await dispatchShared(client, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
    return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) };
  });
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  const gateway = process.env.DEJAVU_SHARED_GATEWAY;
  if (!gateway) throw new Error("DEJAVU_SHARED_GATEWAY is required to run shared MCP");
  const client = await SharedDejavu.connect({ gateway });
  await runSharedServer(client);
}

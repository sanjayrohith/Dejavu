#!/usr/bin/env bun
/** Independent local/cloud client used by experiment 16. JSON-lines RPC on stdio. */
import { Dejavu, SharedDejavu } from "../../src/index.ts";
import { currentMemoryContext } from "../../src/context.ts";

const role = need("EXP16_ROLE");
const shared = await SharedDejavu.connect({
  gateway: need("DEJAVU_SHARED_GATEWAY"),
  token: need("DEJAVU_SHARED_TOKEN"),
  author: `exp16-${role}`,
  sessionId: `exp16-${role}-${need("EXP16_RUN")}`,
  mirrorOptions: { path: need("EXP16_MIRROR_DB") },
});
const local = new Dejavu({
  path: need("EXP16_LOCAL_DB"),
  noChainRollup: true,
  recordRecallTraces: false,
});

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
function nowMs(): number { return Number(process.hrtime.bigint()) / 1e6; }
function localView(query: string) {
  const result = local.recall(query);
  return {
    scope: local.scope,
    hitIds: result.hits.map((hit) => hit.slip.id),
    texts: result.hits.map((hit) => hit.slip.text),
    activeHandoff: result.activeHandoff && {
      id: result.activeHandoff.id,
      summary: result.activeHandoff.summary,
      status: result.activeHandoff.status,
    },
  };
}
function sharedView(query: string) {
  const result = shared.recall(query, 20);
  return {
    mirrorRevision: result.mirrorRevision,
    hitIds: result.hits.map((hit) => hit.slipId),
    texts: result.hits.map((hit) => hit.text),
    latestHandoff: result.latestHandoff ?? null,
  };
}

async function dispatch(command: any): Promise<any> {
  switch (command.op) {
    case "info":
      return {
        role,
        pid: process.pid,
        cwd: process.cwd(),
        localScope: local.scope,
        connection: shared.status(),
      };
    case "contexts":
      return Object.fromEntries(Object.entries(command.paths).map(([key, value]) => [key, currentMemoryContext(String(value))]));
    case "write_initial": { // local agent owns repository-scoped operational handoff
      const t0 = nowMs();
      const slip = local.remember(command.text, { tags: ["decision", command.marker] });
      const handoff = local.handoff({
        summary: command.summary,
        next: [command.next],
      });
      const localMs = nowMs() - t0;
      const t1 = nowMs();
      const sharedSlip = await shared.remember(command.text, { tags: [command.marker, "continuity"] });
      const sharedHandoff = await shared.handoff(command.summary, {
        next: [command.next],
        kept: [sharedSlip.id],
      });
      const sharedMs = nowMs() - t1;
      return {
        localSlipId: slip.id,
        localHandoffId: handoff.id,
        localMs,
        localView: localView(command.marker),
        sharedSlipId: sharedSlip.id,
        rememberRevision: sharedSlip.receipt.revision,
        handoffRevision: sharedHandoff.receipt.revision,
        sharedMs,
        sharedView: sharedView(command.marker),
      };
    }
    case "write_update": {
      const slip = local.remember(command.text, { tags: ["wip", command.marker] });
      local.keep([slip.id], { noChainRollup: true });
      const t0 = nowMs();
      const receipt = await shared.remember(command.text, { tags: [command.marker, "offline-update"] });
      return {
        localSlipId: slip.id,
        sharedSlipId: receipt.id,
        revision: receipt.receipt.revision,
        writeMs: nowMs() - t0,
        sharedView: sharedView(command.marker),
      };
    }
    case "local_view": return localView(command.query);
    case "shared_view": return sharedView(command.query);
    case "disconnect": return await shared.disconnect();
    case "probe_status": return await shared.refreshStatus();
    case "reconnect": return await shared.reconnect();
    case "resolve": { // cloud-shaped agent records exact resolution at authority
      const t0 = nowMs();
      const resolution = await shared.remember(command.text, { tags: [command.marker, "resolved"] });
      return {
        resolutionSlipId: resolution.id,
        resolutionRevision: resolution.receipt.revision,
        writeMs: nowMs() - t0,
        sharedView: sharedView(command.marker),
      };
    }
    case "resolve_local":
      return { resolved: local.resolveHandoff(command.id, "completed"), view: localView(command.query) };
    case "close":
      await shared.close();
      local.close();
      return { closed: true };
    default: throw new Error(`unknown op ${command.op}`);
  }
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let id: number | string | undefined;
    try {
      const request = JSON.parse(line);
      id = request.id;
      const result = await dispatch(request);
      console.log(JSON.stringify({ id, ok: true, result }));
      if (request.op === "close") process.exit(0);
    } catch (error) {
      console.log(JSON.stringify({ id, ok: false, error: error instanceof Error ? error.stack : String(error) }));
    }
  }
}

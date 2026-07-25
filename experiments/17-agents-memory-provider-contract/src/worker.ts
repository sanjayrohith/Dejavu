import { Agent } from "agents";
import type { MemoryScope, MemoryWrite, RecallRequest } from "./contract";
import { AsyncSemanticMemory, OperationalSqlMemory } from "./providers";

interface Env extends Cloudflare.Env {
  MEMORY_AGENT: DurableObjectNamespace<MemoryAgent>;
}

type AdapterName = "operational" | "semantic";

export class MemoryAgent extends Agent<Env> {
  private operational = new OperationalSqlMemory(this);
  private semantic = new AsyncSemanticMemory(this);

  private provider(name: AdapterName) {
    return name === "semantic" ? this.semantic : this.operational;
  }

  async onRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const adapter = (url.searchParams.get("adapter") ?? "operational") as AdapterName;
      if (adapter !== "operational" && adapter !== "semantic") {
        return Response.json({ error: "unknown adapter" }, { status: 400 });
      }
      const provider = this.provider(adapter);

      if (request.method === "POST" && url.pathname === "/write") {
        return Response.json(await provider.write(await request.json<MemoryWrite>()));
      }
      if (request.method === "POST" && url.pathname === "/recall") {
        return Response.json(await provider.recall(await request.json<RecallRequest>()));
      }
      if (request.method === "POST" && url.pathname === "/drain" && adapter === "semantic") {
        return Response.json({ processed: await this.semantic.drain() });
      }
      if (request.method === "POST" && url.pathname === "/freshness") {
        const { scope } = await request.json<{ scope: MemoryScope }>();
        return Response.json(await provider.freshness(scope));
      }
      if (request.method === "POST" && url.pathname === "/delete") {
        const body = await request.json<{ id: string; scope: MemoryScope }>();
        return Response.json(await provider.delete(body.id, body.scope));
      }
      if (request.method === "POST" && url.pathname === "/resolve") {
        const body = await request.json<{
          id: string;
          scope: MemoryScope;
          replacedBy: string;
          reason?: string;
        }>();
        return Response.json(
          await provider.resolve(body.id, body.scope, {
            replacedBy: body.replacedBy,
            ...(body.reason ? { reason: body.reason } : {}),
          }),
        );
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, primitive: "agents.Agent", version: "0.15.0" });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  }
}

export default {
  fetch(request: Request, env: Env) {
    // A real Durable Object namespace routes every test call to one Agent instance.
    return env.MEMORY_AGENT.get(env.MEMORY_AGENT.idFromName("experiment-17")).fetch(request);
  },
} satisfies ExportedHandler<Env>;

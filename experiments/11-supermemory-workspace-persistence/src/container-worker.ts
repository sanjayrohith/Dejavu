import { DurableObject } from "cloudflare:workers";
import { Workspace, WorkspaceProxy, type DurableObjectStorageLike, type WorkspaceStub } from "@cloudflare/workspace";
import { CloudflareContainerBackend, withWorkspaceContainer } from "@cloudflare/workspace/backends/container";

export { WorkspaceProxy };

interface ContainerEnv {
  MEMORY_CONTAINER: DurableObjectNamespace<MemoryContainer>;
}

export class MemoryContainer extends withWorkspaceContainer(class extends DurableObject<ContainerEnv> {}) {
  readonly backend: CloudflareContainerBackend;
  readonly workspace: Workspace;

  constructor(ctx: DurableObjectState, env: ContainerEnv) {
    super(ctx, env);
    this.backend = new CloudflareContainerBackend({
      container: () => this,
      workspace: { binding: "MemoryContainer", id: ctx.id.toString() },
      connectTimeoutMs: 20_000,
    });
    this.workspace = new Workspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      backends: [this.backend],
    });
  }

  async getWorkspace(): Promise<WorkspaceStub> {
    await this.workspace.ready();
    return this.workspace.stub();
  }

  override fetch(request: Request): Promise<Response> {
    return this.backend.handleFetch(request);
  }
}

export default {
  async fetch(request: Request, env: ContainerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, backend: "workspace-container" });
    if (url.pathname !== "/probe" || request.method !== "POST") return new Response("not found", { status: 404 });
    const body: { command?: string } = await request.json<{ command?: string }>().catch(() => ({}));
    if (!body.command || body.command.length > 4000) return Response.json({ ok: false, error: "bounded command required" }, { status: 400 });
    const stub = env.MEMORY_CONTAINER.get(env.MEMORY_CONTAINER.idFromName("exp11"));
    try {
      using workspace = await stub.getWorkspace();
      using handle = await workspace.shell.exec(body.command, { encoding: "utf8" });
      const result = await handle.result();
      return Response.json({ ok: result.exitCode === 0, ...result }, { status: result.exitCode === 0 ? 200 : 500 });
    } catch (error) {
      return Response.json({ ok: false, stage: "workspace-container-connect", error: error instanceof Error ? error.message : String(error) }, { status: 503 });
    }
  },
} satisfies ExportedHandler<ContainerEnv>;

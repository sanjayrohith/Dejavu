import { DurableObject } from "cloudflare:workers";
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/workspace";

interface FsEnv {
  WORKSPACE: DurableObjectNamespace<WorkspaceStore>;
}

export class WorkspaceStore extends DurableObject<FsEnv> {
  readonly workspace: Workspace;

  constructor(ctx: DurableObjectState, env: FsEnv) {
    super(ctx, env);
    this.workspace = new Workspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
    });
  }

  async put(path: string, bytes: Uint8Array): Promise<void> {
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    await this.workspace.fs.mkdir(parent, { recursive: true });
    await this.workspace.fs.writeFile(path, bytes);
  }

  async get(path: string): Promise<Uint8Array> {
    const stream = await this.workspace.fs.readFile(path);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
}

export default {
  async fetch(request: Request, env: FsEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, backend: "workspace-sqlite-vfs" });
    const match = url.pathname.match(/^\/workspace\/([^/]+)\/(.+)$/);
    if (!match) return new Response("not found", { status: 404 });
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(match[1]));
    const path = `/workspace/${match[2]}`;
    if (request.method === "PUT") {
      await stub.put(path, new Uint8Array(await request.arrayBuffer()));
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET") {
      try {
        const bytes = await stub.get(path);
        return new Response(bytes.buffer as ArrayBuffer, { headers: { "content-type": "application/octet-stream" } });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 });
      }
    }
    return new Response("method not allowed", { status: 405 });
  },
} satisfies ExportedHandler<FsEnv>;

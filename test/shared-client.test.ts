import { describe, expect, test } from "bun:test";
import { SharedDejavu } from "../src/shared-client/index.ts";
import { SharedAuthority, handleAuthorityRequest } from "../src/shared-authority/index.ts";
import { LocalMirror } from "../src/shared-mirror/index.ts";

function setup() {
  let e = 0;
  const authority = new SharedAuthority({ authority: "owner", newEventId: () => `event-${++e}` });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = typeof input === "string" || input instanceof URL
      ? new Request(String(input), init)
      : new Request(input, init);
    return handleAuthorityRequest(authority, request);
  }) as typeof fetch;
  const mirror = new LocalMirror({ path: ":memory:", authority: "owner" });
  const client = new SharedDejavu({ gateway: "http://memory.test", fetch: fetcher, mirror, author: "agent", sessionId: "sess" });
  return { authority, client, mirror };
}

describe("SharedDejavu facade", () => {
  test("connect catches up, remember applies receipt locally, recall finds own write", async () => {
    const { client, mirror } = setup();
    const connected = await client.connect();
    expect(connected.status).toBe("live");
    const receipt = await client.remember("Decision: use live mirror feed", { tags: ["decision"] });
    expect(receipt.receipt.revision).toBe(1);
    expect(client.recall("live mirror").hits[0]?.text).toContain("live mirror");
    expect(mirror.getMirrorRevision()).toBe(1);
    await client.close();
    mirror.close();
  });

  test("connected peer receives streamed write into its local mirror", async () => {
    const a = setup();
    const bMirror = new LocalMirror({ path: ":memory:", authority: "owner" });
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = typeof input === "string" || input instanceof URL ? new Request(String(input), init) : new Request(input, init);
      return handleAuthorityRequest(a.authority, request);
    }) as typeof fetch;
    const b = new SharedDejavu({ gateway: "http://memory.test", fetch: fetcher, mirror: bMirror, author: "b", sessionId: "b" });
    await a.client.connect();
    await b.connect();
    await a.client.remember("Peer streamed searchable fact", { tags: ["peer"] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(b.recall("streamed searchable").hits[0]?.text).toContain("Peer streamed");
    expect(b.status().freshness.fresh).toBe(true);
    await a.client.close(); await b.close(); a.mirror.close(); bMirror.close();
  });

  test("handoff and signal are revisioned through authority", async () => {
    const { client, mirror } = setup();
    await client.connect();
    const remembered = await client.remember("signal me", { slipId: "target" });
    const handoff = await client.handoff("continue shared work", { next: ["test"] });
    const signal = await client.signal(remembered.id, "used");
    expect(handoff.event.type).toBe("handoff");
    expect(signal.event.type).toBe("signal");
    expect(signal.receipt.revision).toBe(3);
    await client.close(); mirror.close();
  });

  test("delete applies immediately and peers remove deleted memory through live updates", async () => {
    const a = setup();
    const bMirror = new LocalMirror({ path: ":memory:", authority: "owner" });
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = typeof input === "string" || input instanceof URL ? new Request(String(input), init) : new Request(input, init);
      return handleAuthorityRequest(a.authority, request);
    }) as typeof fetch;
    const b = new SharedDejavu({ gateway: "http://memory.test", fetch: fetcher, mirror: bMirror, author: "b", sessionId: "b" });
    await a.client.connect(); await b.connect();
    await a.client.remember("Delete me everywhere", { slipId: "remove-me" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(b.recall("Delete everywhere").hits).toHaveLength(1);
    const receipt = await a.client.delete("remove-me");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(receipt.event.type).toBe("delete");
    expect(a.client.recall("Delete everywhere").hits).toHaveLength(0);
    expect(b.recall("Delete everywhere").hits).toHaveLength(0);
    await a.client.close(); await b.close(); a.mirror.close(); bMirror.close();
  });

  test("sends bearer token when configured", async () => {
    let seen = "";
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = typeof input === "string" || input instanceof URL ? new Request(String(input), init) : new Request(input, init);
      seen = request.headers.get("authorization") ?? "";
      if (new URL(request.url).pathname.endsWith("/status")) return Response.json({ ok: true, authority: "owner", headRevision: 0 });
      if (new URL(request.url).pathname.endsWith("/events")) return Response.json({ ok: true, authority: "owner", headRevision: 0, events: [] });
      return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const mirror = new LocalMirror({ path: ":memory:" });
    const d = new SharedDejavu({ gateway: "http://m", token: "secret", fetch: fetcher, mirror });
    await d.refreshStatus();
    expect(seen).toBe("Bearer secret");
    await d.close(); mirror.close();
  });

  test("validates empty shared remember text", async () => {
    const { client, mirror } = setup();
    expect(client.remember("   ")).rejects.toThrow("text is empty");
    await client.close(); mirror.close();
  });

  test("server stream expiry triggers an auto-reconnect through the client lifecycle handler", async () => {
    let streamConnects = 0;
    const fetcher = (async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(typeof input === "string" || input instanceof URL ? input : (input as Request).url);
      if (url.includes("/v1/shared/stream")) {
        streamConnects++;
        const isFirst = streamConnects === 1;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            if (isFirst) {
              controller.enqueue(encoder.encode(`event: expires\ndata: ${JSON.stringify({ reason: "stream-ttl", ttlSeconds: 1, expiresAt: "2030-01-01T00:00:00.000Z" })}\n\n`));
              setTimeout(() => {
                const closing = `event: closed\ndata: ${JSON.stringify({ reason: "stream-ttl" })}\n\n`;
                controller.enqueue(encoder.encode(closing));
                controller.close();
              }, 5);
            }
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ ok: true, authority: "owner", headRevision: 0, events: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const mirror = new LocalMirror({ path: ":memory:", authority: "owner" });
    const lifecycle: string[] = [];
    const d = new SharedDejavu({
      gateway: "http://x",
      fetch: fetcher,
      mirror,
      onStreamLifecycle: (event) => lifecycle.push(event.kind),
    });
    await d.connect();
    for (let i = 0; i < 60 && streamConnects < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(streamConnects).toBeGreaterThanOrEqual(2);
    expect(lifecycle).toContain("expires");
    await d.close();
    mirror.close();
  });
});

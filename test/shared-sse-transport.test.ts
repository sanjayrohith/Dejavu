import { describe, expect, test } from "bun:test";
import { SharedAuthority, handleAuthorityRequest } from "../src/shared-authority/index.ts";
import { LocalMirror, SharedConnection, createSharedHttpTransport, parseSseFrames } from "../src/shared-mirror/index.ts";

function authority() {
  let event = 0;
  return new SharedAuthority({ authority: "owner-test", newEventId: () => `event-${++event}` });
}
function remember(a: SharedAuthority, slipId: string, text: string) {
  return a.remember({ slipId, text, tags: ["shared"], authoredBy: "a", sessionId: "s" });
}
function inProcessFetch(a: SharedAuthority): typeof fetch {
  return (async (input, init) => {
    const source = typeof input === "string" || input instanceof URL
      ? new Request(input.toString(), init)
      : new Request(input, init);
    return handleAuthorityRequest(a, source);
  }) as typeof fetch;
}

describe("SSE authority adapter", () => {
  test("stream emits hello then backlog and live committed events", async () => {
    const a = authority();
    remember(a, "s1", "alpha first");
    const response = await handleAuthorityRequest(a, new Request("http://x/v1/shared/stream?since=0"));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let i = 0; i < 2 && !text.includes("alpha first"); i++) {
      text += decoder.decode((await reader.read()).value ?? new Uint8Array());
    }
    expect(text).toContain("event: hello");
    expect(text).toContain("event: memory");
    expect(text).toContain("alpha first");
    remember(a, "s2", "beta live");
    text += decoder.decode((await reader.read()).value ?? new Uint8Array());
    expect(text).toContain("beta live");
    await reader.cancel();
  });
});

describe("SSE client transport", () => {
  test("parses SSE blocks and ignores comments", () => {
    const parsed = parseSseFrames(': keepalive\n\nevent: memory\ndata: {"revision":1}\n\npartial');
    expect(parsed.frames).toEqual([{ event: "memory", data: '{"revision":1}' }]);
    expect(parsed.remainder).toBe("partial");
  });

  test("onLifecycle fires for expires/closed frames without misinterpreting them as memory", async () => {
    const lifecycle: Array<{ kind: string; ttlSeconds?: number }> = [];
    const fetcher = (async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(typeof input === "string" || input instanceof URL ? input : (input as Request).url);
      if (url.includes("/v1/shared/stream")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(`event: expires\ndata: ${JSON.stringify({ reason: "stream-ttl", ttlSeconds: 30, expiresAt: "2030-01-01T00:00:00.000Z" })}\n\n`));
            controller.enqueue(encoder.encode(`event: closed\ndata: ${JSON.stringify({ reason: "stream-ttl" })}\n\n`));
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ ok: true, authority: "owner-test", headRevision: 0, events: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const transport = createSharedHttpTransport({
      baseUrl: "http://x",
      fetch: fetcher,
      onLifecycle: (event) => lifecycle.push({ kind: event.kind, ttlSeconds: event.ttlSeconds }),
    });
    const mirror = new LocalMirror({ path: ":memory:", authority: "owner-test" });
    const connection = new SharedConnection({ mirror, ...transport });
    await connection.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lifecycle).toEqual([
      { kind: "expires", ttlSeconds: 30 },
      { kind: "closed", ttlSeconds: undefined },
    ]);
    expect(mirror.getMirrorRevision()).toBe(0);
    await connection.stop();
    mirror.close();
  });

  test("SharedConnection receives live HTTP SSE events into local FTS mirror", async () => {
    const a = authority();
    const mirror = new LocalMirror({ path: ":memory:", authority: "owner-test" });
    const transport = createSharedHttpTransport({ baseUrl: "http://x", fetch: inProcessFetch(a) });
    const connection = new SharedConnection({ mirror, ...transport });
    const start = await connection.start();
    expect(start.status).toBe("live");
    remember(a, "live-slip", "needle streamed memory");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = mirror.recallLocal({ query: "needle streamed" });
    expect(result.hits.map((hit) => hit.slipId)).toEqual(["live-slip"]);
    expect(connection.freshness().fresh).toBe(true);
    await connection.stop();
    mirror.close();
  });

  test("connection catch-up fetches committed events missed before subscribe", async () => {
    const a = authority();
    remember(a, "past", "past catchup memory");
    const mirror = new LocalMirror({ path: ":memory:", authority: "owner-test" });
    const transport = createSharedHttpTransport({ baseUrl: "http://x", fetch: inProcessFetch(a) });
    const connection = new SharedConnection({ mirror, ...transport });
    await connection.start();
    expect(mirror.recallLocal({ query: "past catchup" }).hits).toHaveLength(1);
    expect(mirror.getMirrorRevision()).toBe(1);
    await connection.stop();
    mirror.close();
  });
});

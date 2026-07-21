// Unit tests for the shared-server Worker entry point.
//
// These prove local token authentication routes each configured memory space
// to a different Durable Object. Durable Object storage itself is exercised by
// the shell integration test.
//
// Run with: bun test shared-server/test/worker.unit.test.ts

import { describe, expect, test } from "bun:test";
import worker from "../src/worker.ts";

type StubEnv = {
  MEMORY: {
    idFromName: (name: string) => string;
    get: (id: string) => { fetch: (req: Request) => Promise<Response> };
  };
  DEJAVU_SHARED_TOKEN?: string;
  DEJAVU_SHARED_TOKENS?: string;
  DEJAVU_SHARED_STREAM_TTL_SECONDS?: string;
};

function makeEnv(opts: { legacyToken?: string; mappedTokens?: string; ttl?: string } = {}) {
  const seen: { id: string | null; request: Request | null } = { id: null, request: null };
  const env: StubEnv = {
    DEJAVU_SHARED_TOKEN: opts.legacyToken,
    DEJAVU_SHARED_TOKENS: opts.mappedTokens,
    DEJAVU_SHARED_STREAM_TTL_SECONDS: opts.ttl,
    MEMORY: {
      idFromName: (name: string) => `id:${name}`,
      get: (id: string) => ({
        fetch: async (request: Request) => {
          seen.id = id;
          seen.request = request;
          return Response.json({ ok: true, routed: true }, { status: 200 });
        },
      }),
    },
  };
  return { env, seen };
}

async function fetchStatus(env: StubEnv, token?: string) {
  return worker.fetch(
    new Request("http://server.test/v1/shared/status", {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    }),
    env as unknown as Parameters<typeof worker.fetch>[1],
  );
}

describe("worker entry: local token-to-space routing", () => {
  test("missing Authorization header returns 401", async () => {
    const { env } = makeEnv({ mappedTokens: "alice-token:alice" });
    const response = await fetchStatus(env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  test("wrong bearer token returns 401", async () => {
    const { env } = makeEnv({ mappedTokens: "alice-token:alice" });
    expect((await fetchStatus(env, "wrong")).status).toBe(401);
  });

  test("missing configured tokens always refuses to serve", async () => {
    const { env } = makeEnv();
    expect((await fetchStatus(env, "anything")).status).toBe(401);
  });

  test("mapped token routes to its named memory space and forwards that space", async () => {
    const { env, seen } = makeEnv({ mappedTokens: "alice-token:alice,bob-token:bob" });
    const response = await fetchStatus(env, "alice-token");
    expect(response.status).toBe(200);
    expect(seen.id).toBe("id:space:alice");
    expect(seen.request?.headers.get("x-dejavu-space")).toBe("alice");
  });

  test("two tokens route to separate Durable Objects", async () => {
    const alice = makeEnv({ mappedTokens: "alice-token:alice,bob-token:bob" });
    const bob = makeEnv({ mappedTokens: "alice-token:alice,bob-token:bob" });
    await fetchStatus(alice.env, "alice-token");
    await fetchStatus(bob.env, "bob-token");
    expect(alice.seen.id).toBe("id:space:alice");
    expect(bob.seen.id).toBe("id:space:bob");
    expect(alice.seen.id).not.toBe(bob.seen.id);
  });

  test("invalid mapped space is ignored", async () => {
    const { env } = makeEnv({ mappedTokens: "bad-token:../../all-memories" });
    expect((await fetchStatus(env, "bad-token")).status).toBe(401);
  });

  test("legacy single local token remains supported only in the local space", async () => {
    const { env, seen } = makeEnv({ legacyToken: "ok" });
    const response = await worker.fetch(
      new Request("http://server.test/v1/shared/events?since=3", {
        headers: { authorization: "bearer ok" },
      }),
      env as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(response.status).toBe(200);
    expect(seen.id).toBe("id:space:local");
    expect(seen.request?.headers.get("x-dejavu-space")).toBe("local");
    expect(new URL(seen.request!.url).searchParams.get("since")).toBe("3");
  });

  test("stream requests carry a default bounded TTL header", async () => {
    const { env, seen } = makeEnv({ mappedTokens: "alice-token:alice" });
    await worker.fetch(
      new Request("http://server.test/v1/shared/stream", {
        headers: { authorization: "Bearer alice-token" },
      }),
      env as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(seen.request?.headers.get("x-dejavu-stream-ttl-seconds")).toBe("900");
  });

  test("DEJAVU_SHARED_STREAM_TTL_SECONDS overrides the default TTL header", async () => {
    const { env, seen } = makeEnv({ mappedTokens: "alice-token:alice", ttl: "60" });
    await worker.fetch(
      new Request("http://server.test/v1/shared/stream", {
        headers: { authorization: "Bearer alice-token" },
      }),
      env as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(seen.request?.headers.get("x-dejavu-stream-ttl-seconds")).toBe("60");
  });

  test("DEJAVU_SHARED_STREAM_TTL_SECONDS=unbounded omits the TTL header", async () => {
    const { env, seen } = makeEnv({ mappedTokens: "alice-token:alice", ttl: "unbounded" });
    await worker.fetch(
      new Request("http://server.test/v1/shared/stream", {
        headers: { authorization: "Bearer alice-token" },
      }),
      env as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(seen.request?.headers.get("x-dejavu-stream-ttl-seconds")).toBeNull();
  });
});

/**
 * HTTP-ish handler functions for the shared-memory authority seam.
 *
 *   POST /v1/shared/remember
 *   POST /v1/shared/handoff
 *   POST /v1/shared/signal
 *   POST /v1/shared/delete
 *   GET  /v1/shared/events?since=<revision>&limit=<n>
 *   GET  /v1/shared/status
 *   GET  /v1/shared/stream?since=<revision> (SSE)
 *
 * The contract calls these out as "HTTP-ish handler functions" for Slice A.
 * We expose two equivalent shapes:
 *
 *   - `handle(request)`: a fetch-like adapter that takes a `Request` and
 *     returns a `Response`. Suitable for dropping behind a future Worker /
 *     Durable Object wrapper.
 *   - `handlers.remember/eventsSince/status`: plain function calls that
 *     return JSON-serializable bodies. Suitable for in-process callers and
 *     tests, and for the Worker wrapper that just wants to call them and
 *     `Response.json()` the result.
 *
 */

import type { SharedAuthority } from "./authority.ts";
import { createSseResponse } from "./sse.ts";
import type {
  DeleteWriteInput,
  HandoffWriteInput,
  RememberWriteInput,
  SharedAuthorityStatus,
  SharedEventsResponse,
  SharedDeletePayload,
  SharedHandoffPayload,
  SharedRememberPayload,
  SharedSignalPayload,
  SharedWriteReceipt,
  SignalWriteInput,
} from "./types.ts";

export interface AuthorityFunctionApi {
  remember(input: RememberWriteInput): SharedWriteReceipt<SharedRememberPayload>;
  handoff(input: HandoffWriteInput): SharedWriteReceipt<SharedHandoffPayload>;
  signal(input: SignalWriteInput): SharedWriteReceipt<SharedSignalPayload>;
  delete(input: DeleteWriteInput): SharedWriteReceipt<SharedDeletePayload>;
  eventsSince(since?: number, limit?: number): SharedEventsResponse;
  status(): SharedAuthorityStatus;
}

export function createHandlers(authority: SharedAuthority): AuthorityFunctionApi {
  return {
    remember: (input) => authority.remember(input),
    handoff: (input) => authority.handoff(input),
    signal: (input) => authority.signal(input),
    delete: (input) => authority.delete(input),
    eventsSince: (since, limit) => authority.eventsSince(since, limit),
    status: () => authority.status(),
  };
}

/**
 * Fetch-like adapter. Routes by `${method} ${pathname}`.
 *
 * Errors are mapped to JSON `{ ok: false, error }` with conservative status
 * codes (400 for bad input, 404 for unknown route, 405 for wrong method).
 */
export async function handleAuthorityRequest(
  authority: SharedAuthority,
  request: Request,
  basePath: string = "/v1/shared",
): Promise<Response> {
  const url = new URL(request.url);
  const path = stripBase(url.pathname, basePath);

  try {
    if (path === "/remember") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const body = await safeJson(request);
      const input = body as RememberWriteInput;
      const receipt = authority.remember(input);
      return jsonResponse(receipt, 200);
    }

    if (path === "/handoff") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return jsonResponse(authority.handoff((await safeJson(request)) as HandoffWriteInput), 200);
    }

    if (path === "/signal") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return jsonResponse(authority.signal((await safeJson(request)) as SignalWriteInput), 200);
    }

    if (path === "/delete") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return jsonResponse(authority.delete((await safeJson(request)) as DeleteWriteInput), 200);
    }

    if (path === "/events") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const since = parseInt(url.searchParams.get("since") ?? "0", 10);
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw == null ? undefined : parseInt(limitRaw, 10);
      const out = authority.eventsSince(
        Number.isFinite(since) ? since : 0,
        Number.isFinite(limit as number) ? (limit as number) : undefined,
      );
      return jsonResponse(out, 200);
    }

    if (path === "/status") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return jsonResponse(authority.status(), 200);
    }

    if (path === "/stream") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const since = parseInt(url.searchParams.get("since") ?? "0", 10);
      return createSseResponse(authority, {
        since: Number.isFinite(since) ? since : 0,
        overflow: "close",
      });
    }

    return jsonResponse({ ok: false, error: `unknown route ${path}` }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ ok: false, error: message }, 400);
  }
}

function stripBase(pathname: string, basePath: string): string {
  if (!basePath) return pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(basePath + "/")) return pathname.slice(basePath.length);
  return pathname;
}

async function safeJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function methodNotAllowed(allow: string): Response {
  return new Response(
    JSON.stringify({ ok: false, error: "method not allowed" }),
    {
      status: 405,
      headers: { "content-type": "application/json", allow },
    },
  );
}

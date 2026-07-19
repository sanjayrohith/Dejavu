import { openLiveFeed, type LiveFeedOptions } from "./subscription.ts";
import type { SharedAuthority } from "./authority.ts";
import type { SharedMemoryEvent } from "../shared-contract.ts";

const encoder = new TextEncoder();

export interface SseStreamOptions extends LiveFeedOptions {
  /** Optional comment keepalive interval. Disabled by default. */
  keepaliveMs?: number;
}

/** Encode a committed shared-memory event using the public SSE seam. */
export function encodeSseMemoryEvent(event: SharedMemoryEvent): Uint8Array {
  return encoder.encode(
    `id: ${event.revision}\nevent: memory\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

/**
 * Web-standard SSE Response adapter over LiveFeed.
 *
 * Backpressure/overflow is owned by LiveFeed: the default overflow policy is
 * `close`, so a slow subscriber gets disconnected rather than blocking writes.
 */
export function createSseResponse(
  authority: SharedAuthority,
  opts: SseStreamOptions = {},
): Response {
  const feed = openLiveFeed(authority, opts);
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `event: hello\ndata: ${JSON.stringify(authority.status())}\n\n`,
        ),
      );
      if (opts.keepaliveMs && opts.keepaliveMs > 0) {
        keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
          } catch {
            feed.close();
            if (keepalive) clearInterval(keepalive);
          }
        }, opts.keepaliveMs);
      }
      void (async () => {
        try {
          for await (const event of feed) {
            controller.enqueue(encodeSseMemoryEvent(event));
          }
        } catch {
          // Closed/errored clients are simply disconnected. Authority commits
          // remain independent of this transport path.
        } finally {
          if (keepalive) clearInterval(keepalive);
          try { controller.close(); } catch { /* already cancelled */ }
          feed.close();
        }
      })();
    },
    cancel() {
      if (keepalive) clearInterval(keepalive);
      feed.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
    },
  });
}

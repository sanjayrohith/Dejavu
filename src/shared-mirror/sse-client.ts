import type { SharedEventsResponse, SharedMemoryEvent } from "../shared-contract.ts";
import type { SubscribeFn, Unsubscribe } from "./connection.ts";
import type { FetchEventsFn } from "./types.ts";

export interface StreamLifecycleEvent {
  kind: "expires" | "closed";
  reason?: string;
  ttlSeconds?: number;
  expiresAt?: string;
}

export interface SharedHttpTransportOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  eventsPath?: string;
  streamPath?: string;
  /**
   * Notified when the server announces a bounded stream lifetime (`expires`)
   * or closes the stream (`closed`). Callers typically schedule a reconnect.
   */
  onLifecycle?: (event: StreamLifecycleEvent) => void;
}

interface SseFrame {
  event: string;
  data: string;
}

/** Parse complete SSE frames from a text buffer, retaining an incomplete tail. */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; remainder: string } {
  const frames: SseFrame[] = [];
  let cursor = 0;
  for (;;) {
    const end = buffer.indexOf("\n\n", cursor);
    if (end < 0) break;
    const block = buffer.slice(cursor, end);
    cursor = end + 2;
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length > 0) frames.push({ event, data: data.join("\n") });
  }
  return { frames, remainder: buffer.slice(cursor) };
}

/**
 * Concrete fetch/SSE transport to plug into SharedConnection.
 * Reconnect policy remains with SharedConnection/caller; this transport owns
 * one stream attempt and aborts cleanly on unsubscribe.
 */
export function createSharedHttpTransport(opts: SharedHttpTransportOptions): {
  fetchEvents: FetchEventsFn;
  subscribe: SubscribeFn;
} {
  const runFetch = opts.fetch ?? globalThis.fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  const eventsPath = opts.eventsPath ?? "/v1/shared/events";
  const streamPath = opts.streamPath ?? "/v1/shared/stream";

  const fetchEvents: FetchEventsFn = async (since, limit) => {
    const response = await runFetch(
      `${base}${eventsPath}?since=${encodeURIComponent(since)}&limit=${encodeURIComponent(limit)}`,
    );
    if (!response.ok) throw new Error(`shared events fetch failed: HTTP ${response.status}`);
    return await response.json() as SharedEventsResponse;
  };

  const subscribe: SubscribeFn = async (listener, since) => {
    const controller = new AbortController();
    const response = await runFetch(
      `${base}${streamPath}?since=${encodeURIComponent(since)}`,
      { signal: controller.signal },
    );
    if (!response.ok || !response.body) {
      controller.abort();
      throw new Error(`shared stream connect failed: HTTP ${response.status}`);
    }

    void (async () => {
      const decoder = new TextDecoder();
      const reader = response.body!.getReader();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          const parsed = parseSseFrames(buffer);
          buffer = parsed.remainder;
          for (const frame of parsed.frames) {
            if (frame.event === "memory") {
              listener(JSON.parse(frame.data) as SharedMemoryEvent);
              continue;
            }
            if (frame.event === "expires" || frame.event === "closed") {
              if (opts.onLifecycle) {
                try {
                  const parsedFrame = frame.data ? JSON.parse(frame.data) as { reason?: string; ttlSeconds?: number; expiresAt?: string } : {};
                  opts.onLifecycle({
                    kind: frame.event,
                    reason: parsedFrame.reason,
                    ttlSeconds: parsedFrame.ttlSeconds,
                    expiresAt: parsedFrame.expiresAt,
                  });
                } catch {
                  // Best-effort: malformed lifecycle JSON should not break
                  // the data path.
                }
              }
              continue;
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          // The connection manager will observe stale status/call reconnect;
          // stream transport cannot invent an ordered repair itself.
          console.warn("shared stream ended", error);
        }
      }
    })();

    const unsubscribe: Unsubscribe = () => controller.abort();
    return unsubscribe;
  };

  return { fetchEvents, subscribe };
}

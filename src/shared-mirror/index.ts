/**
 * Slice B — local mirror.
 *
 * Public surface for the shared-memory local mirror. See
 * docs/shared-memory-implementation-contract.md for the seam this
 * implements.
 */

export { LocalMirror } from "./mirror.ts";
export type { MirrorOptions } from "./mirror.ts";
export { SharedConnection } from "./connection.ts";
export { createSharedHttpTransport, parseSseFrames } from "./sse-client.ts";
export type { SharedHttpTransportOptions, StreamLifecycleEvent } from "./sse-client.ts";
export type {
  ConnectionSnapshot,
  ConnectionStatus,
  FetchStatusFn,
  SharedConnectionOptions,
  SubscribeFn,
  Unsubscribe,
} from "./connection.ts";
export type {
  ApplyResult,
  CatchUpResult,
  FetchEventsFn,
  FreshnessReport,
  LocalRecallHit,
  LocalRecallQuery,
  LocalRecallResult,
  SharedLocalHandoff,
  SharedAuthorityStatus,
  SharedEventsResponse,
  SharedMemoryEvent,
  SharedMemoryEventType,
  SharedRememberPayload,
  SharedWriteReceipt,
} from "./types.ts";

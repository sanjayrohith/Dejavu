/**
 * Slice A — shared-memory authority/protocol core.
 *
 * See docs/shared-memory-implementation-contract.md.
 */

export { SharedAuthority } from "./authority.ts";
export type { SharedAuthorityOptions } from "./authority.ts";
export {
  createHandlers,
  handleAuthorityRequest,
} from "./handlers.ts";
export type { AuthorityFunctionApi } from "./handlers.ts";
export { AsyncEventFeed } from "./feed.ts";
export type { AsyncEventFeedOptions, FeedOverflowPolicy, FeedStats } from "./feed.ts";
export { LiveFeed, openLiveFeed } from "./subscription.ts";
export type { LiveFeedOptions, LiveFeedStats } from "./subscription.ts";
export { createSseResponse, encodeSseMemoryEvent } from "./sse.ts";
export type { SseStreamOptions } from "./sse.ts";
export type {
  RememberWriteInput,
  SharedAuthorityStatus,
  SharedEventListener,
  SharedEventsResponse,
  SharedMemoryEvent,
  SharedMemoryEventType,
  SharedRememberPayload,
  SharedWriteReceipt,
} from "./types.ts";

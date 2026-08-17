/**
 * Core types for dejavu.
 *
 * A slip is an atomic, immutable note authored by an agent.
 * State machine: draft -> kept -> expired (or draft -> expired via 24h GC).
 * Contradictions never mutate; they become new slips that link to the old.
 */

export type SlipState = "draft" | "kept" | "expired";

export type Trust = "high" | "medium" | "low";

/** Agent-native memory classes. `note` is the safe fallback. */
export type MemoryKind =
  | "decision"
  | "preference"
  | "procedure"
  | "pitfall"
  | "fact"
  | "wip"
  | "note";

export interface Slip {
  /** ULID — sortable, time-prefixed. */
  id: string;
  /** Session ULID this slip was authored in. */
  sessionId: string;
  /** Free-form agent identity. e.g. "claude-opus-4-7", "opencode/anomalyco". */
  authoredBy: string;
  /** Automatic retrieval boundary, normally derived from the git repository. */
  scope: string;
  /** Stable class used for filtering and compact context packets. */
  kind: MemoryKind;
  /** The note itself. Plain text. Markdown allowed but not rendered by dejavu. */
  text: string;
  /** Tags — agent-chosen, free-form. */
  tags: string[];
  /** Lifecycle state. */
  state: SlipState;
  /** ms since epoch. */
  createdAt: number;
  /** ms since epoch. Set when state -> kept. */
  keptAt: number | null;
  /** ms since epoch. Set when state -> expired (manual forget or GC). */
  expiredAt: number | null;
  /** Free-form provenance trail — usage signals. */
  usedCount: number;
  wrongCount: number;
}

export type LinkKind =
  /** New slip supersedes old. Old is not auto-expired; reader sees both. */
  | "supersedes"
  /** New slip explicitly contradicts old. */
  | "contradicts"
  /** Soft "see also". */
  | "related";

export interface Link {
  fromId: string;
  toId: string;
  kind: LinkKind;
  createdAt: number;
}

export type HandoffStatus = "active" | "completed" | "abandoned";

export interface Handoff {
  /** ULID. One handoff per session, enforced. */
  id: string;
  sessionId: string;
  authoredBy: string;
  /** Automatic retrieval boundary, normally derived from the git repository. */
  scope: string;
  /** What happened, in the agent's voice. */
  summary: string;
  /** Slip ids that were promoted to kept as part of this handoff. */
  kept: string[];
  /** Optional: things the next agent should do or know first. */
  next: string[];
  status: HandoffStatus;
  /** Auto-rollups may be replaced once by the session's explicit final handoff. */
  automatic: boolean;
  createdAt: number;
  resolvedAt: number | null;
}

/**
 * How an anchored memory relates to the code it was written about.
 *
 * Wall-clock age is a proxy for staleness; this is the real signal. A
 * pitfall about a function is suspect the moment that function changes,
 * whether it changed an hour ago or a year ago.
 */
export type AnchorStatus =
  /** The anchored file is byte-identical to what it was at capture time. */
  | "verified"
  /** The anchored file still exists, but its contents changed. */
  | "drifted"
  /** The anchored path no longer exists. */
  | "orphaned"
  /** Could not be checked (outside a checkout, unreadable, or too large). */
  | "unknown";

/** A parsed `path[:line][#symbol]` anchor request, before capture. */
export interface AnchorSpec {
  /** Repository-relative POSIX path. */
  path: string;
  /** 1-based line, if the author pointed at one. */
  line: number | null;
  /** Symbol name, if the author named one. */
  symbol: string | null;
}

/**
 * An immutable pointer from a slip to the code it describes.
 *
 * `blobSha` is a real git blob object id (sha1 over `blob <len>\0<bytes>`),
 * so it is comparable with `git hash-object` and stable across checkouts.
 * Like slips, anchors are written once and never edited.
 */
export interface Anchor extends AnchorSpec {
  slipId: string;
  /** git blob id of the file contents at capture time. */
  blobSha: string;
  /** HEAD commit at capture time, when it could be read. */
  commit: string | null;
  createdAt: number;
}

/** An anchor plus the verdict from checking it against the working tree. */
export interface AnchorState {
  anchor: Anchor;
  status: AnchorStatus;
  /** Short, agent-readable reason for the status. */
  detail: string;
}

export interface RecallHit {
  slip: Slip;
  /** Raw FTS5 BM25 score, lower is better. */
  score: number;
  /** Bucketed for the agent: high / medium / low. */
  trust: Trust;
  /** Checked anchors, when this slip has any. Absent for unanchored slips. */
  anchors?: AnchorState[];
  /** Worst anchor status across `anchors`. Null when the slip is unanchored. */
  drift?: AnchorStatus | null;
}

export type NextAgentRead = "first" | "maybe" | "skip";
export type NextAgentReason =
  | "query_match"
  | "explicit_preference"
  | "decision"
  | "security_invariant"
  | "incident"
  | "current_wip"
  | "finding"
  | "requirement"
  | "release_gate";
export type NextAgentPenalty = "stale_plan" | "stale_assumption" | "random_note" | "routine_note" | "duplicate";

export interface NextAgentHint {
  read: NextAgentRead;
  score: number;
  reasons: NextAgentReason[];
  penalties: NextAgentPenalty[];
}

export interface NextAgentHit extends RecallHit {
  nextAgent: NextAgentHint;
}

export interface RecallOptions {
  limit?: number;
  /** Approximate output budget. Retrieval stops before exceeding it. */
  maxTokens?: number;
  kinds?: MemoryKind[];
  /** Override the instance default for checking anchored slips for drift. */
  checkAnchorDrift?: boolean;
}

export interface RecallResult {
  query: string;
  /** Content-free receipt id for evaluating this retrieval later. */
  traceId: string | null;
  hits: NextAgentHit[];
  /** Query-relevant slips worth reading first, with auditable reasons. */
  readFirst: NextAgentHit[];
  /** Active handoff for the current session, if any. */
  activeHandoff: Handoff | null;
}

export interface OrientationOptions {
  /** Approximate output budget, shared across the handoff and every section. */
  maxTokens?: number;
  /** Max hits across all sections combined. */
  limit?: number;
  /**
   * Use these repository-relative paths instead of reading the working
   * tree. Pass `[]` to compose a packet with no hazard section at all.
   */
  paths?: string[];
  /** Branch to report, when the caller already knows it. */
  branch?: string | null;
  /** Override the instance default for checking anchored slips for drift. */
  checkAnchorDrift?: boolean;
}

/**
 * The packet a session opens with.
 *
 * Three sections in the order a fresh agent needs them, rather than one
 * flat list ordered by recency:
 *
 * - `hazards` — memory about the code this session is *already* changing.
 * - `activeWork` — what is open in this repository.
 * - `mustKnow` — the durable decisions and preferences that generic best
 *   practice would get wrong.
 */
export interface OrientationPacket {
  /** Content-free receipt id covering the whole packet. */
  traceId: string | null;
  /** Current branch, when the checkout has one. */
  branch: string | null;
  /** Changed paths the hazard section was built from. */
  paths: string[];
  /** True when the working tree could not be read, as opposed to being clean. */
  worktreeUnavailable: boolean;
  /** True when the diff was longer than the path cap. */
  pathsTruncated: boolean;
  activeHandoff: Handoff | null;
  /** Memory anchored to the changed files, most suspect first. */
  hazards: NextAgentHit[];
  /** Open work in this repository scope. */
  activeWork: NextAgentHit[];
  /** Durable decisions, preferences, pitfalls, and procedures, by trust. */
  mustKnow: NextAgentHit[];
}

/** Result of a reverse lookup: memory anchored to a set of files. */
export interface TouchingResult {
  /** The repository-relative paths that were looked up. */
  paths: string[];
  /** Content-free receipt id, same contract as `recall`. */
  traceId: string | null;
  hits: RecallHit[];
}

/** Retrieval receipt without duplicated memory text, used for real behavior evals. */
export type RecallAssessment = "useful" | "wrong" | "missed" | "no_memory_needed";

export interface RecallTrace {
  id: string;
  sessionId: string;
  authoredBy: string;
  scope: string;
  query: string;
  hitIds: string[];
  handoffId: string | null;
  createdAt: number;
  assessment: RecallAssessment | null;
  assessedAt: number | null;
  note: string | null;
}

export interface RememberOpts {
  tags?: string[];
  /** Explicit memory class. If omitted, Dejavu applies a conservative local heuristic. */
  kind?: MemoryKind;
  /** If set, this slip explicitly links to one or more existing slips. */
  links?: Array<{ toId: string; kind: LinkKind }>;
  /**
   * Code this memory is about, as `path[:line][#symbol]` strings or parsed
   * specs. Anchored memory reports drift when the code moves underneath it.
   * Paths are resolved against the repository root and must exist.
   */
  anchors?: Array<string | AnchorSpec>;
  /** Override session id. Default: derived from env / cwd / process. */
  sessionId?: string;
  /** Override author. Default: env DEJAVU_AUTHOR or "unknown-agent". */
  authoredBy?: string;
  /** Override automatic repository scope. Use `global` only deliberately. */
  scope?: string;
}

export interface HandoffInput {
  summary: string;
  next?: string[];
  /** Override session / author / automatic repository scope. */
  sessionId?: string;
  authoredBy?: string;
  scope?: string;
  /** New handoffs start active. */
  status?: HandoffStatus;
  /** Internal: marks a chain-shaped auto-rollup. */
  automatic?: boolean;
}

export type MessageState = "pending" | "read" | "archived";

export interface AgentMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  body: string;
  state: MessageState;
  createdAt: number;
  readAt: number | null;
  delivery?: {
    transport: "pi-turn-trigger";
    ok: boolean;
    path?: string;
    reason?: string;
  };
}

export interface SendInput {
  to: string;
  body: string;
  threadId?: string;
  from?: string;
}

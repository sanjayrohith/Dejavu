/**
 * dejavu — local-first agent memory.
 *
 * Four verbs:
 *   recall(query)              — find relevant slips, plus active handoff
 *   remember(text, opts?)      — jot a draft slip
 *   keep(ids)                  — promote drafts to kept (survives GC)
 *   handoff({summary, next?})  — close the session with a note for the next agent
 *
 * Three signals:
 *   forget(id)                 — expire a slip, regardless of state
 *   used(id)                   — record that a recalled slip was helpful
 *   wrong(id)                  — record that a recalled slip was misleading
 *
 * Agents jot for the next agent.
 */

import { Storage, defaultDbPath, type StorageOptions } from "./storage.ts";
import {
  currentAuthor,
  draftCutoff,
  isChainShaped,
  trustForSlip,
  inferMemoryKind,
} from "./lifecycle.ts";
import { ulid } from "./ulid.ts";
import { deliverPiTurn } from "./pi-turn.ts";
import { rankForNextAgent } from "./next-agent.ts";
import { currentMemoryContext, type MemoryContext } from "./context.ts";
import { resolveSessionId } from "./session.ts";
import {
  anchorRoot,
  blobShaOf,
  captureAnchors,
  checkAnchor,
  checkAnchors,
  driftIsSuspect,
  relativeAnchorPath,
  rollupDrift,
} from "./anchors.ts";
import { readWorktree } from "./worktree.ts";
import type {
  Anchor,
  AnchorState,
  MemoryKind,
  OrientationOptions,
  OrientationPacket,
  Slip,
  Handoff,
  HandoffInput,
  RecallResult,
  RememberOpts,
  Trust,
  AgentMessage,
  SendInput,
  RecallOptions,
  RecallAssessment,
  HandoffStatus,
  LinkKind,
  NextAgentHit,
  TouchingResult,
} from "./types.ts";

export type {
  Slip,
  Handoff,
  HandoffInput,
  RecallResult,
  RememberOpts,
  Trust,
  AgentMessage,
  SendInput,
  MessageState,
  RecallTrace,
  RecallOptions,
  RecallAssessment,
  HandoffStatus,
  LinkKind,
  MemoryKind,
} from "./types.ts";

export { defaultDbPath } from "./storage.ts";
export { VERSION } from "./version.ts";
export {
  anchorRoot,
  captureAnchor,
  captureAnchors,
  checkAnchor,
  checkAnchors,
  driftIsSuspect,
  gitBlobSha,
  parseAnchorSpec,
  relativeAnchorPath,
  rollupDrift,
} from "./anchors.ts";
export type {
  Anchor,
  AnchorSpec,
  AnchorState,
  AnchorStatus,
  OrientationOptions,
  OrientationPacket,
  TouchingResult,
} from "./types.ts";
export {
  changedPaths,
  currentBranch,
  readWorktree,
  DIFF_TIMEOUT_MS,
  MAX_DIFF_PATHS,
} from "./worktree.ts";
export type { WorktreeState } from "./worktree.ts";
export { SharedDejavu } from "./shared-client/index.ts";
export type { SharedDejavuOptions, SharedRememberOptions, SharedHandoffOptions } from "./shared-client/index.ts";
export type {
  SharedMemoryEvent,
  SharedDeletePayload,
  SharedHandoffPayload,
  SharedPurgedRememberPayload,
  SharedRememberPayload,
  SharedSignalAction,
  SharedSignalPayload,
  SharedWriteReceipt,
  SharedAuthorityStatus,
  SharedEventsResponse,
} from "./shared-contract.ts";

export interface DejavuOptions extends StorageOptions {
  /** Override automatic repository scope. Defaults to DEJAVU_SCOPE or current git repository. */
  scope?: string;
  /** Include pre-scope rows imported as legacy:global. Default: false. */
  includeLegacy?: boolean;
  /** Experimental reasons/penalties ranker. Off until real-session evals pass. */
  experimentalNextAgentRanking?: boolean;
  /** Record query + returned ids (never memory text) for real recall evals. Default: true. */
  recordRecallTraces?: boolean;
  /** Skip auto-GC of expired drafts on init. Default: false. */
  skipGc?: boolean;
  /**
   * Force the session id for this instance, bypassing DEJAVU_SESSION and
   * any harness pointer. Mostly for tests and for hook commands that were
   * handed a session id by the harness itself.
   */
  sessionId?: string;
  /**
   * Directory that code anchors resolve against. Defaults to the nearest
   * checkout root, falling back to the current directory. Tests and
   * harnesses override it to point at a fixture tree.
   */
  anchorRoot?: string;
  /**
   * Check anchored slips for drift during recall. Default: true.
   *
   * The check is one indexed query plus a hash of each distinct anchored
   * file in the packet, and it is skipped entirely when no hit is
   * anchored — so an unanchored database pays a single empty query.
   */
  checkAnchorDrift?: boolean;
  /**
   * Disable auto-rollup of chain-shaped kept slips into a session handoff.
   *
   * Default: false (auto-rollup ENABLED). When a slip is chain-shaped
   * (looks like a decision/preference/wip note) and gets promoted to kept,
   * dejavu will write a session handoff if one doesn't already exist. This
   * makes the slip discoverable on every `recall()` regardless of query —
   * slips need a matching query, handoffs are surfaced unconditionally.
   *
   * Set to true if you want strict separation between `keep` and `handoff`
   * — useful for tests or for callers managing the handoff lifecycle
   * manually.
   */
  noChainRollup?: boolean;
}

export interface KeepOptions {
  /** Override the auto-rollup decision for this call. */
  noChainRollup?: boolean;
}

export class Dejavu {
  readonly storage: Storage;
  readonly options: DejavuOptions;
  readonly context: MemoryContext;
  readonly scope: string;
  /**
   * Directory anchor paths are resolved against.
   *
   * Deliberately the checkout root rather than `context.root`: an explicit
   * DEJAVU_SCOPE changes which memories are visible, not what
   * `src/auth.ts` refers to.
   */
  readonly anchorRoot: string;
  /**
   * The session everything this instance writes belongs to.
   *
   * Resolved once, at construction: DEJAVU_SESSION, then a harness
   * pointer claimed for this scope, then the per-process id. Held on the
   * instance so a long-lived MCP server does not start straddling two
   * sessions if a hook re-claims the scope mid-conversation.
   */
  readonly sessionId: string;

  constructor(opts: DejavuOptions = {}) {
    this.storage = new Storage(opts);
    this.options = {
      ...opts,
      includeLegacy: opts.includeLegacy ?? process.env.DEJAVU_INCLUDE_LEGACY === "1",
    };
    const derived = currentMemoryContext();
    this.context = opts.scope ? { ...derived, scope: opts.scope, source: "env" } : derived;
    this.scope = this.context.scope;
    this.anchorRoot = opts.anchorRoot ?? anchorRoot();
    this.sessionId = opts.sessionId ?? resolveSessionId(this.scope, { dbPath: this.storage.path });
    if (!opts.skipGc) this.gc();
  }

  close(): void {
    this.storage.close();
  }

  /** Expire drafts older than 24h. Returns count expired. Idempotent. */
  gc(now: number = Date.now()): number {
    return this.storage.gcDrafts(draftCutoff(now), now);
  }

  // ---------- four verbs ----------

  /**
   * Recall slips relevant to `query`. Returns ranked hits + the active
   * handoff for the current session (if any).
   */
  recall(query: string, limitOrOptions: number | RecallOptions = 8): RecallResult {
    const options: RecallOptions = typeof limitOrOptions === "number"
      ? { limit: limitOrOptions }
      : limitOrOptions;
    const limit = options.limit ?? 8;
    const sessionId = this.sessionId;
    const asOf = options.asOf ?? null;
    const raw = query.trim()
      ? this.storage.searchFts(
          query,
          Math.max(limit, limit * 2),
          this.scope,
          this.options.includeLegacy,
          options.kinds,
          asOf,
        )
      : this.storage
          .listKept(Math.max(limit, limit * 2), this.scope, this.options.includeLegacy, options.kinds, asOf)
          .map((slip) => ({ slip, score: 0 }));
    const seen = new Set<string>();
    const hits = raw.flatMap((candidate) => {
      const slip = this.storage.activeSuperseder(candidate.slip.id, this.scope, asOf) ?? candidate.slip;
      if (seen.has(slip.id)) return [];
      seen.add(slip.id);
      return [{ slip, score: candidate.score, trust: trustForSlip(slip) }];
    });
    // Surface this session's active handoff if it exists, otherwise fall
    // back to the most recent active handoff in this repository scope.
    const activeHandoff =
      this.storage.getActiveHandoffBySession(sessionId, this.scope, asOf) ??
      this.storage.latestHandoffs(1, this.scope, this.options.includeLegacy, asOf)[0] ??
      null;
    let result: RecallResult;
    if (this.options.experimentalNextAgentRanking) {
      const ranked = rankForNextAgent(query, hits);
      result = { query, traceId: "", hits: ranked.hits, readFirst: ranked.readFirst, activeHandoff };
    } else {
      const unranked = hits.map((hit) => ({
        ...hit,
        nextAgent: { read: "skip" as const, score: 0, reasons: [], penalties: [] },
      }));
      result = { query, traceId: "", hits: unranked, readFirst: [], activeHandoff };
    }
    result.hits = fitRecallBudget(result.hits, options.maxTokens ?? 1200).slice(0, limit);
    // Drift is checked after budgeting so we only hash files for memory the
    // agent will actually see.
    this.labelDrift(result.hits, options.checkAnchorDrift ?? (asOf === null ? undefined : false));
    result.readFirst = result.readFirst.filter((hit) =>
      result.hits.some((candidate) => candidate.slip.id === hit.slip.id)
    );
    result.traceId = asOf === null
      ? this.recordRecallTrace(
          result.query,
          result.hits.map((hit) => hit.slip.id),
          result.activeHandoff?.id ?? null,
        )
      : null;
    return result;
  }

  /**
   * Reverse lookup: what memory is anchored to these files?
   *
   * The complement of `recall`. Recall answers "what do I know about this
   * phrase"; touching answers "what do I know about the code I am about
   * to change" — a question an agent can ask before it has any idea what
   * words to search for. Pass the paths of a diff, a file you are about
   * to edit, or a directory's worth of files.
   *
   * Paths may be absolute or repository-relative; anything outside the
   * repository is ignored. Results carry drift, since a memory about a
   * file you are already editing is exactly the one most likely to be
   * stale.
   */
  touching(
    paths: string[],
    opts: { limit?: number; checkAnchorDrift?: boolean; asOf?: number | null } = {},
  ): TouchingResult {
    const limit = opts.limit ?? 20;
    const asOf = opts.asOf ?? null;
    const normalized = this.normalizeAnchorPaths(paths);
    const hits = this.anchoredHits(normalized, limit, asOf);
    this.labelDrift(hits, opts.checkAnchorDrift ?? (asOf === null ? undefined : false));

    return {
      paths: normalized,
      // Reverse lookup is retrieval, so it leaves the same content-free
      // receipt and shows up in the same quality report.
      traceId: asOf === null
        ? this.recordRecallTrace(
            `touching:${normalized.join(" ")}`,
            hits.map((hit) => hit.slip.id),
            null,
          )
        : null,
      hits,
    };
  }

  /** Repository-relative, de-duplicated; anything outside the root is dropped. */
  private normalizeAnchorPaths(paths: string[]): string[] {
    const normalized: string[] = [];
    for (const raw of paths) {
      const relative = relativeAnchorPath(this.anchorRoot, raw.trim());
      if (relative && !normalized.includes(relative)) normalized.push(relative);
    }
    return normalized;
  }

  /** Non-expired slips anchored to `paths`, resolved to current truth. Undrifted. */
  private anchoredHits(paths: string[], limit: number, asOf: number | null = null): NextAgentHit[] {
    if (paths.length === 0 || limit <= 0) return [];
    const slips = this.storage.slipsAnchoredTo(
      paths,
      this.scope,
      this.options.includeLegacy,
      limit,
      asOf,
    );
    const seen = new Set<string>();
    const hits: NextAgentHit[] = [];
    for (const candidate of slips) {
      const slip = this.storage.activeSuperseder(candidate.id, this.scope, asOf) ?? candidate;
      if (seen.has(slip.id)) continue;
      seen.add(slip.id);
      hits.push({
        slip,
        score: 0,
        trust: trustForSlip(slip),
        nextAgent: { read: "skip", score: 0, reasons: [], penalties: [] },
      });
    }
    return hits;
  }

  /**
   * Compose the packet a session should open with.
   *
   * `recall("")` answers "what happened recently", which is a reasonable
   * thing to ask and a poor way to start a session. It orders by
   * `kept_at`, so after one hooked session — where a checkpoint promotes
   * every draft at once — the whole packet is that session's leftovers,
   * and orientation gets worse precisely as the database gets richer.
   *
   * This asks a better question. The checkout already says what the
   * session is about: the branch it is on and the files changed in it.
   * Memory anchored to those files is the part most likely to matter and
   * most likely to be stale, so it leads. Then open work, then the
   * durable decisions and preferences a fresh agent would otherwise
   * replace with generic best practice.
   *
   * Everything here is deterministic and local. No model call, and no
   * transcript is read. Outside a checkout — or when git cannot be run —
   * the hazard section is simply empty and the rest of the packet still
   * beats a recency list.
   */
  orientation(opts: OrientationOptions = {}): OrientationPacket {
    const limit = opts.limit ?? 8;
    const maxTokens = opts.maxTokens ?? 700;
    const asOf = opts.asOf ?? null;

    // The caller may already know the tree (a hook that read it, a test
    // pinning a fixture). Otherwise read it, cheaply and forgivingly —
    // except when composing as of a past instant, where today's tree
    // would be an answer to a question nobody asked.
    const tree = opts.paths !== undefined
      ? { branch: opts.branch ?? null, changed: opts.paths, truncated: false, unavailable: false }
      : asOf !== null
        ? { branch: opts.branch ?? null, changed: [], truncated: false, unavailable: true }
        : readWorktree(this.anchorRoot);
    const paths = this.normalizeAnchorPaths(tree.changed);

    const activeHandoff =
      this.storage.getActiveHandoffBySession(this.sessionId, this.scope, asOf) ??
      this.storage.latestHandoffs(1, this.scope, this.options.includeLegacy, asOf)[0] ??
      null;

    const budget = new PacketBudget(maxTokens, limit);
    // The handoff is surfaced unconditionally, so it is spent from the
    // same allowance rather than smuggled in beside it.
    if (activeHandoff) {
      budget.charge(activeHandoff.summary + activeHandoff.next.join(" "));
    }

    // Hazards are drift-labelled before budgeting so the suspect ones win
    // the space. That hashes a few files that may then be dropped; the
    // set is bounded by the diff, and getting this order right is the
    // whole point of the section.
    const anchored = this.anchoredHits(paths, limit, asOf);
    const drift = opts.checkAnchorDrift ?? (asOf === null ? undefined : false);
    this.labelDrift(anchored, drift);
    const hazards = budget.take([
      ...anchored.filter((hit) => driftIsSuspect(hit.drift)),
      ...anchored.filter((hit) => !driftIsSuspect(hit.drift)),
    ]);

    const claimed = new Set(hazards.map((hit) => hit.slip.id));
    const section = (kinds: MemoryKind[]): NextAgentHit[] => {
      const taken = budget.take(
        this.storage
          .listKeptByTrust(kinds, limit, this.scope, this.options.includeLegacy, [...claimed], asOf)
          .map((slip) => ({
            slip,
            score: 0,
            trust: trustForSlip(slip),
            nextAgent: { read: "skip" as const, score: 0, reasons: [], penalties: [] },
          })),
      );
      for (const hit of taken) claimed.add(hit.slip.id);
      return taken;
    };

    const activeWork = section(["wip"]);
    const mustKnow = section(["decision", "preference", "pitfall", "procedure"]);
    // No kind filter: whatever the typed sections did not claim. Kind
    // inference is conservative, so most un-kinded memory is a `note` —
    // dropping it would make this packet worse than the recency list it
    // replaces for anyone whose agent never sets `kind`.
    const other = section([]);

    // These sections come from kind and trust rather than from the diff,
    // but a decision embodied in a config file is anchored too, and a
    // fresh agent deserves to know its code moved.
    this.labelDrift([...activeWork, ...mustKnow, ...other], drift);

    return {
      traceId: asOf === null
        ? this.recordRecallTrace(
            `orientation:${tree.branch ?? "-"} ${paths.join(" ")}`.trim(),
            [...hazards, ...activeWork, ...mustKnow, ...other].map((hit) => hit.slip.id),
            activeHandoff?.id ?? null,
          )
        : null,
      branch: tree.branch,
      paths,
      worktreeUnavailable: tree.unavailable,
      pathsTruncated: tree.truncated,
      activeHandoff,
      hazards,
      activeWork,
      mustKnow,
      other,
    };
  }

  /**
   * Jot a new draft slip. Returns the slip.
   * Drafts auto-expire after 24h unless promoted via keep().
   *
   * `opts.anchors` points the memory at the code it is about, as
   * `path[:line][#symbol]` strings. Anchors are captured *before* the slip
   * is written, so a bad path throws without leaving a half-written
   * memory behind.
   */
  remember(text: string, opts: RememberOpts = {}): Slip {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("dejavu.remember: text is empty");

    const now = Date.now();
    const id = ulid(now);
    const anchors = captureAnchors(opts.anchors ?? [], {
      slipId: id,
      root: this.anchorRoot,
      createdAt: now,
    });

    const slip: Slip = {
      id,
      sessionId: opts.sessionId ?? this.sessionId,
      authoredBy: opts.authoredBy ?? currentAuthor(),
      scope: opts.scope ?? this.scope,
      kind: opts.kind ?? inferMemoryKind(trimmed, opts.tags),
      text: trimmed,
      tags: opts.tags ?? [],
      state: "draft",
      createdAt: now,
      keptAt: null,
      expiredAt: null,
      usedCount: 0,
      wrongCount: 0,
    };
    this.storage.insertSlip(slip);
    for (const anchor of anchors) this.storage.insertAnchor(anchor);

    if (opts.links) {
      for (const link of opts.links) {
        this.storage.insertLink({
          fromId: slip.id,
          toId: link.toId,
          kind: link.kind,
          createdAt: now,
        });
      }
    }
    return slip;
  }

  /**
   * Promote draft slips to kept. Returns the slips that were actually
   * promoted (drafts only; already-kept ids are skipped silently).
   *
   * If any of the promoted slips are "chain-shaped" (look like a decision,
   * preference, or wip note) and the current session has no handoff yet,
   * dejavu will auto-write a handoff that mentions them. This makes the
   * decision discoverable on every recall regardless of query. Disable
   * with `{ noChainRollup: true }` or via the `DejavuOptions.noChainRollup`
   * constructor flag.
   */
  keep(ids: string[], opts: KeepOptions = {}): Slip[] {
    const now = Date.now();
    const promoted: Slip[] = [];
    for (const id of ids) {
      const s = this.storage.getSlip(id);
      if (!s) continue;
      if (s.state !== "draft") continue;
      this.storage.setState(id, "kept", now);
      promoted.push({ ...s, state: "kept", keptAt: now });
    }

    const skipRollup = opts.noChainRollup ?? this.options.noChainRollup ?? false;
    if (!skipRollup) this.maybeRollupHandoff(promoted);

    return promoted;
  }

  /**
   * If the slip set contains chain-shaped content and the current session
   * has no handoff, write one that surfaces these slips to the next agent.
   * Silent no-op otherwise. See {@link KeepOptions.noChainRollup} to disable.
   */
  private maybeRollupHandoff(slips: Slip[]): void {
    const chainSlips = slips.filter((s) => isChainShaped(s.text, s.tags));
    if (chainSlips.length === 0) return;

    // Only roll up for slips authored in the current session — don't
    // hijack another session's handoff slot.
    const sessionId = this.sessionId;
    const ours = chainSlips.filter((s) => s.sessionId === sessionId && s.scope === this.scope);
    if (ours.length === 0) return;

    if (this.storage.getHandoffBySession(sessionId, this.scope)) return;

    // Synthesize a summary from the chain-shaped slips. Keep it short;
    // the full text is in the kept slips themselves.
    const summary = ours
      .map((s) => `[${s.id.slice(0, 8)}] ${s.text}`)
      .join("\n\n")
      .slice(0, 1200);

    try {
      this.handoff({ summary, automatic: true });
    } catch {
      // Race or other handoff conflict — drop the rollup. Slips are
      // still kept, so no data loss.
    }
  }

  /**
   * Close the current session with a handoff. One per session, enforced.
   * Any drafts referenced in `kept` are auto-promoted.
   */
  handoff(input: HandoffInput): Handoff {
    const summary = input.summary.trim();
    if (!summary) throw new Error("dejavu.handoff: summary is empty");

    const sessionId = input.sessionId ?? this.sessionId;
    const authoredBy = input.authoredBy ?? currentAuthor();

    const existing = this.storage.getHandoffBySession(sessionId, input.scope ?? this.scope);
    if (existing && (input.automatic || !existing.automatic)) {
      throw new Error(
        `dejavu.handoff: session ${sessionId} already has a handoff (${existing.id}). One handoff per session.`,
      );
    }

    // Promote everything kept-eligible in this session to kept,
    // collect the ids for the handoff packet.
    const scope = input.scope ?? this.scope;
    const sessionSlips = this.storage.listBySession(sessionId, scope);
    const now = Date.now();
    const keptIds: string[] = [];
    for (const s of sessionSlips) {
      if (s.state === "draft") {
        this.storage.setState(s.id, "kept", now);
        keptIds.push(s.id);
      } else if (s.state === "kept") {
        keptIds.push(s.id);
      }
    }

    const h: Handoff = {
      id: ulid(now),
      sessionId,
      authoredBy,
      scope,
      summary,
      kept: keptIds,
      next: input.next ?? [],
      status: input.status ?? "active",
      automatic: input.automatic ?? false,
      createdAt: now,
      resolvedAt: null,
    };
    if (existing?.automatic && !input.automatic) {
      this.storage.replaceAutomaticHandoff(existing.id, h);
    } else {
      this.storage.insertHandoff(h);
    }
    return h;
  }

  /**
   * Attach anchor drift to a set of hits, in place.
   *
   * One indexed query covers the whole packet; anchored files are hashed
   * at most once each. When nothing in the packet is anchored — the case
   * for every database written before anchors existed — this costs one
   * query that returns no rows, and no hit is annotated at all.
   */
  private labelDrift(hits: NextAgentHit[], override?: boolean): void {
    const enabled = override ?? this.options.checkAnchorDrift ?? true;
    if (!enabled || hits.length === 0) return;
    const bySlip = this.storage.anchorsForSlips(hits.map((hit) => hit.slip.id));
    if (bySlip.size === 0) return;

    const cache = new Map<string, ReturnType<typeof blobShaOf>>();
    for (const hit of hits) {
      const anchors = bySlip.get(hit.slip.id);
      if (!anchors || anchors.length === 0) continue;
      const states = anchors.map((anchor) => checkAnchor(anchor, this.anchorRoot, cache));
      hit.anchors = states;
      hit.drift = rollupDrift(states);
    }
  }

  /** Record query + ids, without duplicating memory text, for later evaluation. */
  recordRecallTrace(query: string, hitIds: string[], handoffId: string | null): string | null {
    if (this.options.recordRecallTraces === false) return null;
    const now = Date.now();
    const id = ulid(now);
    this.storage.recordRecall({
      id,
      sessionId: this.sessionId,
      authoredBy: currentAuthor(),
      scope: this.scope,
      query,
      hitIds,
      handoffId,
      createdAt: now,
      assessment: null,
      assessedAt: null,
      note: null,
    });
    return id;
  }

  assessRecall(traceId: string, assessment: RecallAssessment, note?: string): boolean {
    return this.storage.assessRecall(traceId, assessment, note?.trim() || null, Date.now());
  }

  recallReport() {
    return this.storage.recallReport(this.scope);
  }

  resolveHandoff(id: string, status: Exclude<HandoffStatus, "active"> = "completed"): boolean {
    return this.storage.resolveHandoff(id, status, Date.now());
  }

  link(fromId: string, toId: string, kind: LinkKind): boolean {
    const from = this.get(fromId);
    const to = this.get(toId);
    if (!from || !to) return false;
    if (from.scope !== this.scope || to.scope !== this.scope) return false;
    this.storage.insertLink({ fromId, toId, kind, createdAt: Date.now() });
    return true;
  }

  forgetSession(sessionId: string = this.sessionId): number {
    let count = 0;
    for (const slip of this.storage.listBySession(sessionId, this.scope)) {
      if (this.forget(slip.id)) count += 1;
    }
    return count;
  }

  // ---------- signals ----------

  /** Expire a slip regardless of state. Returns true if anything changed. */
  forget(id: string): boolean {
    const s = this.storage.getSlip(id);
    if (!s || s.state === "expired") return false;
    return this.storage.setState(id, "expired", Date.now());
  }

  /** Record that a recalled slip was helpful. */
  used(id: string): void {
    this.storage.bumpUsed(id);
  }

  /** Record that a recalled slip was misleading. */
  wrong(id: string): void {
    this.storage.bumpWrong(id);
  }

  // ---------- mailbox ----------

  send(input: SendInput): AgentMessage {
    const to = input.to.trim();
    const body = input.body.trim();
    if (!to) throw new Error("dejavu.send: to is empty");
    if (!body) throw new Error("dejavu.send: body is empty");
    const now = Date.now();
    const id = ulid(now);
    const msg: AgentMessage = {
      id,
      threadId: input.threadId ?? id,
      from: input.from ?? currentAuthor(),
      to,
      body,
      state: "pending",
      createdAt: now,
      readAt: null,
    };
    this.storage.insertMessage(msg);
    const delivery = deliverPiTurn(to, body);
    if (delivery.reason !== "not-pi-target") {
      msg.delivery = { transport: "pi-turn-trigger", ...delivery };
    }
    return msg;
  }

  inbox(to: string = currentAuthor(), opts: { limit?: number; includeRead?: boolean } = {}): AgentMessage[] {
    return this.storage.inbox(to, opts.limit ?? 20, opts.includeRead ?? false);
  }

  read(id: string): boolean {
    return this.storage.markMessage(id, "read", Date.now());
  }

  archive(id: string): boolean {
    return this.storage.markMessage(id, "archived", Date.now());
  }

  reply(id: string, body: string, from: string = currentAuthor()): AgentMessage {
    const row = this.storage.db
      .prepare(`SELECT thread_id, from_author FROM messages WHERE id = ?`)
      .get(id) as { thread_id: string; from_author: string } | null;
    if (!row) throw new Error(`dejavu.reply: message ${id} not found`);
    this.read(id);
    return this.send({ to: row.from_author, body, threadId: row.thread_id, from });
  }

  thread(threadId: string): AgentMessage[] {
    return this.storage.thread(threadId);
  }

  // ---------- introspection ----------

  get(id: string): Slip | null {
    return this.storage.getSlip(id);
  }

  /** Anchors recorded for a slip, as written. No drift check. */
  anchorsFor(id: string): Anchor[] {
    return this.storage.anchorsFor(id);
  }

  /** Anchors for a slip, each checked against the current working tree. */
  anchorStates(id: string): AnchorState[] {
    return checkAnchors(this.storage.anchorsFor(id), this.anchorRoot);
  }

  listSession(sessionId?: string): Slip[] {
    return this.storage.listBySession(sessionId ?? this.sessionId, this.scope);
  }

  listKept(limit: number = 50): Slip[] {
    return this.storage.listKept(limit, this.scope, this.options.includeLegacy);
  }

  latestHandoffs(limit: number = 5): Handoff[] {
    return this.storage.latestHandoffs(limit, this.scope, this.options.includeLegacy);
  }

  counts() {
    return this.storage.counts();
  }
}

/**
 * Approximate token cost of one rendered memory.
 *
 * Deliberately cheap and deterministic. English/code averages near four
 * characters per token; provenance/formatting receives a fixed allowance.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 42;
}

function fitRecallBudget<T extends { slip: Slip }>(hits: T[], maxTokens: number): T[] {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return [];
  const selected: T[] = [];
  let used = 0;
  for (const hit of hits) {
    const estimate = estimateTokens(hit.slip.text);
    if (selected.length > 0 && used + estimate > maxTokens) break;
    selected.push(hit);
    used += estimate;
  }
  return selected;
}

/**
 * A shared budget drawn down across several packet sections.
 *
 * `recall` fits one flat list, so a prefix scan is enough. An orientation
 * packet has sections in priority order and a handoff that must be paid
 * for out of the same allowance, so the remaining budget has to survive
 * from one section to the next.
 *
 * Nothing is force-included. If the handoff and the hazards consume the
 * whole budget, the later sections are genuinely empty — which is the
 * honest outcome, since those are the sections the caller ranked lowest.
 */
class PacketBudget {
  private tokens: number;
  private slots: number;

  constructor(maxTokens: number, maxHits: number) {
    this.tokens = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0;
    this.slots = Math.max(0, maxHits);
  }

  /** Charge for content that is not a hit, such as the active handoff. */
  charge(text: string): void {
    this.tokens -= estimateTokens(text);
  }

  /** Take as many hits as the remaining budget affords, in order. */
  take<T extends { slip: Slip }>(hits: T[]): T[] {
    const selected: T[] = [];
    for (const hit of hits) {
      if (this.slots <= 0) break;
      const estimate = estimateTokens(hit.slip.text);
      if (estimate > this.tokens) break;
      selected.push(hit);
      this.tokens -= estimate;
      this.slots -= 1;
    }
    return selected;
  }
}

/** Open a dejavu instance at the default path (~/.dejavu/dejavu.db). */
export function open(opts: DejavuOptions = {}): Dejavu {
  return new Dejavu(opts);
}

/** Convenience: open a transient in-memory dejavu. Useful for tests/sandboxes. */
export function memory(): Dejavu {
  return new Dejavu({ path: ":memory:", skipGc: true });
}

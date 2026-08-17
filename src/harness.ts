/**
 * Session lifecycle for coding-agent harnesses.
 *
 * Loop 4 recorded the failure this exists to address. A writer agent did
 * real work, was never told to remember it, and so never called remember;
 * the reader then re-derived the same fact from scratch, at a cost of
 * 22,911 tokens for one answer. The loop's own conclusion: "the chain only
 * works when the writer plays its part."
 *
 * Two fixes were tried and rejected. Prose nudges in tool responses failed
 * twice — the agent read "consider writing a handoff", declared the task
 * done, and ended its turn — producing the principle that *tool behaviour
 * is stronger than tool prose*. Auto-writing from inside unrelated tools
 * was rejected as parasitism.
 *
 * This is the third option: the harness does it. A session hook is not the
 * agent, so it cannot forget, cannot be distracted by task pressure, and
 * cannot decide the task is finished. Orientation happens at session
 * start whether or not the agent thinks to ask, and the session's work is
 * preserved before context is compacted or the session ends.
 *
 * Two boundaries this deliberately holds:
 *
 * - **No transcript reading.** Harnesses hand us `transcript_path`. Using
 *   it would make Dejavu a transcript archiver, which is an explicit
 *   project non-goal. We ignore it.
 * - **No model calls.** Everything here is deterministic bookkeeping over
 *   what the agent already wrote. A hook cannot summarise a session, and
 *   pretending otherwise would put an LLM call on the session-exit path,
 *   which has a 1.5-second budget in Claude Code.
 */

import type { Dejavu } from "./index.ts";
import { formatRecents } from "./format.ts";
import { clearSessionPointer, writeSessionPointer } from "./session.ts";

/** The three moments in a session where memory has something to do. */
export type HarnessPhase =
  /** A session began, resumed, or came back from compaction. Orient. */
  | "start"
  /** Context is about to be compacted. Preserve what exists. */
  | "checkpoint"
  /** The session is ending. Preserve, then release the session claim. */
  | "end";

export interface HarnessEvent {
  phase: HarnessPhase;
  /** The harness's own session id, when it supplies one. */
  sessionId: string | null;
  /** The harness's working directory, when it supplies one. */
  cwd: string | null;
  /** Which harness this is. Provenance only. */
  harness: string;
  /**
   * Why the phase fired — `startup`/`resume`/`compact` for a start,
   * `auto`/`manual` for a checkpoint, and so on. Advisory: harnesses
   * disagree about whether they send it at all.
   */
  reason: string | null;
}

/**
 * Parse a harness hook payload.
 *
 * Deliberately forgiving. This runs inside somebody else's process, on
 * whatever JSON they decided to send, and a session hook that throws is
 * worse than one that degrades — it turns a memory feature into a broken
 * session. Anything unparseable yields an event with null fields, which
 * every operation below handles.
 */
export function parseHarnessEvent(
  raw: string,
  phase: HarnessPhase,
  harness = "unknown",
): HarnessEvent {
  const event: HarnessEvent = { phase, sessionId: null, cwd: null, harness, reason: null };
  const trimmed = raw.trim();
  if (!trimmed) return event;

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return event;
    payload = parsed as Record<string, unknown>;
  } catch {
    return event;
  }

  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

  event.sessionId = text(payload.session_id) ?? text(payload.sessionId);
  event.cwd = text(payload.cwd);
  // `source` on a session start, `trigger` on a compaction, `reason`
  // generically. Whichever the harness sent.
  event.reason = text(payload.source) ?? text(payload.trigger) ?? text(payload.reason);
  // payload.transcript_path is intentionally not read. See the module doc.
  return event;
}

export interface OrientationResult {
  sessionId: string;
  /** The memory packet to hand the agent, or empty when there is nothing. */
  context: string;
  /** Whether an active handoff was found for this repository. */
  handoff: boolean;
  /** How many kept memories the packet carries. */
  memories: number;
}

/**
 * Session start: claim the session, and produce the orientation packet.
 *
 * This is the reader-side half. Loop 3 and Loop 4 both found that agents
 * reach for memory only when the question is overtly memory-shaped, so
 * "continue where we left off" works and "what package manager am I
 * using?" does not. Injecting the packet removes the judgement call
 * entirely — the agent starts the session already holding it.
 *
 * The packet is the same bounded, cited output recall produces. It is not
 * a transcript, and it respects the same token budget.
 */
export function orient(
  dejavu: Dejavu,
  event: HarnessEvent,
  options: { maxTokens?: number; limit?: number } = {},
): OrientationResult {
  const sessionId = event.sessionId ?? dejavu.sessionId;
  writeSessionPointer(dejavu.scope, sessionId, event.harness, { dbPath: dejavu.storage.path });

  const recalled = dejavu.recall("", {
    limit: options.limit ?? 6,
    maxTokens: options.maxTokens ?? 700,
  });
  const memories = recalled.hits.length;
  const handoff = recalled.activeHandoff !== null;
  if (memories === 0 && !handoff) {
    return { sessionId, context: "", handoff, memories };
  }

  return {
    sessionId,
    context: formatRecents(recalled.activeHandoff, recalled.hits.map((hit) => hit.slip), recalled.traceId),
    handoff,
    memories,
  };
}

export interface PreserveResult {
  sessionId: string;
  /** Drafts promoted to kept by this call. */
  promoted: number;
  /** The session's handoff id, if one exists or was rolled up just now. */
  handoffId: string | null;
  /** True when the rollup wrote the handoff during this call. */
  handoffWritten: boolean;
  /** Kept memories this session has produced in total. */
  kept: number;
}

/**
 * Preserve the session's work. Shared by checkpoint and end.
 *
 * Promoting the session's drafts is exactly what `handoff()` already does
 * when a session closes properly — this is the same rule applied when the
 * agent never got around to closing it. Drafts written this session are
 * live thinking, and letting them expire because context happened to
 * compact is the writer-side gap in miniature.
 *
 * Promotion runs through `keep()`, so chain-shaped memory rolls up into a
 * session handoff by the existing rules. Nothing is invented: if the
 * agent wrote nothing, this writes nothing.
 */
export function preserve(dejavu: Dejavu, event: HarnessEvent): PreserveResult {
  const sessionId = event.sessionId ?? dejavu.sessionId;
  const before = dejavu.storage.getHandoffBySession(sessionId, dejavu.scope);

  const drafts = dejavu.storage
    .listBySession(sessionId, dejavu.scope)
    .filter((slip) => slip.state === "draft");
  const promoted = drafts.length > 0 ? dejavu.keep(drafts.map((slip) => slip.id)).length : 0;

  const after = dejavu.storage.getHandoffBySession(sessionId, dejavu.scope);
  const kept = dejavu.storage
    .listBySession(sessionId, dejavu.scope)
    .filter((slip) => slip.state === "kept").length;

  return {
    sessionId,
    promoted,
    handoffId: after?.id ?? null,
    handoffWritten: !before && !!after,
    kept,
  };
}

/** Checkpoint before compaction. Preserve, and keep the session claim. */
export function checkpoint(dejavu: Dejavu, event: HarnessEvent): PreserveResult {
  return preserve(dejavu, event);
}

/** End of session. Preserve, then release the claim so the next one is fresh. */
export function finish(dejavu: Dejavu, event: HarnessEvent): PreserveResult {
  const result = preserve(dejavu, event);
  clearSessionPointer(dejavu.scope, { dbPath: dejavu.storage.path });
  return result;
}

/** One registered hook command in a Claude Code settings file. */
interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
  statusMessage?: string;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

type HookSettings = Record<string, HookGroup[]>;

/**
 * The three hook registrations that wire a harness into the lifecycle.
 *
 * No matchers: SessionStart should fire for `startup`, `resume` and
 * `fork` alike, and — importantly — for `compact`, which is how an agent
 * gets re-oriented after its context is compacted away. PreCompact
 * should fire for both manual and automatic compaction.
 *
 * Timeouts are short on purpose. Claude Code gives session-end hooks a
 * 1.5-second shared budget, and a memory packet that arrives late is
 * worth less than a session that starts promptly.
 */
export function claudeCodeHooks(command: string): HookSettings {
  const entry = (phase: HarnessPhase, timeout: number): HookGroup => ({
    hooks: [
      {
        type: "command",
        command: `${command} session ${phase} --harness=claude-code`,
        timeout,
        statusMessage: DEJAVU_HOOK_TAG,
      },
    ],
  });
  return {
    SessionStart: [entry("start", 10)],
    PreCompact: [entry("checkpoint", 5)],
    SessionEnd: [entry("end", 5)],
  };
}

/** Marks a hook group as ours, so re-installing replaces rather than duplicates. */
export const DEJAVU_HOOK_TAG = "dejavu";

function isDejavuGroup(group: unknown): boolean {
  if (!group || typeof group !== "object") return false;
  const hooks = (group as HookGroup).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (hook) =>
      hook?.statusMessage === DEJAVU_HOOK_TAG ||
      (typeof hook?.command === "string" && /\bdejavu\b/.test(hook.command) && /\bsession\b/.test(hook.command)),
  );
}

/**
 * Merge Dejavu's hooks into an existing settings object.
 *
 * Returns a new object; the input is not mutated. Other people's hooks on
 * the same events are preserved, and a previous Dejavu install is
 * replaced rather than duplicated, so re-running the installer after
 * moving the binary does the right thing.
 */
export function mergeHooks(
  settings: Record<string, unknown>,
  hooks: HookSettings,
): Record<string, unknown> {
  const existingHooks =
    settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
      ? { ...(settings.hooks as Record<string, unknown>) }
      : {};

  for (const [eventName, groups] of Object.entries(hooks)) {
    const current = Array.isArray(existingHooks[eventName])
      ? (existingHooks[eventName] as unknown[])
      : [];
    existingHooks[eventName] = [...current.filter((group) => !isDejavuGroup(group)), ...groups];
  }

  return { ...settings, hooks: existingHooks };
}

/**
 * Remove Dejavu's hooks from a settings object, leaving everything else.
 *
 * Anything that installs into somebody's configuration should be able to
 * take itself back out.
 */
export function unmergeHooks(settings: Record<string, unknown>): Record<string, unknown> {
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    return { ...settings };
  }
  const remaining: Record<string, unknown> = {};
  for (const [eventName, groups] of Object.entries(settings.hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      remaining[eventName] = groups;
      continue;
    }
    const kept = groups.filter((group) => !isDejavuGroup(group));
    if (kept.length > 0) remaining[eventName] = kept;
  }
  const next = { ...settings };
  if (Object.keys(remaining).length > 0) next.hooks = remaining;
  else delete next.hooks;
  return next;
}

/**
 * A one-line report for the human, not the agent.
 *
 * Loop 4 established that prose aimed at the agent is ignored under task
 * pressure. This is aimed at the person, who can act on "no handoff was
 * written" in a way the agent demonstrably will not.
 */
export function describePreserve(result: PreserveResult, phase: HarnessPhase): string {
  const moment = phase === "checkpoint" ? "before compaction" : "at session end";
  if (result.kept === 0 && result.promoted === 0) {
    return `dejavu: nothing recorded this session — the next one starts cold.`;
  }
  const parts: string[] = [];
  if (result.promoted > 0) parts.push(`kept ${result.promoted} draft(s) ${moment}`);
  if (result.handoffWritten) parts.push(`wrote a handoff for the next session`);
  else if (result.handoffId) parts.push(`handoff already written`);
  else parts.push(`no handoff — the next session gets memory but no continuation packet`);
  return `dejavu: ${parts.join("; ")}.`;
}

/**
 * Session identity shared across processes.
 *
 * Dejavu derives a session id per *process*. That is fine when one process
 * does all the work, and wrong the moment a harness gets involved: the MCP
 * server the agent writes through, a session hook firing as its own
 * command, and a human typing `dejavu remember` in a shell are three
 * processes that are obviously part of one piece of work — and each would
 * invent its own session.
 *
 * That breaks things that matter. "One handoff per session" stops meaning
 * anything. A hook that wants to promote the session's drafts before
 * context is compacted cannot see them, because they belong to a session
 * it has never heard of.
 *
 * So a harness may claim a session id for a repository scope by writing a
 * pointer next to the database. Every surface that opens Dejavu in that
 * scope then agrees on one session.
 *
 * The pointer is a hint, never an authority: DEJAVU_SESSION still wins, a
 * missing or stale pointer falls back to the per-process id, and a
 * corrupt file is ignored rather than fatal. Losing it costs continuity,
 * never data.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { currentSessionId } from "./lifecycle.ts";
import { defaultDbPath } from "./storage.ts";

/**
 * How long a claimed session stays valid.
 *
 * Matches the draft TTL. A harness that exits without cleaning up should
 * not silently rejoin a session from last week and append to a handoff
 * nobody remembers writing.
 */
export const SESSION_POINTER_TTL_MS = 24 * 60 * 60 * 1000;

export interface SessionPointer {
  /** The session id every surface in this scope should write under. */
  sessionId: string;
  /** Which harness claimed it. Provenance only; never used for logic. */
  harness: string;
  /** ms since epoch. */
  updatedAt: number;
}

export interface SessionStoreOptions {
  /** Database path the pointer file sits beside. Defaults to the usual one. */
  dbPath?: string;
  now?: number;
}

/**
 * Where the pointer file lives: beside the database, not at a fixed path.
 *
 * DEJAVU_DB can point anywhere, and a pointer that outlived its database
 * would hand out session ids for memory that no longer exists.
 */
export function sessionStorePath(dbPath: string = defaultDbPath()): string | null {
  if (dbPath === ":memory:") return null;
  return join(dirname(dbPath), "sessions.json");
}

type SessionStore = Record<string, SessionPointer>;

function readStore(path: string): SessionStore {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: SessionStore = {};
    for (const [scope, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<SessionPointer>;
      if (typeof entry.sessionId !== "string" || entry.sessionId.length === 0) continue;
      if (typeof entry.updatedAt !== "number") continue;
      store[scope] = {
        sessionId: entry.sessionId,
        harness: typeof entry.harness === "string" ? entry.harness : "unknown",
        updatedAt: entry.updatedAt,
      };
    }
    return store;
  } catch {
    // Missing, unreadable, or corrupt. Continuity is a nice-to-have.
    return {};
  }
}

/** Write via a temp file and rename, so a crash cannot leave a half-written store. */
function writeStore(path: string, store: SessionStore): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`);
    renameSync(temporary, path);
  } catch {
    // A read-only or full disk must not break the memory write that
    // triggered this. The pointer is an optimisation.
  }
}

/** Drop entries past the TTL. Keeps the file from growing without bound. */
function prune(store: SessionStore, now: number): SessionStore {
  const live: SessionStore = {};
  for (const [scope, pointer] of Object.entries(store)) {
    if (now - pointer.updatedAt <= SESSION_POINTER_TTL_MS) live[scope] = pointer;
  }
  return live;
}

/** The session a harness claimed for this scope, or null if none is live. */
export function readSessionPointer(
  scope: string,
  options: SessionStoreOptions = {},
): SessionPointer | null {
  const path = sessionStorePath(options.dbPath);
  if (!path) return null;
  const now = options.now ?? Date.now();
  const pointer = readStore(path)[scope];
  if (!pointer) return null;
  if (now - pointer.updatedAt > SESSION_POINTER_TTL_MS) return null;
  return pointer;
}

/** Claim a session id for this scope. Overwrites any previous claim. */
export function writeSessionPointer(
  scope: string,
  sessionId: string,
  harness: string,
  options: SessionStoreOptions = {},
): SessionPointer | null {
  const path = sessionStorePath(options.dbPath);
  if (!path) return null;
  const now = options.now ?? Date.now();
  const pointer: SessionPointer = { sessionId, harness, updatedAt: now };
  const store = prune(readStore(path), now);
  store[scope] = pointer;
  writeStore(path, store);
  return pointer;
}

/** Release this scope's claim. Returns true if there was one to release. */
export function clearSessionPointer(scope: string, options: SessionStoreOptions = {}): boolean {
  const path = sessionStorePath(options.dbPath);
  if (!path) return false;
  const now = options.now ?? Date.now();
  const store = prune(readStore(path), now);
  if (!(scope in store)) return false;
  delete store[scope];
  if (Object.keys(store).length === 0) {
    try {
      rmSync(path, { force: true });
    } catch {
      writeStore(path, store);
    }
  } else {
    writeStore(path, store);
  }
  return true;
}

/**
 * The session id to write under, in priority order:
 *
 *   1. DEJAVU_SESSION — an explicit caller always wins.
 *   2. a live pointer claimed by a harness for this scope.
 *   3. the per-process id, exactly as before.
 */
export function resolveSessionId(scope: string, options: SessionStoreOptions = {}): string {
  const explicit = process.env.DEJAVU_SESSION;
  if (explicit && explicit.length > 0) return explicit;
  return readSessionPointer(scope, options)?.sessionId ?? currentSessionId();
}

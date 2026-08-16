/**
 * Code anchors — pointers from a memory to the code it is about.
 *
 * A slip's wall-clock age says almost nothing about whether it is still
 * true. "Three days old" is a proxy. The question an agent actually needs
 * answered is *did the code this memory describes change underneath it*,
 * and git already knows.
 *
 * So an anchor records the git blob id of a file at the moment the memory
 * was written. At recall time we recompute that id and compare. The check
 * is local, deterministic, allocation-cheap, and never calls a model or a
 * subprocess.
 *
 * Anchors are immutable, like slips. A moved or rewritten file produces a
 * new *status*, never an edited anchor.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalPath, findRepoRoot } from "./context.ts";
import type { AnchorSpec } from "./types.ts";

/**
 * Files larger than this are reported `unknown` rather than hashed.
 *
 * Recall runs on the agent's critical path. Hashing a 40 MB fixture to
 * decide whether one note is stale is a bad trade, and saying so is more
 * honest than silently reporting `verified`.
 */
export const MAX_ANCHOR_BYTES = 2 * 1024 * 1024;

/**
 * Compute the git blob object id for a byte sequence.
 *
 * This is the real git identity function — sha1 over the header
 * `blob <byteLength>\0` followed by the contents — so the value matches
 * `git hash-object <file>` exactly and is directly comparable with what
 * git itself stores. sha1 is used here for compatibility with git's
 * object model, not as a security primitive.
 */
export function gitBlobSha(contents: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${contents.byteLength}\0`)
    .update(contents)
    .digest("hex");
}

/**
 * Parse a `path[:line][#symbol]` anchor request.
 *
 * Accepted forms:
 *   src/auth.ts
 *   src/auth.ts:42
 *   src/auth.ts#refreshToken
 *   src/auth.ts:42#refreshToken
 *
 * The symbol is taken before the line so that a `#` inside a path is not
 * mistaken for a symbol separator after a numeric suffix has been split
 * off. Windows-style separators are normalized to POSIX so the same
 * anchor text means the same file on every platform.
 */
export function parseAnchorSpec(raw: string): AnchorSpec {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("dejavu anchor: path is empty");

  let rest = trimmed;
  let symbol: string | null = null;
  const hash = rest.indexOf("#");
  if (hash !== -1) {
    symbol = rest.slice(hash + 1).trim() || null;
    rest = rest.slice(0, hash);
  }

  let line: number | null = null;
  const colon = rest.match(/^(.*):(\d+)$/);
  if (colon?.[1] !== undefined && colon[2] !== undefined) {
    rest = colon[1];
    line = Number(colon[2]);
    if (!Number.isInteger(line) || line < 1) {
      throw new Error(`dejavu anchor: line must be a positive integer in "${trimmed}"`);
    }
  }

  const path = normalizeAnchorPath(rest);
  if (!path) throw new Error(`dejavu anchor: path is empty in "${trimmed}"`);
  return { path, line, symbol };
}

/** Accept an already-parsed spec or a raw string, uniformly. */
export function toAnchorSpec(input: string | AnchorSpec): AnchorSpec {
  if (typeof input === "string") return parseAnchorSpec(input);
  const path = normalizeAnchorPath(input.path);
  if (!path) throw new Error("dejavu anchor: path is empty");
  return { path, line: input.line ?? null, symbol: input.symbol?.trim() || null };
}

/** Collapse separators and strip a leading `./`, without resolving symlinks. */
function normalizeAnchorPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
}

/**
 * The directory anchor paths are relative to.
 *
 * Deliberately independent of DEJAVU_SCOPE: an explicit scope override
 * changes which memories are visible, not what `src/auth.ts` points at.
 * Falls back to the canonical cwd outside a checkout.
 */
export function anchorRoot(cwd: string = process.cwd()): string {
  return findRepoRoot(cwd) ?? canonicalPath(cwd);
}

/**
 * Resolve a repository-relative anchor path to an absolute one.
 *
 * Returns null when the path escapes the root. An anchor is a claim about
 * *this* repository; a slip that points at `../../etc/passwd` is either a
 * mistake or an attempt to make memory read arbitrary files, and neither
 * deserves to be stored.
 */
export function resolveAnchorPath(root: string, path: string): string | null {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return absolute;
}

/** Express an absolute path as a POSIX repository-relative anchor path. */
export function relativeAnchorPath(root: string, path: string): string | null {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * Read a file and return its git blob id, or a reason it could not be read.
 *
 * Callers turn `missing` into `orphaned` and `unreadable` / `too-large`
 * into `unknown`. Never throws.
 */
export function blobShaOf(absolutePath: string): { sha: string } | { reason: string } {
  let size: number;
  try {
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) return { reason: "path is a directory" };
    size = stats.size;
  } catch {
    return { reason: "missing" };
  }
  if (size > MAX_ANCHOR_BYTES) {
    return { reason: `file exceeds the ${MAX_ANCHOR_BYTES}-byte anchor limit` };
  }
  try {
    return { sha: gitBlobSha(readFileSync(absolutePath)) };
  } catch {
    return { reason: "unreadable" };
  }
}

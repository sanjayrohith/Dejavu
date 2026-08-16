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
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalPath, findGitDir, findRepoRoot } from "./context.ts";
import type { Anchor, AnchorSpec, AnchorState, AnchorStatus } from "./types.ts";

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

/**
 * Read the commit HEAD points at, without shelling out to git.
 *
 * Follows a symbolic HEAD to its loose ref, then falls back to
 * `packed-refs` for repositories whose refs have been packed. Returns
 * null for an unborn branch, a repository with no HEAD, or anything else
 * unreadable — the commit is provenance, not the drift signal, so a
 * missing one is never fatal.
 */
export function headCommit(root: string): string | null {
  const gitDir = findGitDir(root);
  if (!gitDir) return null;
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = head.match(/^ref:\s*(.+)$/)?.[1]?.trim();
    if (!ref) return /^[0-9a-f]{40}$/i.test(head) ? head.toLowerCase() : null;

    const loose = join(gitDir, ref);
    if (existsSync(loose)) {
      const sha = readFileSync(loose, "utf8").trim();
      return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
    }

    const packed = join(gitDir, "packed-refs");
    if (!existsSync(packed)) return null;
    for (const line of readFileSync(packed, "utf8").split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && sha && /^[0-9a-f]{40}$/i.test(sha)) return sha.toLowerCase();
    }
    return null;
  } catch {
    return null;
  }
}

export interface CaptureOptions {
  slipId: string;
  /** Directory anchor paths resolve against. Defaults to {@link anchorRoot}. */
  root?: string;
  createdAt?: number;
  /** Reuse one HEAD read across a batch. */
  commit?: string | null;
}

/**
 * Capture one anchor against the current working tree.
 *
 * Throws rather than storing a broken pointer. A memory that claims to be
 * about `src/auth.ts` when no such file exists is worse than an unanchored
 * memory: it looks precise and is not. The caller decides whether that is
 * a hard failure or a reason to drop the anchor.
 */
export function captureAnchor(
  input: string | AnchorSpec,
  options: CaptureOptions,
): Anchor {
  const spec = toAnchorSpec(input);
  const root = options.root ?? anchorRoot();
  const absolute = resolveAnchorPath(root, spec.path);
  if (!absolute) {
    throw new Error(
      `dejavu anchor: "${spec.path}" resolves outside the repository root ${root}`,
    );
  }
  const read = blobShaOf(absolute);
  if (!("sha" in read)) {
    throw new Error(
      read.reason === "missing"
        ? `dejavu anchor: "${spec.path}" does not exist in ${root}`
        : `dejavu anchor: cannot read "${spec.path}" (${read.reason})`,
    );
  }
  return {
    slipId: options.slipId,
    path: spec.path,
    line: spec.line,
    symbol: spec.symbol,
    blobSha: read.sha,
    commit: options.commit !== undefined ? options.commit : headCommit(root),
    createdAt: options.createdAt ?? Date.now(),
  };
}

/**
 * Severity order used to roll several anchors up into one verdict.
 *
 * `orphaned` outranks `drifted` because a deleted file is a stronger
 * statement that the memory has been left behind. `unknown` outranks
 * `verified` so an unverifiable anchor is never reported as confirmed.
 */
const STATUS_SEVERITY: Record<AnchorStatus, number> = {
  verified: 0,
  unknown: 1,
  drifted: 2,
  orphaned: 3,
};

/** Check one anchor against the working tree. Never throws. */
export function checkAnchor(
  anchor: Anchor,
  root: string,
  cache?: Map<string, { sha: string } | { reason: string }>,
): AnchorState {
  const absolute = resolveAnchorPath(root, anchor.path);
  if (!absolute) {
    return { anchor, status: "unknown", detail: `${anchor.path} is outside ${root}` };
  }

  let read = cache?.get(absolute);
  if (!read) {
    read = blobShaOf(absolute);
    cache?.set(absolute, read);
  }

  if (!("sha" in read)) {
    if (read.reason === "missing") {
      return { anchor, status: "orphaned", detail: `${anchor.path} no longer exists` };
    }
    return { anchor, status: "unknown", detail: `${anchor.path} could not be checked (${read.reason})` };
  }

  if (read.sha === anchor.blobSha) {
    return { anchor, status: "verified", detail: `${anchor.path} unchanged since this was written` };
  }
  return { anchor, status: "drifted", detail: `${anchor.path} changed since this was written` };
}

/**
 * Check a batch of anchors, hashing each distinct file at most once.
 *
 * Recall packets are small and several slips often point at the same
 * file, so the per-call cache does most of the work of keeping this off
 * the critical path.
 */
export function checkAnchors(anchors: Anchor[], root: string): AnchorState[] {
  const cache = new Map<string, { sha: string } | { reason: string }>();
  return anchors.map((anchor) => checkAnchor(anchor, root, cache));
}

/**
 * Collapse several anchor verdicts into the one an agent should act on.
 *
 * Returns null for an unanchored slip, which is not the same as a slip
 * whose anchors all check out — the caller must be able to tell "no claim
 * was made" from "the claim still holds".
 */
export function rollupDrift(states: AnchorState[]): AnchorStatus | null {
  if (states.length === 0) return null;
  let worst: AnchorStatus = "verified";
  for (const state of states) {
    if (STATUS_SEVERITY[state.status] > STATUS_SEVERITY[worst]) worst = state.status;
  }
  return worst;
}

/** True when the verdict means the memory should be re-checked before use. */
export function driftIsSuspect(status: AnchorStatus | null | undefined): boolean {
  return status === "drifted" || status === "orphaned";
}

/** Capture a batch, reading HEAD once for all of them. */
export function captureAnchors(
  inputs: Array<string | AnchorSpec>,
  options: CaptureOptions,
): Anchor[] {
  if (inputs.length === 0) return [];
  const root = options.root ?? anchorRoot();
  const commit = options.commit !== undefined ? options.commit : headCommit(root);
  const seen = new Set<string>();
  const anchors: Anchor[] = [];
  for (const input of inputs) {
    const anchor = captureAnchor(input, { ...options, root, commit });
    const key = `${anchor.path}\0${anchor.symbol ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push(anchor);
  }
  return anchors;
}

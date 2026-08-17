/**
 * Reading the working tree — where the session actually is.
 *
 * Session-start orientation used to be composed from recency alone: the
 * most recently kept memories, whatever they happened to be about. That
 * ignores the strongest signal available at the moment a session opens.
 * The checkout itself says what this session is going to be about — the
 * branch it is on, and the files already changed in it.
 *
 * Two rules shape this module:
 *
 * - **Cheap first.** The branch is read straight out of `.git/HEAD`, the
 *   same way {@link headCommit} reads the commit. No subprocess, no git
 *   binary required. Only the diff needs to shell out, because only git
 *   knows how the index compares to HEAD.
 * - **Never throw.** This runs on a session hook's critical path, inside
 *   somebody else's process. A repository with no commits, a directory
 *   that is not a checkout, a machine with no git on PATH, and a git that
 *   hangs are all ordinary conditions here, and every one of them
 *   degrades to "no worktree signal" rather than a failed session.
 */

import { readFileSync } from "node:fs";
import { findGitDir } from "./context.ts";

/**
 * How long the diff subprocess gets before it is killed.
 *
 * Claude Code shares a 1.5-second budget across every session-end hook.
 * `git diff --name-only` against a warm index is a few milliseconds; if
 * it has not answered in a quarter second something is wrong (an enormous
 * repository, a cold NFS mount, an index lock held by another process),
 * and an orientation packet without the diff is worth far more than a
 * session that stalls waiting for one.
 */
export const DIFF_TIMEOUT_MS = 250;

/**
 * Most paths carried out of a diff.
 *
 * The paths become an `IN` list against the anchors table, so an
 * unbounded diff — a lockfile regeneration, a branch switch, a formatting
 * sweep — would turn one indexed lookup into a very large one. Anchored
 * memory clusters on a handful of files in practice, so the cap costs
 * nothing real and bounds the query.
 */
export const MAX_DIFF_PATHS = 200;

export interface WorktreeState {
  /** Current branch name, or null when detached, unborn, or not a checkout. */
  branch: string | null;
  /** Repository-relative POSIX paths changed against HEAD. Empty when unknown. */
  changed: string[];
  /** True when the diff was longer than {@link MAX_DIFF_PATHS} and was cut. */
  truncated: boolean;
  /** True when the diff could not be read at all, as opposed to being empty. */
  unavailable: boolean;
}

/**
 * The branch this checkout is on, read directly from `.git/HEAD`.
 *
 * Returns null for a detached HEAD — a bisect, a checked-out tag, a
 * rebase in progress — because there is no branch name to report, and
 * reporting the raw sha would be noise in a memory packet.
 */
export function currentBranch(root: string): string | null {
  const gitDir = findGitDir(root);
  if (!gitDir) return null;
  try {
    const head = readFileSync(`${gitDir}/HEAD`, "utf8").trim();
    const ref = head.match(/^ref:\s*(.+)$/)?.[1]?.trim();
    if (!ref) return null; // detached HEAD holds a raw sha
    const branch = ref.replace(/^refs\/heads\//, "").trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Repository-relative paths of everything changed against HEAD.
 *
 * Covers staged and unstaged modifications in one call. Untracked files
 * are deliberately excluded: nothing can be anchored to a file that did
 * not exist when the memory was written, so listing them would add cost
 * and never add a hit.
 *
 * Returns null when the diff could not be read — which the caller must be
 * able to tell apart from a clean tree, since "nothing changed" and "we
 * could not look" justify different packets.
 */
export function changedPaths(
  root: string,
  options: { timeoutMs?: number } = {},
): string[] | null {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(["git", "diff", "--name-only", "HEAD"], {
      cwd: root,
      timeout: options.timeoutMs ?? DIFF_TIMEOUT_MS,
      stdout: "pipe",
      stderr: "ignore",
      // Passed explicitly rather than inherited: Bun resolves the binary
      // against the environment captured when *this* process started, so
      // a PATH the caller set at runtime would otherwise be ignored.
      env: process.env,
    });
  } catch {
    return null; // no git on PATH, or the spawn itself failed
  }
  if (!result.success) return null; // not a checkout, unborn HEAD, or timed out

  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Everything the working tree can say about this session, cheaply.
 *
 * Never throws, and always returns a usable object. A caller outside a
 * checkout gets `{ branch: null, changed: [], unavailable: true }` and can
 * carry on composing a packet without the working-tree sections.
 */
export function readWorktree(
  root: string,
  options: { timeoutMs?: number; maxPaths?: number } = {},
): WorktreeState {
  const branch = currentBranch(root);
  const paths = changedPaths(root, options);
  if (paths === null) {
    return { branch, changed: [], truncated: false, unavailable: true };
  }
  const max = options.maxPaths ?? MAX_DIFF_PATHS;
  return {
    branch,
    changed: paths.slice(0, max),
    truncated: paths.length > max,
    unavailable: false,
  };
}

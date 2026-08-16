import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const LEGACY_SCOPE = "legacy:global";
export const GLOBAL_SCOPE = "global";

export interface MemoryContext {
  /** Stable retrieval boundary. Same repository remote => same scope across checkouts. */
  scope: string;
  /** Human-readable repository/workspace name. */
  repository: string;
  /** Canonical local root used to derive this context. */
  root: string;
  source: "env" | "git-remote" | "git-root" | "cwd";
}

/**
 * Derive the narrowest safe automatic memory scope.
 *
 * Priority:
 * 1. DEJAVU_SCOPE — explicit caller-owned scope (use `global` deliberately).
 * 2. nearest git repository, keyed by normalized origin URL when available;
 * 3. canonical current working directory.
 *
 * The hash prevents absolute paths or private remotes from leaking into recall
 * output while keeping the readable repository name useful for provenance.
 */
export function currentMemoryContext(cwd = process.cwd()): MemoryContext {
  const explicit = process.env.DEJAVU_SCOPE?.trim();
  if (explicit) {
    return {
      scope: explicit,
      repository: process.env.DEJAVU_REPOSITORY?.trim() || basename(cwd),
      root: canonical(cwd),
      source: "env",
    };
  }

  const root = findGitRoot(cwd);
  if (root) {
    const remote = readOrigin(root);
    const identity = remote ? normalizeRemote(remote) : canonical(root);
    const repository = remote ? remoteRepositoryName(identity) : basename(root);
    return {
      scope: `repo:${repository}:${digest(identity)}`,
      repository,
      root: canonical(root),
      source: remote ? "git-remote" : "git-root",
    };
  }

  const rootPath = canonical(cwd);
  return {
    scope: `cwd:${basename(rootPath)}:${digest(rootPath)}`,
    repository: basename(rootPath),
    root: rootPath,
    source: "cwd",
  };
}

/**
 * Nearest enclosing checkout root, walking up from `start`.
 *
 * Exported because anchors resolve their paths against the same root the
 * scope is derived from — an anchor written from `src/` and one written
 * from the repository root must agree on what `src/auth.ts` means.
 */
export function findRepoRoot(start: string): string | null {
  let cursor = canonical(start);
  while (true) {
    if (existsSync(join(cursor, ".git"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

/**
 * The git directory belonging to *this* checkout.
 *
 * Handles the plain `.git/` directory and the `gitdir:` pointer file used
 * by linked worktrees and submodules. Deliberately does not follow
 * `commondir`: per-worktree state — HEAD above all — lives here, and a
 * linked worktree pointed at another branch must not report the main
 * checkout's HEAD. Use {@link findCommonGitDir} for shared state.
 */
export function findGitDir(root: string): string | null {
  try {
    const dotGit = join(root, ".git");
    // A directory is the git dir itself; a file is a `gitdir:` pointer.
    if (statSync(dotGit).isDirectory()) return dotGit;
    const pointer = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/m)?.[1];
    if (!pointer) return null;
    return isAbsolute(pointer) ? pointer : resolve(root, pointer);
  } catch {
    return null;
  }
}

/**
 * The git directory holding state shared by every worktree — config, and
 * therefore `origin`, which is what repository scope is derived from.
 *
 * For an ordinary checkout this is the same directory {@link findGitDir}
 * returns. For a linked worktree it follows `commondir` back to the main
 * git directory, so two worktrees of one repository resolve to the same
 * memory scope.
 */
export function findCommonGitDir(root: string): string | null {
  const gitDir = findGitDir(root);
  if (!gitDir) return null;
  try {
    const commonDirFile = join(gitDir, "commondir");
    if (!existsSync(commonDirFile)) return gitDir;
    const common = readFileSync(commonDirFile, "utf8").trim();
    return isAbsolute(common) ? common : resolve(gitDir, common);
  } catch {
    return gitDir;
  }
}

function findGitRoot(start: string): string | null {
  return findRepoRoot(start);
}

function readOrigin(root: string): string | null {
  try {
    const gitDir = findCommonGitDir(root);
    if (!gitDir) return null;
    const config = readFileSync(join(gitDir, "config"), "utf8");
    const section = config.match(/\[remote\s+"origin"\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? "";
    return section.match(/^\s*url\s*=\s*(.+?)\s*$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

function normalizeRemote(remote: string): string {
  return remote
    .trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function remoteRepositoryName(normalizedRemote: string): string {
  const name = normalizedRemote.split("/").filter(Boolean).at(-1);
  return name || "repository";
}

/** Resolve symlinks where possible, falling back to a plain absolute path. */
export function canonicalPath(path: string): string {
  return canonical(path);
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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

function findGitRoot(start: string): string | null {
  let cursor = canonical(start);
  while (true) {
    if (existsSync(join(cursor, ".git"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function readOrigin(root: string): string | null {
  try {
    const dotGit = join(root, ".git");
    let gitDir = dotGit;
    if (!existsSync(join(dotGit, "config"))) {
      const pointer = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/m)?.[1];
      if (!pointer) return null;
      gitDir = isAbsolute(pointer) ? pointer : resolve(root, pointer);
      const commonDirFile = join(gitDir, "commondir");
      if (existsSync(commonDirFile)) {
        const common = readFileSync(commonDirFile, "utf8").trim();
        gitDir = isAbsolute(common) ? common : resolve(gitDir, common);
      }
    }
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

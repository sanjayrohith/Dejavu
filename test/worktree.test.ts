import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, currentBranch, readWorktree } from "../src/worktree.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dejavu-worktree-"));
  dirs.push(dir);
  return dir;
}

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (!result.success) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

/** A real checkout with one commit, so HEAD exists and diffs are meaningful. */
function checkout(): string {
  const root = tempDir();
  git(root, "init", "--initial-branch=main");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "auth.ts"), "export const timeout = 30;\n");
  writeFileSync(join(root, "src", "billing.ts"), "export const currency = 'usd';\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  return root;
}

describe("reading the current branch", () => {
  test("reads the branch name out of .git/HEAD", () => {
    expect(currentBranch(checkout())).toBe("main");
  });

  test("follows a branch switch", () => {
    const root = checkout();
    git(root, "checkout", "-b", "feature/orientation");
    expect(currentBranch(root)).toBe("feature/orientation");
  });

  test("reports null for a detached HEAD rather than a raw sha", () => {
    const root = checkout();
    git(root, "checkout", "--detach");
    expect(currentBranch(root)).toBeNull();
  });

  test("reports null outside a checkout", () => {
    expect(currentBranch(tempDir())).toBeNull();
  });
});

describe("reading changed paths", () => {
  test("a clean tree has no changed paths", () => {
    expect(changedPaths(checkout())).toEqual([]);
  });

  test("an unstaged edit shows up", () => {
    const root = checkout();
    writeFileSync(join(root, "src", "auth.ts"), "export const timeout = 90;\n");
    expect(changedPaths(root)).toEqual(["src/auth.ts"]);
  });

  test("a staged edit shows up too", () => {
    const root = checkout();
    writeFileSync(join(root, "src", "billing.ts"), "export const currency = 'eur';\n");
    git(root, "add", "src/billing.ts");
    expect(changedPaths(root)).toEqual(["src/billing.ts"]);
  });

  test("untracked files are excluded — nothing can be anchored to them", () => {
    const root = checkout();
    writeFileSync(join(root, "src", "brand-new.ts"), "export const fresh = true;\n");
    expect(changedPaths(root)).toEqual([]);
  });

  test("outside a checkout it reports null, not an empty diff", () => {
    expect(changedPaths(tempDir())).toBeNull();
  });

  test("a repository with no commits reports null rather than throwing", () => {
    const root = tempDir();
    git(root, "init", "--initial-branch=main");
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    expect(changedPaths(root)).toBeNull();
  });
});

describe("reading the whole worktree state", () => {
  test("combines branch and diff", () => {
    const root = checkout();
    writeFileSync(join(root, "src", "auth.ts"), "export const timeout = 90;\n");
    expect(readWorktree(root)).toEqual({
      branch: "main",
      changed: ["src/auth.ts"],
      truncated: false,
      unavailable: false,
    });
  });

  test("a clean tree is available with nothing changed", () => {
    const state = readWorktree(checkout());
    expect(state.unavailable).toBe(false);
    expect(state.changed).toEqual([]);
  });

  test("outside a checkout it degrades instead of throwing", () => {
    expect(readWorktree(tempDir())).toEqual({
      branch: null,
      changed: [],
      truncated: false,
      unavailable: true,
    });
  });

  test("an oversized diff is capped and says so", () => {
    const root = checkout();
    mkdirSync(join(root, "many"), { recursive: true });
    for (let i = 0; i < 12; i += 1) {
      writeFileSync(join(root, "many", `f${i}.ts`), `export const v = ${i};\n`);
    }
    git(root, "add", ".");
    git(root, "commit", "-m", "many");
    for (let i = 0; i < 12; i += 1) {
      writeFileSync(join(root, "many", `f${i}.ts`), `export const v = ${i + 100};\n`);
    }

    const state = readWorktree(root, { maxPaths: 5 });
    expect(state.changed).toHaveLength(5);
    expect(state.truncated).toBe(true);
  });

  test("a hung git is bounded by the timeout rather than stalling the session", () => {
    const root = checkout();
    writeFileSync(join(root, "src", "auth.ts"), "export const timeout = 90;\n");

    // Racing the real git binary would be flaky — on a two-file
    // repository it usually wins. Put a git that never answers on PATH
    // instead, so the timeout is the only thing that can end the call.
    const bin = tempDir();
    writeFileSync(join(bin, "git"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;

    const started = performance.now();
    try {
      const state = readWorktree(root, { timeoutMs: 60 });
      expect(state.changed).toEqual([]);
      expect(state.unavailable).toBe(true);
      // The branch is read from .git/HEAD, so it survives a broken git.
      expect(state.branch).toBe("main");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

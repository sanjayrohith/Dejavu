import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anchorRoot,
  captureAnchor,
  captureAnchors,
  gitBlobSha,
  headCommit,
} from "../src/anchors.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkout with a real .git directory but no commits. */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "dejavu-capture-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "auth.ts"), "export const timeout = 30;\n");
  return dir;
}

describe("capturing anchors", () => {
  test("records the blob id of the file as it is now", () => {
    const root = workspace();
    const anchor = captureAnchor("src/auth.ts:42#login", { slipId: "slip-1", root });
    expect(anchor).toMatchObject({
      slipId: "slip-1",
      path: "src/auth.ts",
      line: 42,
      symbol: "login",
      blobSha: gitBlobSha(new TextEncoder().encode("export const timeout = 30;\n")),
    });
    expect(anchor.createdAt).toBeGreaterThan(0);
  });

  test("refuses to anchor to a path that does not exist", () => {
    const root = workspace();
    expect(() => captureAnchor("src/nope.ts", { slipId: "slip-1", root })).toThrow(
      /does not exist/,
    );
  });

  test("refuses to anchor outside the repository root", () => {
    const root = workspace();
    expect(() => captureAnchor("../escape.ts", { slipId: "slip-1", root })).toThrow(
      /outside the repository root/,
    );
  });

  test("refuses to anchor to a directory", () => {
    const root = workspace();
    expect(() => captureAnchor("src", { slipId: "slip-1", root })).toThrow(/cannot read/);
  });

  test("batch capture dedupes the same path and symbol", () => {
    const root = workspace();
    const anchors = captureAnchors(
      ["src/auth.ts", "./src/auth.ts", "src/auth.ts#login"],
      { slipId: "slip-1", root },
    );
    expect(anchors.map((a) => a.symbol)).toEqual([null, "login"]);
  });

  test("batch capture is all-or-nothing on a bad path", () => {
    const root = workspace();
    expect(() => captureAnchors(["src/auth.ts", "src/nope.ts"], { slipId: "slip-1", root })).toThrow(
      /does not exist/,
    );
  });

  test("empty batch is a no-op", () => {
    expect(captureAnchors([], { slipId: "slip-1", root: "/nowhere" })).toEqual([]);
  });
});

describe("HEAD resolution", () => {
  test("is null for an unborn branch", () => {
    expect(headCommit(workspace())).toBeNull();
  });

  test("reads a loose ref", () => {
    const root = workspace();
    const sha = "a".repeat(40);
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "refs", "heads", "main"), `${sha}\n`);
    expect(headCommit(root)).toBe(sha);
  });

  test("falls back to packed-refs", () => {
    const root = workspace();
    const sha = "b".repeat(40);
    writeFileSync(
      join(root, ".git", "packed-refs"),
      `# pack-refs with: peeled fully-peeled sorted\n${sha} refs/heads/main\n`,
    );
    expect(headCommit(root)).toBe(sha);
  });

  test("reads a detached HEAD", () => {
    const root = workspace();
    const sha = "c".repeat(40);
    writeFileSync(join(root, ".git", "HEAD"), `${sha}\n`);
    expect(headCommit(root)).toBe(sha);
  });

  test("is null outside a checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "dejavu-nogit-"));
    dirs.push(dir);
    expect(headCommit(dir)).toBeNull();
  });

  test("agrees with the installed git binary on this repository", () => {
    const root = anchorRoot(import.meta.dir);
    const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    if (git.error || git.status !== 0) return; // no git, or no commits yet
    expect(headCommit(root)).toBe(git.stdout.trim());
  });

  test("a linked worktree reports its own HEAD, not the main checkout's", () => {
    // HEAD is per-worktree state. Following `commondir` — which is correct for
    // config, and therefore for scope — would report the main checkout's
    // branch here and silently stamp every anchor with the wrong commit.
    const dir = mkdtempSync(join(tmpdir(), "dejavu-worktree-"));
    dirs.push(dir);
    const main = join(dir, "main");
    const linked = join(dir, "linked");
    const run = (args: string[], cwd: string) =>
      spawnSync("git", args, { cwd, encoding: "utf8" });

    mkdirSync(main, { recursive: true });
    if (run(["init", "-q", "-b", "main", "."], main).status !== 0) return; // no git available
    run(["config", "user.email", "test@example.com"], main);
    run(["config", "user.name", "test"], main);
    writeFileSync(join(main, "file.txt"), "one\n");
    run(["add", "-A"], main);
    run(["commit", "-qm", "first"], main);
    const first = run(["rev-parse", "HEAD"], main).stdout.trim();

    writeFileSync(join(main, "file.txt"), "two\n");
    run(["commit", "-qam", "second"], main);
    const second = run(["rev-parse", "HEAD"], main).stdout.trim();
    if (run(["worktree", "add", "-q", "--detach", linked, first], main).status !== 0) return;

    expect(first).not.toBe(second);
    expect(headCommit(main)).toBe(second);
    expect(headCommit(linked)).toBe(first);

    run(["worktree", "remove", "--force", linked], main);
  });
});

describe("anchor root", () => {
  test("is the checkout root, not the current directory", () => {
    const root = workspace();
    expect(anchorRoot(join(root, "src"))).toBe(root);
  });

  test("ignores DEJAVU_SCOPE — scope changes visibility, not file identity", () => {
    const root = workspace();
    const previous = process.env.DEJAVU_SCOPE;
    process.env.DEJAVU_SCOPE = "global";
    try {
      expect(anchorRoot(join(root, "src"))).toBe(root);
    } finally {
      if (previous === undefined) delete process.env.DEJAVU_SCOPE;
      else process.env.DEJAVU_SCOPE = previous;
    }
  });
});

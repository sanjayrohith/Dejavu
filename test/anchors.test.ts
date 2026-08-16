import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blobShaOf,
  gitBlobSha,
  parseAnchorSpec,
  relativeAnchorPath,
  resolveAnchorPath,
  toAnchorSpec,
} from "../src/anchors.ts";

describe("git blob identity", () => {
  test("matches the documented git object format", () => {
    // sha1("blob 12\0hello world\n") — the canonical git blob id for that
    // content, verifiable with `printf 'hello world\n' | git hash-object --stdin`.
    expect(gitBlobSha(new TextEncoder().encode("hello world\n"))).toBe(
      "3b18e512dba79e4c8300dd08aeb37f8e728b8dad",
    );
  });

  test("hashes empty content to the git empty blob", () => {
    expect(gitBlobSha(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  test("agrees with the installed git binary", () => {
    const git = spawnSync("git", ["hash-object", "--stdin"], {
      input: "anchored contents\n",
      encoding: "utf8",
    });
    if (git.error || git.status !== 0) return; // no git available; the vectors above still pin the format
    expect(gitBlobSha(new TextEncoder().encode("anchored contents\n"))).toBe(git.stdout.trim());
  });

  test("differs as soon as one byte changes", () => {
    const before = gitBlobSha(new TextEncoder().encode("const timeout = 30;\n"));
    const after = gitBlobSha(new TextEncoder().encode("const timeout = 60;\n"));
    expect(before).not.toBe(after);
  });
});

describe("anchor spec parsing", () => {
  test("bare path", () => {
    expect(parseAnchorSpec("src/auth.ts")).toEqual({ path: "src/auth.ts", line: null, symbol: null });
  });

  test("path with line", () => {
    expect(parseAnchorSpec("src/auth.ts:42")).toEqual({ path: "src/auth.ts", line: 42, symbol: null });
  });

  test("path with symbol", () => {
    expect(parseAnchorSpec("src/auth.ts#refreshToken")).toEqual({
      path: "src/auth.ts",
      line: null,
      symbol: "refreshToken",
    });
  });

  test("path with line and symbol", () => {
    expect(parseAnchorSpec("src/auth.ts:42#refreshToken")).toEqual({
      path: "src/auth.ts",
      line: 42,
      symbol: "refreshToken",
    });
  });

  test("normalizes separators and a leading ./", () => {
    expect(parseAnchorSpec("./src\\shared//auth.ts").path).toBe("src/shared/auth.ts");
  });

  test("a numeric-looking filename is not mistaken for a line", () => {
    expect(parseAnchorSpec("migrations/001")).toEqual({ path: "migrations/001", line: null, symbol: null });
  });

  test("rejects an empty path", () => {
    expect(() => parseAnchorSpec("   ")).toThrow(/path is empty/);
  });

  test("rejects a zero line", () => {
    expect(() => parseAnchorSpec("src/auth.ts:0")).toThrow(/positive integer/);
  });

  test("accepts an already-parsed spec", () => {
    expect(toAnchorSpec({ path: "./src/auth.ts", line: 7, symbol: " login " })).toEqual({
      path: "src/auth.ts",
      line: 7,
      symbol: "login",
    });
  });
});

describe("anchor path resolution", () => {
  test("resolves inside the root", () => {
    expect(resolveAnchorPath("/repo", "src/auth.ts")).toBe("/repo/src/auth.ts");
  });

  test("refuses to escape the root", () => {
    expect(resolveAnchorPath("/repo", "../secrets.env")).toBeNull();
    expect(resolveAnchorPath("/repo", "src/../../secrets.env")).toBeNull();
    expect(resolveAnchorPath("/repo", "/etc/passwd")).toBeNull();
  });

  test("refuses the root itself", () => {
    expect(resolveAnchorPath("/repo", ".")).toBeNull();
  });

  test("relativizes absolute paths back into anchor form", () => {
    expect(relativeAnchorPath("/repo", "/repo/src/auth.ts")).toBe("src/auth.ts");
    expect(relativeAnchorPath("/repo", "/elsewhere/auth.ts")).toBeNull();
  });
});

describe("reading blob ids from disk", () => {
  test("reports a missing file rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "dejavu-anchor-"));
    try {
      expect(blobShaOf(join(dir, "nope.ts"))).toEqual({ reason: "missing" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports a directory rather than hashing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "dejavu-anchor-"));
    try {
      expect(blobShaOf(dir)).toEqual({ reason: "path is a directory" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hashes a real file to the same id as gitBlobSha", () => {
    const dir = mkdtempSync(join(tmpdir(), "dejavu-anchor-"));
    try {
      const file = join(dir, "auth.ts");
      writeFileSync(file, "export const timeout = 30;\n");
      expect(blobShaOf(file)).toEqual({
        sha: gitBlobSha(new TextEncoder().encode("export const timeout = 30;\n")),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

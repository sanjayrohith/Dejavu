import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureAnchor,
  checkAnchor,
  checkAnchors,
  driftIsSuspect,
  rollupDrift,
} from "../src/anchors.ts";
import type { Anchor, AnchorState } from "../src/types.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "dejavu-drift-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "auth.ts"), "export const timeout = 30;\n");
  return dir;
}

function state(status: AnchorState["status"]): AnchorState {
  return { anchor: {} as Anchor, status, detail: "" };
}

describe("drift detection", () => {
  test("unchanged code verifies", () => {
    const root = workspace();
    const anchor = captureAnchor("src/auth.ts", { slipId: "s", root });
    expect(checkAnchor(anchor, root).status).toBe("verified");
  });

  test("edited code drifts", () => {
    const root = workspace();
    const anchor = captureAnchor("src/auth.ts", { slipId: "s", root });
    writeFileSync(join(root, "src", "auth.ts"), "export const timeout = 60;\n");
    const checked = checkAnchor(anchor, root);
    expect(checked.status).toBe("drifted");
    expect(checked.detail).toContain("changed since this was written");
  });

  test("reverted code verifies again", () => {
    const root = workspace();
    const anchor = captureAnchor("src/auth.ts", { slipId: "s", root });
    writeFileSync(join(root, "src", "auth.ts"), "export const timeout = 60;\n");
    expect(checkAnchor(anchor, root).status).toBe("drifted");
    writeFileSync(join(root, "src", "auth.ts"), "export const timeout = 30;\n");
    expect(checkAnchor(anchor, root).status).toBe("verified");
  });

  test("a touched but unmodified file still verifies", () => {
    const root = workspace();
    const anchor = captureAnchor("src/auth.ts", { slipId: "s", root });
    // Rewriting identical bytes changes mtime but not content. Content is
    // the signal; a checkout or a formatter no-op must not read as drift.
    writeFileSync(join(root, "src", "auth.ts"), "export const timeout = 30;\n");
    expect(checkAnchor(anchor, root).status).toBe("verified");
  });

  test("deleted code is orphaned", () => {
    const root = workspace();
    const anchor = captureAnchor("src/auth.ts", { slipId: "s", root });
    rmSync(join(root, "src", "auth.ts"));
    const checked = checkAnchor(anchor, root);
    expect(checked.status).toBe("orphaned");
    expect(checked.detail).toContain("no longer exists");
  });

  test("an anchor pointing outside the root is unknown, not orphaned", () => {
    const root = workspace();
    const escaped: Anchor = {
      slipId: "s",
      path: "../outside.ts",
      line: null,
      symbol: null,
      blobSha: "0".repeat(40),
      commit: null,
      createdAt: Date.now(),
    };
    // "Cannot be checked" and "was deleted" are different claims. Only the
    // second one should make an agent distrust the memory.
    const checked = checkAnchor(escaped, root);
    expect(checked.status).toBe("unknown");
    expect(checked.detail).toContain("outside");
  });

  test("an identical file at another root verifies — the blob is the identity", () => {
    const root = workspace();
    const anchor = captureAnchor("src/auth.ts", { slipId: "s", root });
    const clone = mkdtempSync(join(tmpdir(), "dejavu-clone-"));
    dirs.push(clone);
    mkdirSync(join(clone, "src"), { recursive: true });
    writeFileSync(join(clone, "src", "auth.ts"), "export const timeout = 30;\n");
    expect(checkAnchor(anchor, clone).status).toBe("verified");
  });

  test("hashes each distinct file once per batch", () => {
    const root = workspace();
    const a = captureAnchor("src/auth.ts#login", { slipId: "s", root });
    const b = captureAnchor("src/auth.ts#logout", { slipId: "s", root });
    expect(checkAnchors([a, b], root).map((s) => s.status)).toEqual(["verified", "verified"]);
  });
});

describe("rollup", () => {
  test("an unanchored slip has no verdict at all", () => {
    expect(rollupDrift([])).toBeNull();
  });

  test("all-verified stays verified", () => {
    expect(rollupDrift([state("verified"), state("verified")])).toBe("verified");
  });

  test("orphaned outranks drifted", () => {
    expect(rollupDrift([state("verified"), state("drifted"), state("orphaned")])).toBe("orphaned");
  });

  test("drifted outranks unknown", () => {
    expect(rollupDrift([state("unknown"), state("drifted")])).toBe("drifted");
  });

  test("unknown outranks verified so nothing unverifiable reads as confirmed", () => {
    expect(rollupDrift([state("verified"), state("unknown")])).toBe("unknown");
  });

  test("only drifted and orphaned are suspect", () => {
    expect(driftIsSuspect("drifted")).toBe(true);
    expect(driftIsSuspect("orphaned")).toBe(true);
    expect(driftIsSuspect("verified")).toBe(false);
    expect(driftIsSuspect("unknown")).toBe(false);
    expect(driftIsSuspect(null)).toBe(false);
  });
});

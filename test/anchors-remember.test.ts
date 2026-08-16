import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dejavu } from "../src/index.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "dejavu-remember-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "auth.ts"), "export const timeout = 30;\n");
  writeFileSync(join(dir, "src", "billing.ts"), "export const currency = 'usd';\n");
  return dir;
}

function open(root: string): Dejavu {
  return new Dejavu({ path: ":memory:", skipGc: true, scope: "repo:test", anchorRoot: root });
}

describe("remember with anchors", () => {
  test("stores an anchor alongside the slip", () => {
    const d = open(workspace());
    const slip = d.remember("refreshToken double-refreshes inside the middleware", {
      kind: "pitfall",
      anchors: ["src/auth.ts:12#refreshToken"],
    });
    expect(d.anchorsFor(slip.id)).toMatchObject([
      { path: "src/auth.ts", line: 12, symbol: "refreshToken" },
    ]);
    d.close();
  });

  test("accepts several anchors", () => {
    const d = open(workspace());
    const slip = d.remember("billing and auth share the retry budget", {
      anchors: ["src/auth.ts", "src/billing.ts"],
    });
    expect(d.anchorsFor(slip.id).map((a) => a.path)).toEqual(["src/auth.ts", "src/billing.ts"]);
    d.close();
  });

  test("a bad anchor throws and writes no slip at all", () => {
    const d = open(workspace());
    expect(() =>
      d.remember("about a file that is not there", { anchors: ["src/ghost.ts"] }),
    ).toThrow(/does not exist/);
    // The failure must not leave a memory that looks precise and is not.
    expect(d.listSession()).toEqual([]);
    d.close();
  });

  test("an escaping anchor throws and writes no slip at all", () => {
    const d = open(workspace());
    expect(() => d.remember("escape attempt", { anchors: ["../../etc/passwd"] })).toThrow(
      /outside the repository root/,
    );
    expect(d.listSession()).toEqual([]);
    d.close();
  });

  test("unanchored remember is unchanged", () => {
    const d = open(workspace());
    const slip = d.remember("an ordinary memory");
    expect(d.anchorsFor(slip.id)).toEqual([]);
    expect(slip.state).toBe("draft");
    d.close();
  });

  test("anchors survive the draft-to-kept promotion", () => {
    const d = open(workspace());
    const slip = d.remember("keep me", { anchors: ["src/auth.ts"] });
    d.keep([slip.id]);
    expect(d.anchorsFor(slip.id)).toHaveLength(1);
    d.close();
  });
});

describe("anchor states", () => {
  test("report verified while the code is untouched", () => {
    const root = workspace();
    const d = open(root);
    const slip = d.remember("about auth", { anchors: ["src/auth.ts"] });
    expect(d.anchorStates(slip.id).map((s) => s.status)).toEqual(["verified"]);
    d.close();
  });

  test("report drifted once the code changes", () => {
    const root = workspace();
    const d = open(root);
    const slip = d.remember("about auth", { anchors: ["src/auth.ts"] });
    writeFileSync(join(root, "src", "auth.ts"), "export const timeout = 90;\n");
    expect(d.anchorStates(slip.id).map((s) => s.status)).toEqual(["drifted"]);
    d.close();
  });

  test("report orphaned once the code is deleted", () => {
    const root = workspace();
    const d = open(root);
    const slip = d.remember("about billing", { anchors: ["src/billing.ts"] });
    rmSync(join(root, "src", "billing.ts"));
    expect(d.anchorStates(slip.id).map((s) => s.status)).toEqual(["orphaned"]);
    d.close();
  });

  test("an unanchored slip has no states", () => {
    const d = open(workspace());
    const slip = d.remember("no anchors here");
    expect(d.anchorStates(slip.id)).toEqual([]);
    d.close();
  });
});

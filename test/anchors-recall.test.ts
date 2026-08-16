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
  const dir = mkdtempSync(join(tmpdir(), "dejavu-recall-anchor-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "auth.ts"), "export const timeout = 30;\n");
  writeFileSync(join(dir, "src", "billing.ts"), "export const currency = 'usd';\n");
  return dir;
}

function open(root: string, extra: Record<string, unknown> = {}): Dejavu {
  return new Dejavu({
    path: ":memory:",
    skipGc: true,
    scope: "repo:test",
    anchorRoot: root,
    ...extra,
  });
}

describe("recall drift labelling", () => {
  test("an unchanged anchor recalls as verified", () => {
    const d = open(workspace());
    d.keep([d.remember("middleware double-refreshes the token", { anchors: ["src/auth.ts"] }).id]);
    const hit = d.recall("middleware token").hits[0]!;
    expect(hit.drift).toBe("verified");
    expect(hit.anchors?.[0]?.anchor.path).toBe("src/auth.ts");
    d.close();
  });

  test("editing the anchored file makes the memory drift", () => {
    const root = workspace();
    const d = open(root);
    d.keep([d.remember("middleware double-refreshes the token", { anchors: ["src/auth.ts"] }).id]);
    writeFileSync(join(root, "src", "auth.ts"), "export const timeout = 90;\n// rewritten\n");
    const hit = d.recall("middleware token").hits[0]!;
    expect(hit.drift).toBe("drifted");
    expect(hit.anchors?.[0]?.detail).toContain("src/auth.ts");
    d.close();
  });

  test("deleting the anchored file orphans the memory", () => {
    const root = workspace();
    const d = open(root);
    d.keep([d.remember("billing currency is fixed", { anchors: ["src/billing.ts"] }).id]);
    rmSync(join(root, "src", "billing.ts"));
    expect(d.recall("billing currency").hits[0]!.drift).toBe("orphaned");
    d.close();
  });

  test("the worst anchor wins when a slip spans several files", () => {
    const root = workspace();
    const d = open(root);
    d.keep([
      d.remember("retry budget is shared", { anchors: ["src/auth.ts", "src/billing.ts"] }).id,
    ]);
    rmSync(join(root, "src", "billing.ts"));
    const hit = d.recall("retry budget").hits[0]!;
    expect(hit.drift).toBe("orphaned");
    expect(hit.anchors?.map((a) => a.status).sort()).toEqual(["orphaned", "verified"]);
    d.close();
  });

  test("unanchored slips are not annotated at all", () => {
    const d = open(workspace());
    d.keep([d.remember("an ordinary decision about tooling").id]);
    const hit = d.recall("tooling decision").hits[0]!;
    expect(hit.drift).toBeUndefined();
    expect(hit.anchors).toBeUndefined();
    d.close();
  });

  test("drift does not change relevance, trust, or ordering", () => {
    const root = workspace();
    const d = open(root);
    d.keep([d.remember("auth timeout note", { anchors: ["src/auth.ts"] }).id]);
    const before = d.recall("auth timeout");
    writeFileSync(join(root, "src", "auth.ts"), "export const timeout = 5;\n");
    const after = d.recall("auth timeout");
    // Drift is a label the agent reads, not a ranking input.
    expect(after.hits.map((h) => h.slip.id)).toEqual(before.hits.map((h) => h.slip.id));
    expect(after.hits[0]!.trust).toBe(before.hits[0]!.trust);
    expect(after.hits[0]!.score).toBe(before.hits[0]!.score);
    d.close();
  });

  test("checking can be disabled per call", () => {
    const d = open(workspace());
    d.keep([d.remember("auth timeout note", { anchors: ["src/auth.ts"] }).id]);
    expect(d.recall("auth timeout", { checkAnchorDrift: false }).hits[0]!.drift).toBeUndefined();
    d.close();
  });

  test("checking can be disabled for the whole instance", () => {
    const d = open(workspace(), { checkAnchorDrift: false });
    d.keep([d.remember("auth timeout note", { anchors: ["src/auth.ts"] }).id]);
    expect(d.recall("auth timeout").hits[0]!.drift).toBeUndefined();
    d.close();
  });

  test("the empty-query recents packet is labelled too", () => {
    const root = workspace();
    const d = open(root);
    d.keep([d.remember("auth timeout note", { anchors: ["src/auth.ts"] }).id]);
    rmSync(join(root, "src", "auth.ts"));
    expect(d.recall("").hits[0]!.drift).toBe("orphaned");
    d.close();
  });

  test("only budgeted hits are checked", () => {
    const root = workspace();
    const d = open(root);
    for (let i = 0; i < 5; i += 1) {
      d.keep([d.remember(`auth note number ${i}`, { anchors: ["src/auth.ts"] }).id]);
    }
    const result = d.recall("auth note", { maxTokens: 60 });
    // The budget cut the packet down; everything returned still carries a verdict.
    expect(result.hits.length).toBeLessThan(5);
    expect(result.hits.every((h) => h.drift === "verified")).toBe(true);
    d.close();
  });
});

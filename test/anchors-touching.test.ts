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
  const dir = mkdtempSync(join(tmpdir(), "dejavu-touching-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "auth.ts"), "export const timeout = 30;\n");
  writeFileSync(join(dir, "src", "billing.ts"), "export const currency = 'usd';\n");
  writeFileSync(join(dir, "src", "ui.ts"), "export const theme = 'dark';\n");
  return dir;
}

function open(root: string): Dejavu {
  return new Dejavu({ path: ":memory:", skipGc: true, scope: "repo:test", anchorRoot: root });
}

describe("touching", () => {
  test("finds memory anchored to a file with no query at all", () => {
    const d = open(workspace());
    d.keep([d.remember("refreshToken double-refreshes here", { anchors: ["src/auth.ts"] }).id]);
    d.keep([d.remember("currency is hardcoded", { anchors: ["src/billing.ts"] }).id]);

    const result = d.touching(["src/auth.ts"]);
    expect(result.hits.map((h) => h.slip.text)).toEqual(["refreshToken double-refreshes here"]);
    d.close();
  });

  test("accepts several paths, as a diff would supply", () => {
    const d = open(workspace());
    d.keep([d.remember("auth note", { anchors: ["src/auth.ts"] }).id]);
    d.keep([d.remember("billing note", { anchors: ["src/billing.ts"] }).id]);
    d.keep([d.remember("ui note", { anchors: ["src/ui.ts"] }).id]);

    const result = d.touching(["src/auth.ts", "src/billing.ts"]);
    expect(result.hits.map((h) => h.slip.text).sort()).toEqual(["auth note", "billing note"]);
    d.close();
  });

  test("accepts absolute paths and normalizes them", () => {
    const root = workspace();
    const d = open(root);
    d.keep([d.remember("auth note", { anchors: ["src/auth.ts"] }).id]);

    const result = d.touching([join(root, "src", "auth.ts")]);
    expect(result.paths).toEqual(["src/auth.ts"]);
    expect(result.hits).toHaveLength(1);
    d.close();
  });

  test("ignores paths outside the repository", () => {
    const d = open(workspace());
    d.keep([d.remember("auth note", { anchors: ["src/auth.ts"] }).id]);

    const result = d.touching(["/etc/passwd", "../elsewhere.ts"]);
    expect(result.paths).toEqual([]);
    expect(result.hits).toEqual([]);
    d.close();
  });

  test("dedupes repeated paths", () => {
    const root = workspace();
    const d = open(root);
    d.keep([d.remember("auth note", { anchors: ["src/auth.ts"] }).id]);

    const result = d.touching(["src/auth.ts", "./src/auth.ts", join(root, "src/auth.ts")]);
    expect(result.paths).toEqual(["src/auth.ts"]);
    expect(result.hits).toHaveLength(1);
    d.close();
  });

  test("carries drift, since memory about a file you are editing is the likeliest to be stale", () => {
    const root = workspace();
    const d = open(root);
    d.keep([d.remember("auth note", { anchors: ["src/auth.ts"] }).id]);
    writeFileSync(join(root, "src", "auth.ts"), "export const timeout = 1;\n");

    expect(d.touching(["src/auth.ts"]).hits[0]!.drift).toBe("drifted");
    d.close();
  });

  test("follows supersession to current truth, like recall", () => {
    const d = open(workspace());
    const old = d.remember("timeout is 30 seconds", { anchors: ["src/auth.ts"] });
    d.keep([old.id]);
    const current = d.remember("timeout is 90 seconds", {
      anchors: ["src/auth.ts"],
      links: [{ toId: old.id, kind: "supersedes" }],
    });
    d.keep([current.id]);

    const result = d.touching(["src/auth.ts"]);
    expect(result.hits.map((h) => h.slip.id)).toEqual([current.id]);
    d.close();
  });

  test("does not return expired memory", () => {
    const d = open(workspace());
    const slip = d.remember("auth note", { anchors: ["src/auth.ts"] });
    d.keep([slip.id]);
    d.forget(slip.id);
    expect(d.touching(["src/auth.ts"]).hits).toEqual([]);
    d.close();
  });

  test("carries trust from usage evidence, not from the anchor", () => {
    const d = open(workspace());
    const slip = d.remember("auth note", { anchors: ["src/auth.ts"] });
    d.keep([slip.id]);
    expect(d.touching(["src/auth.ts"]).hits[0]!.trust).toBe("medium");
    d.used(slip.id);
    d.used(slip.id);
    expect(d.touching(["src/auth.ts"]).hits[0]!.trust).toBe("high");
    d.close();
  });

  test("leaves a recall receipt so reverse lookup shows up in the quality report", () => {
    const d = open(workspace());
    d.keep([d.remember("auth note", { anchors: ["src/auth.ts"] }).id]);

    const result = d.touching(["src/auth.ts"]);
    expect(result.traceId).toBeTruthy();
    expect(d.assessRecall(result.traceId!, "useful")).toBe(true);
    expect(d.recallReport().useful).toBe(1);
    d.close();
  });

  test("an empty path list returns nothing", () => {
    const d = open(workspace());
    d.keep([d.remember("auth note", { anchors: ["src/auth.ts"] }).id]);
    expect(d.touching([]).hits).toEqual([]);
    d.close();
  });

  test("a file nobody wrote about returns nothing", () => {
    const d = open(workspace());
    d.keep([d.remember("auth note", { anchors: ["src/auth.ts"] }).id]);
    expect(d.touching(["src/ui.ts"]).hits).toEqual([]);
    d.close();
  });
});

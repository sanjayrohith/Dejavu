import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dejavu } from "../src/index.ts";
import { formatRecall, formatTouching } from "../src/format.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "dejavu-format-anchor-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "auth.ts"), "export const timeout = 30;\n");
  writeFileSync(join(dir, "src", "billing.ts"), "export const currency = 'usd';\n");
  return dir;
}

function open(root: string): Dejavu {
  return new Dejavu({ path: ":memory:", skipGc: true, scope: "repo:test", anchorRoot: root });
}

describe("recall formatting", () => {
  test("names the anchored file and says the code is unchanged", () => {
    const d = open(workspace());
    d.keep([
      d.remember("refreshToken double-refreshes in the middleware", {
        anchors: ["src/auth.ts:12#refreshToken"],
      }).id,
    ]);
    const out = formatRecall(d.recall("refreshToken middleware"), d.storage);
    expect(out).toContain("code unchanged");
    expect(out).toContain("src/auth.ts#refreshToken — verified");
    d.close();
  });

  test("tells the agent to verify when the code changed", () => {
    const root = workspace();
    const d = open(root);
    d.keep([d.remember("timeout is 30 seconds", { anchors: ["src/auth.ts"] }).id]);
    writeFileSync(join(root, "src", "auth.ts"), "export const timeout = 90;\n");
    const out = formatRecall(d.recall("timeout seconds"), d.storage);
    expect(out).toContain("CODE CHANGED — verify before relying on this");
    expect(out).toContain("src/auth.ts — drifted");
    d.close();
  });

  test("says the code was deleted when it was", () => {
    const root = workspace();
    const d = open(root);
    d.keep([d.remember("currency is hardcoded", { anchors: ["src/billing.ts"] }).id]);
    rmSync(join(root, "src", "billing.ts"));
    const out = formatRecall(d.recall("currency hardcoded"), d.storage);
    expect(out).toContain("CODE DELETED");
    expect(out).toContain("src/billing.ts — orphaned");
    d.close();
  });

  test("unanchored memory renders exactly as before", () => {
    const d = open(workspace());
    d.keep([d.remember("we chose bun for repository scripts").id]);
    const out = formatRecall(d.recall("bun repository scripts"), d.storage);
    expect(out).not.toContain("anchors:");
    expect(out).not.toContain("code unchanged");
    expect(out).toContain("we chose bun for repository scripts");
    d.close();
  });
});

describe("touching formatting", () => {
  test("leads with memory about code that has since changed", () => {
    const root = workspace();
    const d = open(root);
    d.keep([d.remember("stable note about billing", { anchors: ["src/billing.ts"] }).id]);
    d.keep([d.remember("stale note about auth", { anchors: ["src/auth.ts"] }).id]);
    writeFileSync(join(root, "src", "auth.ts"), "export const timeout = 90;\n");

    const out = formatTouching(d.touching(["src/auth.ts", "src/billing.ts"]), d.storage);
    expect(out).toContain("1 about code that has since changed");
    expect(out.indexOf("stale note about auth")).toBeLessThan(out.indexOf("stable note about billing"));
    d.close();
  });

  test("says so plainly when everything still matches", () => {
    const d = open(workspace());
    d.keep([d.remember("auth note", { anchors: ["src/auth.ts"] }).id]);
    const out = formatTouching(d.touching(["src/auth.ts"]), d.storage);
    expect(out).toContain("all still matching the code");
    d.close();
  });

  test("suggests anchoring when a file has no memory yet", () => {
    const d = open(workspace());
    const out = formatTouching(d.touching(["src/auth.ts"]), d.storage);
    expect(out).toContain("no memory anchored to these files");
    expect(out).toContain('anchors: ["src/auth.ts"]');
    d.close();
  });

  test("reports when no usable path was given", () => {
    const d = open(workspace());
    const out = formatTouching(d.touching(["/etc/passwd"]), d.storage);
    expect(out).toContain("no repository-relative paths given");
    d.close();
  });
});

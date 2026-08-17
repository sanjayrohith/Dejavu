import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dejavu } from "../src/index.ts";
import { formatOrientation } from "../src/format.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "dejavu-orientation-format-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "auth.ts"), "export const timeout = 30;\n");
  return dir;
}

function open(root: string): Dejavu {
  return new Dejavu({
    path: ":memory:",
    skipGc: true,
    scope: "repo:test",
    anchorRoot: root,
    sessionId: "session-a",
    noChainRollup: true,
  });
}

function keep(d: Dejavu, text: string, opts: Parameters<Dejavu["remember"]>[1] = {}): string {
  const slip = d.remember(text, opts);
  d.keep([slip.id]);
  return slip.id;
}

describe("rendering the orientation packet", () => {
  test("states the branch and the files this session is changing", () => {
    const d = open(workspace());
    const rendered = formatOrientation(
      d.orientation({ paths: ["src/auth.ts"], branch: "feature/login" }),
    );
    expect(rendered).toContain("branch feature/login");
    expect(rendered).toContain("1 changed file(s)");
    expect(rendered).toContain("- src/auth.ts");
    d.close();
  });

  test("says the tree is clean rather than staying silent about it", () => {
    const d = open(workspace());
    const rendered = formatOrientation(d.orientation({ paths: [], branch: "main" }));
    expect(rendered).toContain("working tree clean");
    d.close();
  });

  test("claims nothing about a working tree it could not read", () => {
    const d = open(workspace()); // a plain directory, not a checkout
    const rendered = formatOrientation(d.orientation());
    expect(rendered).not.toContain("working tree clean");
    expect(rendered).not.toContain("changed file(s)");
    d.close();
  });

  test("labels each section so an agent can skim rather than read", () => {
    const root = workspace();
    const d = open(root);
    keep(d, "refreshToken double-refreshes in the middleware", {
      kind: "pitfall",
      anchors: ["src/auth.ts"],
    });
    keep(d, "currently blocked on the canary rollout", { kind: "wip" });
    keep(d, "always deploy with wrangler", { kind: "decision" });

    const rendered = formatOrientation(d.orientation({ paths: ["src/auth.ts"] }), d.storage);
    expect(rendered).toContain("# hazards");
    expect(rendered).toContain("# active work");
    expect(rendered).toContain("# must know");
    expect(rendered).toContain("override generic best practice");
    d.close();
  });

  test("counts the hazards whose code has since changed", () => {
    const root = workspace();
    const d = open(root);
    keep(d, "a note about auth that is about to go stale", {
      kind: "pitfall",
      anchors: ["src/auth.ts"],
    });
    writeFileSync(join(root, "src", "auth.ts"), "export const timeout = 90;\n// rewritten\n");

    const rendered = formatOrientation(d.orientation({ paths: ["src/auth.ts"] }));
    expect(rendered).toContain("1 about code that has since changed");
    expect(rendered).toContain("CODE CHANGED");
    d.close();
  });

  test("carries the handoff, its age, and its next steps", () => {
    const d = open(workspace());
    d.handoff({ summary: "auth refactor implemented but not deployed", next: ["deploy canary"] });

    const rendered = formatOrientation(d.orientation({ paths: [] }));
    expect(rendered).toContain("active handoff");
    expect(rendered).toContain("auth refactor implemented but not deployed");
    expect(rendered).toContain("- deploy canary");
    d.close();
  });

  test("omits sections that have nothing in them", () => {
    const d = open(workspace());
    keep(d, "always deploy with wrangler", { kind: "decision" });

    const rendered = formatOrientation(d.orientation({ paths: [] }));
    expect(rendered).toContain("# must know");
    expect(rendered).not.toContain("# hazards");
    expect(rendered).not.toContain("# active work");
    d.close();
  });

  test("an empty repository says so instead of inventing a packet", () => {
    const d = open(workspace());
    const rendered = formatOrientation(d.orientation({ paths: [] }));
    expect(rendered).toContain("nothing kept yet");
    d.close();
  });

  test("presents memory the same way recall does — trust, provenance, anchors", () => {
    const root = workspace();
    const d = open(root);
    const id = keep(d, "refreshToken double-refreshes in the middleware", {
      kind: "pitfall",
      anchors: ["src/auth.ts"],
    });

    const rendered = formatOrientation(d.orientation({ paths: ["src/auth.ts"] }), d.storage);
    expect(rendered).toContain("**[medium — kept, not yet confirmed]**");
    expect(rendered).toContain(id);
    expect(rendered).toContain("· pitfall");
    expect(rendered).toContain("scope: repo:test");
    expect(rendered).toContain("anchors: src/auth.ts — verified");
    d.close();
  });

  test("shows the receipt so the retrieval can be assessed afterwards", () => {
    const d = open(workspace());
    keep(d, "always deploy with wrangler", { kind: "decision" });
    const packet = d.orientation({ paths: [] });
    expect(formatOrientation(packet)).toContain(`# recall receipt ${packet.traceId}`);
    d.close();
  });

  test("notes when the diff was longer than the packet could carry", () => {
    const d = open(workspace());
    const rendered = formatOrientation({
      ...d.orientation({ paths: ["src/auth.ts"], branch: "main" }),
      pathsTruncated: true,
    });
    expect(rendered).toContain("truncated");
    d.close();
  });
});

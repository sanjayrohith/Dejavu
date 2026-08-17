import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dejavu, estimateTokens } from "../src/index.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "dejavu-orientation-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "auth.ts"), "export const timeout = 30;\n");
  writeFileSync(join(dir, "src", "billing.ts"), "export const currency = 'usd';\n");
  return dir;
}

/**
 * Paths are passed explicitly throughout, so these fixtures never depend
 * on a real checkout. Reading the tree itself is covered in
 * `worktree.test.ts`; what matters here is what gets composed from it.
 */
function open(root: string, sessionId = "session-a"): Dejavu {
  return new Dejavu({
    path: ":memory:",
    skipGc: true,
    scope: "repo:test",
    anchorRoot: root,
    sessionId,
    noChainRollup: true,
  });
}

function keep(d: Dejavu, text: string, opts: Parameters<Dejavu["remember"]>[1] = {}): string {
  const slip = d.remember(text, opts);
  d.keep([slip.id]);
  return slip.id;
}

describe("orientation sections", () => {
  test("memory anchored to the changed files leads the packet", () => {
    const root = workspace();
    const d = open(root);
    const hazard = keep(d, "refreshToken double-refreshes in the middleware", {
      kind: "pitfall",
      anchors: ["src/auth.ts"],
    });
    keep(d, "we use bun for repository scripts", { kind: "decision" });

    const packet = d.orientation({ paths: ["src/auth.ts"] });
    expect(packet.hazards.map((hit) => hit.slip.id)).toEqual([hazard]);
    expect(packet.mustKnow.map((hit) => hit.slip.text)).toContain("we use bun for repository scripts");
    d.close();
  });

  test("a slip claimed by hazards is not repeated in a later section", () => {
    const root = workspace();
    const d = open(root);
    const id = keep(d, "the auth decision lives in this file", {
      kind: "decision",
      anchors: ["src/auth.ts"],
    });

    const packet = d.orientation({ paths: ["src/auth.ts"] });
    expect(packet.hazards.map((hit) => hit.slip.id)).toEqual([id]);
    expect(packet.mustKnow.map((hit) => hit.slip.id)).not.toContain(id);
    d.close();
  });

  test("drifted memory is ranked ahead of memory whose code still matches", () => {
    const root = workspace();
    const d = open(root);
    keep(d, "billing note that still matches its code", {
      kind: "fact",
      anchors: ["src/billing.ts"],
    });
    const drifted = keep(d, "auth note whose code has since moved", {
      kind: "fact",
      anchors: ["src/auth.ts"],
    });
    writeFileSync(join(root, "src", "auth.ts"), "export const timeout = 90;\n// rewritten\n");

    const packet = d.orientation({ paths: ["src/auth.ts", "src/billing.ts"] });
    expect(packet.hazards[0]!.slip.id).toBe(drifted);
    expect(packet.hazards[0]!.drift).toBe("drifted");
    d.close();
  });

  test("open work is separated from durable decisions", () => {
    const root = workspace();
    const d = open(root);
    keep(d, "currently blocked on the canary rollout", { kind: "wip" });
    keep(d, "the team prefers tabs over spaces", { kind: "preference" });

    const packet = d.orientation({ paths: [] });
    expect(packet.activeWork.map((hit) => hit.slip.kind)).toEqual(["wip"]);
    expect(packet.mustKnow.map((hit) => hit.slip.kind)).toEqual(["preference"]);
    d.close();
  });

  test("plain notes and facts stay out of must-know", () => {
    const root = workspace();
    const d = open(root);
    keep(d, "an incidental observation", { kind: "note" });
    keep(d, "a verified but incidental finding", { kind: "fact" });
    keep(d, "we chose Vitest over Jest", { kind: "decision" });

    const packet = d.orientation({ paths: [] });
    expect(packet.mustKnow.map((hit) => hit.slip.text)).toEqual(["we chose Vitest over Jest"]);
    d.close();
  });

  test("must-know is ordered by trust, not by what was kept last", () => {
    const root = workspace();
    const d = open(root);
    const proven = keep(d, "always deploy with wrangler, never the dashboard", { kind: "decision" });
    d.used(proven);
    d.used(proven);
    keep(d, "a decision kept a moment ago", { kind: "decision" });

    const packet = d.orientation({ paths: [] });
    expect(packet.mustKnow[0]!.slip.id).toBe(proven);
    expect(packet.mustKnow[0]!.trust).toBe("high");
    d.close();
  });
});

describe("orientation budget", () => {
  test("the active handoff is paid for out of the same budget", () => {
    const root = workspace();
    const withoutHandoff = open(root, "session-a");
    for (let i = 0; i < 6; i += 1) {
      keep(withoutHandoff, `decision number ${i} with a reasonable amount of text in it`, {
        kind: "decision",
      });
    }
    const bare = withoutHandoff.orientation({ paths: [], maxTokens: 300 });
    withoutHandoff.close();

    const withHandoff = open(root, "session-b");
    for (let i = 0; i < 6; i += 1) {
      keep(withHandoff, `decision number ${i} with a reasonable amount of text in it`, {
        kind: "decision",
      });
    }
    withHandoff.handoff({ summary: "x".repeat(600), next: ["verify the canary"] });
    const withCost = withHandoff.orientation({ paths: [], maxTokens: 300 });

    expect(withCost.activeHandoff).not.toBeNull();
    expect(withCost.mustKnow.length).toBeLessThan(bare.mustKnow.length);
    withHandoff.close();
  });

  test("hazards win the budget ahead of the lower-priority sections", () => {
    const root = workspace();
    const d = open(root);
    const hazardText = "a hazard about the file being edited right now";
    keep(d, hazardText, { kind: "pitfall", anchors: ["src/auth.ts"] });
    for (let i = 0; i < 6; i += 1) {
      keep(d, `durable decision ${i} that would otherwise fill the packet`, { kind: "decision" });
    }

    // Exactly enough room for the hazard and nothing after it.
    const packet = d.orientation({
      paths: ["src/auth.ts"],
      maxTokens: estimateTokens(hazardText),
    });
    expect(packet.hazards).toHaveLength(1);
    expect(packet.activeWork).toHaveLength(0);
    expect(packet.mustKnow).toHaveLength(0);
    d.close();
  });

  test("the hit limit covers every section combined", () => {
    const root = workspace();
    const d = open(root);
    keep(d, "hazard about auth", { kind: "pitfall", anchors: ["src/auth.ts"] });
    keep(d, "currently mid-migration", { kind: "wip" });
    for (let i = 0; i < 5; i += 1) keep(d, `decision ${i}`, { kind: "decision" });

    const packet = d.orientation({ paths: ["src/auth.ts"], limit: 3 });
    const total = packet.hazards.length + packet.activeWork.length + packet.mustKnow.length;
    expect(total).toBe(3);
    d.close();
  });
});

describe("orientation outside a working tree", () => {
  test("an unreadable tree still produces the non-hazard sections", () => {
    const root = workspace(); // a plain directory, not a checkout
    const d = open(root);
    keep(d, "we use bun for repository scripts", { kind: "decision" });

    const packet = d.orientation();
    expect(packet.worktreeUnavailable).toBe(true);
    expect(packet.branch).toBeNull();
    expect(packet.hazards).toEqual([]);
    expect(packet.mustKnow).toHaveLength(1);
    d.close();
  });

  test("a clean tree is not the same as an unreadable one", () => {
    const d = open(workspace());
    const packet = d.orientation({ paths: [] });
    expect(packet.worktreeUnavailable).toBe(false);
    expect(packet.paths).toEqual([]);
    d.close();
  });

  test("paths outside the repository are dropped", () => {
    const d = open(workspace());
    keep(d, "a pitfall about auth", { kind: "pitfall", anchors: ["src/auth.ts"] });

    const packet = d.orientation({ paths: ["../elsewhere/secret.ts", "src/auth.ts"] });
    expect(packet.paths).toEqual(["src/auth.ts"]);
    d.close();
  });

  test("an empty database orients to an empty packet without failing", () => {
    const d = open(workspace());
    const packet = d.orientation({ paths: [] });
    expect(packet.activeHandoff).toBeNull();
    expect(packet.hazards).toEqual([]);
    expect(packet.activeWork).toEqual([]);
    expect(packet.mustKnow).toEqual([]);
    d.close();
  });
});

describe("orientation evidence", () => {
  test("the whole packet leaves one receipt, not one per section", () => {
    const root = workspace();
    const d = open(root);
    keep(d, "hazard about auth", { kind: "pitfall", anchors: ["src/auth.ts"] });
    keep(d, "currently mid-migration", { kind: "wip" });
    keep(d, "we use bun", { kind: "decision" });

    const before = d.storage.recentRecallTraces(50, "repo:test").length;
    const packet = d.orientation({ paths: ["src/auth.ts"] });
    const traces = d.storage.recentRecallTraces(50, "repo:test");

    expect(traces.length).toBe(before + 1);
    expect(packet.traceId).toBe(traces[0]!.id);
    expect(traces[0]!.hitIds).toHaveLength(3);
    d.close();
  });

  test("the receipt records the branch and paths but no memory text", () => {
    const root = workspace();
    const d = open(root);
    keep(d, "a pitfall nobody should be able to read from the trace", {
      kind: "pitfall",
      anchors: ["src/auth.ts"],
    });

    d.orientation({ paths: ["src/auth.ts"], branch: "feature/login" });
    const trace = d.storage.recentRecallTraces(1, "repo:test")[0]!;
    expect(trace.query).toBe("orientation:feature/login src/auth.ts");
    expect(trace.query).not.toContain("pitfall nobody");
    d.close();
  });

  test("callers handling sensitive work can still turn traces off", () => {
    const d = new Dejavu({
      path: ":memory:",
      skipGc: true,
      scope: "repo:test",
      anchorRoot: workspace(),
      recordRecallTraces: false,
    });
    expect(d.orientation({ paths: [] }).traceId).toBeNull();
    d.close();
  });
});

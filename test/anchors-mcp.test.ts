import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dejavu } from "../src/index.ts";
import { dispatch, newDispatchState } from "../src/mcp.ts";
import { _resetSessionForTesting } from "../src/lifecycle.ts";

const dirs: string[] = [];

beforeEach(() => {
  _resetSessionForTesting();
  process.env.DEJAVU_SESSION = "anchor-mcp-session";
  process.env.DEJAVU_AUTHOR = "anchor-mcp-agent";
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "dejavu-mcp-anchor-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "auth.ts"), "export const timeout = 30;\n");
  return dir;
}

function open(root: string): Dejavu {
  return new Dejavu({ path: ":memory:", skipGc: true, scope: "repo:test", anchorRoot: root });
}

describe("MCP remember with anchors", () => {
  test("anchors the memory and says so", () => {
    const d = open(workspace());
    const result = dispatch(d, newDispatchState(), "remember", {
      text: "refreshToken double-refreshes in the middleware",
      kind: "pitfall",
      keep: true,
      anchors: ["src/auth.ts#refreshToken"],
    });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("anchored to src/auth.ts");
    expect(result.text).toContain("report when that code changes");
    d.close();
  });

  test("a bad anchor is a tool error, not a silently unanchored memory", () => {
    const d = open(workspace());
    const result = dispatch(d, newDispatchState(), "remember", {
      text: "about a file that is not there",
      anchors: ["src/ghost.ts"],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("does not exist");
    expect(d.listSession()).toEqual([]);
    d.close();
  });

  test("remember without anchors is unchanged", () => {
    const d = open(workspace());
    const result = dispatch(d, newDispatchState(), "remember", { text: "an ordinary memory" });
    expect(result.text).toContain("drafted slip");
    expect(result.text).not.toContain("anchored to");
    d.close();
  });
});

describe("MCP recall reports drift", () => {
  test("warns when the anchored code changed", () => {
    const root = workspace();
    const d = open(root);
    const state = newDispatchState();
    dispatch(d, state, "remember", {
      text: "timeout is thirty seconds",
      keep: true,
      anchors: ["src/auth.ts"],
    });
    writeFileSync(join(root, "src", "auth.ts"), "export const timeout = 90;\n");

    const result = dispatch(d, state, "recall", { query: "timeout seconds" });
    expect(result.text).toContain("CODE CHANGED");
    d.close();
  });
});

describe("MCP touching", () => {
  test("finds memory by file rather than by words", () => {
    const d = open(workspace());
    const state = newDispatchState();
    dispatch(d, state, "remember", {
      text: "refreshToken double-refreshes in the middleware",
      keep: true,
      anchors: ["src/auth.ts"],
    });

    const result = dispatch(d, state, "touching", { paths: ["src/auth.ts"] });
    expect(result.text).toContain("refreshToken double-refreshes");
    expect(result.text).toContain("all still matching the code");
    d.close();
  });

  test("counts touching as a recall, so the nudge does not fire afterwards", () => {
    const d = open(workspace());
    const state = newDispatchState();
    dispatch(d, state, "touching", { paths: ["src/auth.ts"] });
    expect(state.recallSeen).toBe(true);
    d.close();
  });

  test("requires at least one path", () => {
    const d = open(workspace());
    const result = dispatch(d, newDispatchState(), "touching", { paths: [] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("paths is required");
    d.close();
  });

  test("suggests anchoring when a file has no memory", () => {
    const d = open(workspace());
    const result = dispatch(d, newDispatchState(), "touching", { paths: ["src/auth.ts"] });
    expect(result.text).toContain("no memory anchored to these files");
    d.close();
  });
});

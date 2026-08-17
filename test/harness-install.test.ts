import { describe, expect, test } from "bun:test";
import { claudeCodeHooks, mergeHooks, unmergeHooks } from "../src/harness.ts";

const COMMAND = "bun run /repo/src/cli.ts";

function hooksOf(settings: Record<string, unknown>, event: string): unknown[] {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  return hooks?.[event] ?? [];
}

describe("the hook registrations", () => {
  test("cover session start, compaction, and session end", () => {
    expect(Object.keys(claudeCodeHooks(COMMAND)).sort()).toEqual([
      "PreCompact",
      "SessionEnd",
      "SessionStart",
    ]);
  });

  test("carry no matcher, so SessionStart also fires after compaction", () => {
    // `compact` is a SessionStart source. Restricting the matcher to
    // `startup` would mean an agent never gets re-oriented once its
    // context is compacted away — the exact moment memory matters most.
    for (const groups of Object.values(claudeCodeHooks(COMMAND))) {
      for (const group of groups) expect(group.matcher).toBeUndefined();
    }
  });

  test("invoke the phase matching their event", () => {
    const hooks = claudeCodeHooks(COMMAND);
    expect(hooks.SessionStart![0]!.hooks[0]!.command).toContain("session start");
    expect(hooks.PreCompact![0]!.hooks[0]!.command).toContain("session checkpoint");
    expect(hooks.SessionEnd![0]!.hooks[0]!.command).toContain("session end");
  });

  test("keep session-exit timeouts short", () => {
    // Claude Code gives session-end hooks a 1.5s shared budget.
    const hooks = claudeCodeHooks(COMMAND);
    expect(hooks.SessionEnd![0]!.hooks[0]!.timeout).toBeLessThanOrEqual(5);
    expect(hooks.PreCompact![0]!.hooks[0]!.timeout).toBeLessThanOrEqual(5);
  });

  test("embed the command they were built with", () => {
    expect(claudeCodeHooks("bunx dejavu").SessionStart![0]!.hooks[0]!.command).toBe(
      "bunx dejavu session start --harness=claude-code",
    );
  });
});

describe("merging into existing settings", () => {
  test("installs into an empty settings file", () => {
    const merged = mergeHooks({}, claudeCodeHooks(COMMAND));
    expect(hooksOf(merged, "SessionStart")).toHaveLength(1);
  });

  test("leaves unrelated settings untouched", () => {
    const merged = mergeHooks(
      { permissions: { allow: ["Bash(ls)"] }, model: "opus" },
      claudeCodeHooks(COMMAND),
    );
    expect(merged.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(merged.model).toBe("opus");
  });

  test("preserves somebody else's hooks on the same event", () => {
    const existing = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo hello" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }],
      },
    };
    const merged = mergeHooks(existing, claudeCodeHooks(COMMAND));
    expect(hooksOf(merged, "SessionStart")).toHaveLength(2);
    expect(JSON.stringify(hooksOf(merged, "SessionStart"))).toContain("echo hello");
    expect(hooksOf(merged, "PreToolUse")).toHaveLength(1);
  });

  test("re-installing replaces rather than stacking a second copy", () => {
    const once = mergeHooks({}, claudeCodeHooks("bun run /old/cli.ts"));
    const twice = mergeHooks(once, claudeCodeHooks("bun run /new/cli.ts"));
    expect(hooksOf(twice, "SessionStart")).toHaveLength(1);
    expect(JSON.stringify(twice)).toContain("/new/cli.ts");
    expect(JSON.stringify(twice)).not.toContain("/old/cli.ts");
  });

  test("does not mutate the settings it was given", () => {
    const original: Record<string, unknown> = { hooks: { SessionStart: [] } };
    const snapshot = JSON.stringify(original);
    mergeHooks(original, claudeCodeHooks(COMMAND));
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  test("survives a hooks key of the wrong shape", () => {
    const merged = mergeHooks({ hooks: "nonsense" }, claudeCodeHooks(COMMAND));
    expect(hooksOf(merged, "SessionStart")).toHaveLength(1);
  });
});

describe("uninstalling", () => {
  test("removes what it installed", () => {
    const installed = mergeHooks({}, claudeCodeHooks(COMMAND));
    const removed = unmergeHooks(installed);
    expect(removed.hooks).toBeUndefined();
  });

  test("leaves somebody else's hooks behind", () => {
    const existing = {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hello" }] }] },
    };
    const removed = unmergeHooks(mergeHooks(existing, claudeCodeHooks(COMMAND)));
    expect(hooksOf(removed, "SessionStart")).toHaveLength(1);
    expect(JSON.stringify(removed)).toContain("echo hello");
    expect(JSON.stringify(removed)).not.toContain("dejavu");
  });

  test("leaves unrelated settings alone", () => {
    const removed = unmergeHooks(mergeHooks({ model: "opus" }, claudeCodeHooks(COMMAND)));
    expect(removed.model).toBe("opus");
  });

  test("is a no-op on settings that never had hooks", () => {
    expect(unmergeHooks({ model: "opus" })).toEqual({ model: "opus" });
  });
});

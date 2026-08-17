import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dejavu } from "../src/index.ts";
import { clearSessionPointer, writeSessionPointer } from "../src/session.ts";
import { _resetSessionForTesting } from "../src/lifecycle.ts";

const dirs: string[] = [];
const originalSession = process.env.DEJAVU_SESSION;

beforeEach(() => {
  delete process.env.DEJAVU_SESSION;
  _resetSessionForTesting();
});

afterEach(() => {
  if (originalSession === undefined) delete process.env.DEJAVU_SESSION;
  else process.env.DEJAVU_SESSION = originalSession;
  _resetSessionForTesting();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE = "repo:session-test";

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dejavu-identity-"));
  dirs.push(dir);
  return join(dir, "dejavu.db");
}

function open(path: string): Dejavu {
  return new Dejavu({ path, skipGc: true, scope: SCOPE });
}

describe("session resolution on a Dejavu instance", () => {
  test("a claimed pointer is adopted", () => {
    const path = dbPath();
    writeSessionPointer(SCOPE, "harness-session", "claude-code", { dbPath: path });
    const d = open(path);
    expect(d.sessionId).toBe("harness-session");
    d.close();
  });

  test("DEJAVU_SESSION still wins", () => {
    const path = dbPath();
    writeSessionPointer(SCOPE, "harness-session", "claude-code", { dbPath: path });
    process.env.DEJAVU_SESSION = "explicit-session";
    const d = open(path);
    expect(d.sessionId).toBe("explicit-session");
    d.close();
  });

  test("an explicit constructor option beats everything", () => {
    const path = dbPath();
    writeSessionPointer(SCOPE, "harness-session", "claude-code", { dbPath: path });
    process.env.DEJAVU_SESSION = "explicit-session";
    const d = new Dejavu({ path, skipGc: true, scope: SCOPE, sessionId: "forced-session" });
    expect(d.sessionId).toBe("forced-session");
    d.close();
  });

  test("without a pointer it falls back to the per-process id", () => {
    const path = dbPath();
    const a = open(path);
    const b = open(path);
    // Same process, no pointer: still one session, exactly as before.
    expect(a.sessionId).toBe(b.sessionId);
    a.close();
    b.close();
  });

  test("the pointer is only honoured for its own scope", () => {
    const path = dbPath();
    writeSessionPointer("repo:somewhere-else", "other-session", "claude-code", { dbPath: path });
    const d = open(path);
    expect(d.sessionId).not.toBe("other-session");
    d.close();
  });
});

describe("what shared identity actually buys", () => {
  test("two processes writing under one claim land in the same session", () => {
    const path = dbPath();
    writeSessionPointer(SCOPE, "shared-session", "claude-code", { dbPath: path });

    // Stand-in for the MCP server the agent writes through.
    const agent = open(path);
    const slip = agent.remember("work in progress on the auth refactor");
    agent.close();

    // Stand-in for a session hook running as its own command later.
    const hook = open(path);
    expect(hook.listSession().map((s) => s.id)).toContain(slip.id);
    hook.close();
  });

  test("without a shared claim the hook cannot see the agent's drafts", () => {
    const path = dbPath();
    const agent = new Dejavu({ path, skipGc: true, scope: SCOPE, sessionId: "agent-process" });
    agent.remember("work in progress on the auth refactor");
    agent.close();

    const hook = new Dejavu({ path, skipGc: true, scope: SCOPE, sessionId: "hook-process" });
    // This is the bug the pointer exists to fix, pinned so it stays fixed.
    expect(hook.listSession()).toEqual([]);
    hook.close();
  });

  test("one handoff per session holds across processes", () => {
    const path = dbPath();
    writeSessionPointer(SCOPE, "shared-session", "claude-code", { dbPath: path });

    const first = open(path);
    first.handoff({ summary: "agent signed off" });
    first.close();

    const second = open(path);
    expect(() => second.handoff({ summary: "hook tries to sign off too" })).toThrow(
      /already has a handoff/,
    );
    second.close();
  });

  test("releasing the claim starts a fresh session", () => {
    const path = dbPath();
    writeSessionPointer(SCOPE, "shared-session", "claude-code", { dbPath: path });
    const during = open(path);
    expect(during.sessionId).toBe("shared-session");
    during.close();

    clearSessionPointer(SCOPE, { dbPath: path });
    const after = open(path);
    expect(after.sessionId).not.toBe("shared-session");
    after.close();
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_POINTER_TTL_MS,
  clearSessionPointer,
  readSessionPointer,
  resolveSessionId,
  sessionStorePath,
  writeSessionPointer,
} from "../src/session.ts";
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

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dejavu-session-"));
  dirs.push(dir);
  return join(dir, "dejavu.db");
}

describe("pointer location", () => {
  test("sits beside the database, so it cannot outlive it", () => {
    expect(sessionStorePath("/data/memory/dejavu.db")).toBe("/data/memory/sessions.json");
  });

  test("an in-memory database has no pointer file", () => {
    expect(sessionStorePath(":memory:")).toBeNull();
    expect(writeSessionPointer("repo:x", "s-1", "test", { dbPath: ":memory:" })).toBeNull();
    expect(readSessionPointer("repo:x", { dbPath: ":memory:" })).toBeNull();
  });
});

describe("claiming a session", () => {
  test("round-trips", () => {
    const path = dbPath();
    writeSessionPointer("repo:alpha", "session-1", "claude-code", { dbPath: path });
    expect(readSessionPointer("repo:alpha", { dbPath: path })).toMatchObject({
      sessionId: "session-1",
      harness: "claude-code",
    });
  });

  test("is scoped — one repository's claim is invisible to another", () => {
    const path = dbPath();
    writeSessionPointer("repo:alpha", "session-alpha", "claude-code", { dbPath: path });
    expect(readSessionPointer("repo:beta", { dbPath: path })).toBeNull();
  });

  test("a second claim replaces the first", () => {
    const path = dbPath();
    writeSessionPointer("repo:alpha", "session-1", "claude-code", { dbPath: path });
    writeSessionPointer("repo:alpha", "session-2", "claude-code", { dbPath: path });
    expect(readSessionPointer("repo:alpha", { dbPath: path })?.sessionId).toBe("session-2");
  });

  test("scopes do not clobber each other", () => {
    const path = dbPath();
    writeSessionPointer("repo:alpha", "session-alpha", "claude-code", { dbPath: path });
    writeSessionPointer("repo:beta", "session-beta", "opencode", { dbPath: path });
    expect(readSessionPointer("repo:alpha", { dbPath: path })?.sessionId).toBe("session-alpha");
    expect(readSessionPointer("repo:beta", { dbPath: path })?.sessionId).toBe("session-beta");
  });

  test("releasing removes only that scope", () => {
    const path = dbPath();
    writeSessionPointer("repo:alpha", "session-alpha", "claude-code", { dbPath: path });
    writeSessionPointer("repo:beta", "session-beta", "claude-code", { dbPath: path });
    expect(clearSessionPointer("repo:alpha", { dbPath: path })).toBe(true);
    expect(readSessionPointer("repo:alpha", { dbPath: path })).toBeNull();
    expect(readSessionPointer("repo:beta", { dbPath: path })?.sessionId).toBe("session-beta");
  });

  test("releasing an unclaimed scope is a no-op, not an error", () => {
    expect(clearSessionPointer("repo:never", { dbPath: dbPath() })).toBe(false);
  });
});

describe("staleness", () => {
  test("a pointer past the TTL is ignored", () => {
    const path = dbPath();
    const now = Date.now();
    writeSessionPointer("repo:alpha", "session-old", "claude-code", {
      dbPath: path,
      now: now - SESSION_POINTER_TTL_MS - 1,
    });
    // A harness that died without cleaning up must not silently rejoin a
    // session from last week and append to a forgotten handoff.
    expect(readSessionPointer("repo:alpha", { dbPath: path, now })).toBeNull();
  });

  test("a pointer inside the TTL is honoured", () => {
    const path = dbPath();
    const now = Date.now();
    writeSessionPointer("repo:alpha", "session-recent", "claude-code", {
      dbPath: path,
      now: now - SESSION_POINTER_TTL_MS + 1000,
    });
    expect(readSessionPointer("repo:alpha", { dbPath: path, now })?.sessionId).toBe(
      "session-recent",
    );
  });

  test("writing prunes expired entries for other scopes", () => {
    const path = dbPath();
    const now = Date.now();
    writeSessionPointer("repo:old", "session-old", "claude-code", {
      dbPath: path,
      now: now - SESSION_POINTER_TTL_MS - 1,
    });
    writeSessionPointer("repo:new", "session-new", "claude-code", { dbPath: path, now });
    const raw = JSON.parse(readFileSync(sessionStorePath(path)!, "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(["repo:new"]);
  });
});

describe("damaged pointer files", () => {
  test("corrupt JSON is ignored, not fatal", () => {
    const path = dbPath();
    writeSessionPointer("repo:alpha", "session-1", "claude-code", { dbPath: path });
    writeFileSync(sessionStorePath(path)!, "{not json at all");
    expect(readSessionPointer("repo:alpha", { dbPath: path })).toBeNull();
    // And it recovers: the next claim rewrites the file.
    writeSessionPointer("repo:alpha", "session-2", "claude-code", { dbPath: path });
    expect(readSessionPointer("repo:alpha", { dbPath: path })?.sessionId).toBe("session-2");
  });

  test("entries missing required fields are skipped", () => {
    const path = dbPath();
    writeSessionPointer("repo:good", "session-good", "claude-code", { dbPath: path });
    const store = JSON.parse(readFileSync(sessionStorePath(path)!, "utf8")) as Record<string, unknown>;
    store["repo:bad"] = { harness: "claude-code" };
    store["repo:alsobad"] = "not an object";
    writeFileSync(sessionStorePath(path)!, JSON.stringify(store));
    expect(readSessionPointer("repo:bad", { dbPath: path })).toBeNull();
    expect(readSessionPointer("repo:alsobad", { dbPath: path })).toBeNull();
    expect(readSessionPointer("repo:good", { dbPath: path })?.sessionId).toBe("session-good");
  });

  test("a missing file reads as no claim", () => {
    expect(readSessionPointer("repo:alpha", { dbPath: dbPath() })).toBeNull();
  });
});

describe("resolution order", () => {
  test("DEJAVU_SESSION beats a pointer", () => {
    const path = dbPath();
    writeSessionPointer("repo:alpha", "session-from-pointer", "claude-code", { dbPath: path });
    process.env.DEJAVU_SESSION = "session-from-env";
    expect(resolveSessionId("repo:alpha", { dbPath: path })).toBe("session-from-env");
  });

  test("a pointer beats the per-process id", () => {
    const path = dbPath();
    writeSessionPointer("repo:alpha", "session-from-pointer", "claude-code", { dbPath: path });
    expect(resolveSessionId("repo:alpha", { dbPath: path })).toBe("session-from-pointer");
  });

  test("with no pointer, two calls still agree within one process", () => {
    const path = dbPath();
    expect(resolveSessionId("repo:alpha", { dbPath: path })).toBe(
      resolveSessionId("repo:alpha", { dbPath: path }),
    );
  });

  test("a stale pointer falls through to the per-process id", () => {
    const path = dbPath();
    const now = Date.now();
    writeSessionPointer("repo:alpha", "session-old", "claude-code", {
      dbPath: path,
      now: now - SESSION_POINTER_TTL_MS - 1,
    });
    expect(resolveSessionId("repo:alpha", { dbPath: path, now })).not.toBe("session-old");
  });
});

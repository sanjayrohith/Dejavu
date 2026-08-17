import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dejavu } from "../src/index.ts";
import {
  checkpoint,
  describePreserve,
  finish,
  orient,
  parseHarnessEvent,
  type HarnessEvent,
} from "../src/harness.ts";
import { readSessionPointer } from "../src/session.ts";
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

const SCOPE = "repo:harness-test";

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dejavu-harness-"));
  dirs.push(dir);
  return join(dir, "dejavu.db");
}

function open(path: string, sessionId?: string): Dejavu {
  return new Dejavu({ path, skipGc: true, scope: SCOPE, sessionId });
}

function event(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
  return {
    phase: "start",
    sessionId: null,
    cwd: null,
    harness: "test-harness",
    reason: null,
    ...overrides,
  };
}

describe("parsing harness payloads", () => {
  test("reads a Claude Code SessionStart payload", () => {
    const parsed = parseHarnessEvent(
      JSON.stringify({
        session_id: "abc-123",
        transcript_path: "/home/me/.claude/transcript.jsonl",
        cwd: "/home/me/project",
        hook_event_name: "SessionStart",
        source: "startup",
      }),
      "start",
      "claude-code",
    );
    expect(parsed).toEqual({
      phase: "start",
      sessionId: "abc-123",
      cwd: "/home/me/project",
      harness: "claude-code",
      reason: "startup",
    });
  });

  test("reads the compaction trigger", () => {
    const parsed = parseHarnessEvent(
      JSON.stringify({ session_id: "abc", hook_event_name: "PreCompact", trigger: "auto" }),
      "checkpoint",
      "claude-code",
    );
    expect(parsed.reason).toBe("auto");
  });

  test("never reads the transcript path", () => {
    // Transcript archiving as memory is an explicit project non-goal, so
    // the field must not leak into the event at all.
    const parsed = parseHarnessEvent(
      JSON.stringify({ session_id: "abc", transcript_path: "/secret/transcript.jsonl" }),
      "start",
    );
    expect(JSON.stringify(parsed)).not.toContain("transcript");
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });

  test("malformed JSON degrades instead of throwing", () => {
    // A hook that throws turns a memory feature into a broken session.
    expect(parseHarnessEvent("{not json", "start", "claude-code")).toEqual({
      phase: "start",
      sessionId: null,
      cwd: null,
      harness: "claude-code",
      reason: null,
    });
  });

  test("empty, non-object, and blank-field payloads all degrade", () => {
    expect(parseHarnessEvent("", "start").sessionId).toBeNull();
    expect(parseHarnessEvent("[1,2,3]", "start").sessionId).toBeNull();
    expect(parseHarnessEvent("null", "start").sessionId).toBeNull();
    expect(parseHarnessEvent(JSON.stringify({ session_id: "   " }), "start").sessionId).toBeNull();
    expect(parseHarnessEvent(JSON.stringify({ session_id: 42 }), "start").sessionId).toBeNull();
  });
});

describe("orientation at session start", () => {
  test("claims the harness session for this scope", () => {
    const path = dbPath();
    const d = open(path);
    orient(d, event({ sessionId: "harness-1" }));
    expect(readSessionPointer(SCOPE, { dbPath: path })).toMatchObject({
      sessionId: "harness-1",
      harness: "test-harness",
    });
    d.close();
  });

  test("hands back the prior session's handoff without the agent asking", () => {
    const path = dbPath();
    const writer = open(path, "writer-session");
    writer.handoff({ summary: "auth refactor implemented, not deployed", next: ["deploy canary"] });
    writer.close();

    const reader = open(path, "reader-session");
    const result = orient(reader, event({ sessionId: "reader-session" }));
    expect(result.handoff).toBe(true);
    expect(result.context).toContain("auth refactor implemented");
    expect(result.context).toContain("deploy canary");
    reader.close();
  });

  test("carries kept memory too", () => {
    const path = dbPath();
    const d = open(path, "prior");
    d.keep([d.remember("the deploy script needs sudo").id], { noChainRollup: true });
    d.close();

    const next = open(path, "next");
    const result = orient(next, event({ sessionId: "next" }));
    expect(result.memories).toBeGreaterThan(0);
    expect(result.context).toContain("deploy script needs sudo");
    next.close();
  });

  test("an empty repository produces no context rather than noise", () => {
    const path = dbPath();
    const d = open(path);
    const result = orient(d, event());
    expect(result.context).toBe("");
    expect(result.memories).toBe(0);
    expect(result.handoff).toBe(false);
    d.close();
  });

  test("respects a token budget", () => {
    const path = dbPath();
    const seed = open(path, "prior");
    for (let i = 0; i < 20; i += 1) {
      seed.keep([seed.remember(`memory number ${i} about the deployment pipeline`).id], {
        noChainRollup: true,
      });
    }
    seed.close();

    const d = open(path, "next");
    const small = orient(d, event({ sessionId: "next" }), { maxTokens: 120 });
    const large = orient(d, event({ sessionId: "next" }), { maxTokens: 2000 });
    expect(small.memories).toBeLessThan(large.memories);
    d.close();
  });

  test("falls back to the instance session when the harness sends none", () => {
    const path = dbPath();
    const d = open(path, "instance-session");
    expect(orient(d, event()).sessionId).toBe("instance-session");
    d.close();
  });
});

describe("preserving work at checkpoint and end", () => {
  test("promotes the session's drafts so compaction cannot lose them", () => {
    const path = dbPath();
    const d = open(path, "s1");
    d.remember("the retry budget is shared between auth and billing");
    const result = checkpoint(d, event({ phase: "checkpoint", sessionId: "s1" }));
    expect(result.promoted).toBe(1);
    expect(d.listSession().every((slip) => slip.state === "kept")).toBe(true);
    d.close();
  });

  test("rolls chain-shaped work up into a handoff the agent never wrote", () => {
    const path = dbPath();
    const d = open(path, "s1");
    d.remember("Decision: we chose bun over node for the repository scripts");
    const result = checkpoint(d, event({ phase: "checkpoint", sessionId: "s1" }));
    // This is the writer-side gap closing: the agent never called handoff.
    expect(result.handoffWritten).toBe(true);
    expect(result.handoffId).toBeTruthy();
    d.close();
  });

  test("does not disturb a handoff the agent already wrote", () => {
    const path = dbPath();
    const d = open(path, "s1");
    const written = d.handoff({ summary: "agent signed off properly" });
    const result = checkpoint(d, event({ phase: "checkpoint", sessionId: "s1" }));
    expect(result.handoffWritten).toBe(false);
    expect(result.handoffId).toBe(written.id);
    d.close();
  });

  test("invents nothing when the session wrote nothing", () => {
    const path = dbPath();
    const d = open(path, "s1");
    const result = checkpoint(d, event({ phase: "checkpoint", sessionId: "s1" }));
    expect(result).toMatchObject({ promoted: 0, kept: 0, handoffId: null, handoffWritten: false });
    d.close();
  });

  test("is idempotent — compaction can fire repeatedly", () => {
    const path = dbPath();
    const d = open(path, "s1");
    d.remember("Decision: we chose bun for the repository scripts");
    const first = checkpoint(d, event({ phase: "checkpoint", sessionId: "s1" }));
    const second = checkpoint(d, event({ phase: "checkpoint", sessionId: "s1" }));
    expect(first.promoted).toBe(1);
    expect(second.promoted).toBe(0);
    expect(second.handoffId).toBe(first.handoffId);
    d.close();
  });

  test("ending releases the session claim", () => {
    const path = dbPath();
    const d = open(path, "s1");
    orient(d, event({ sessionId: "s1" }));
    expect(readSessionPointer(SCOPE, { dbPath: path })).not.toBeNull();
    finish(d, event({ phase: "end", sessionId: "s1" }));
    expect(readSessionPointer(SCOPE, { dbPath: path })).toBeNull();
    d.close();
  });

  test("ending still preserves before releasing", () => {
    const path = dbPath();
    const d = open(path, "s1");
    d.remember("Decision: staging deploys go through wrangler");
    const result = finish(d, event({ phase: "end", sessionId: "s1" }));
    expect(result.promoted).toBe(1);
    expect(result.handoffWritten).toBe(true);
    d.close();
  });

  test("work preserved at end is what the next session is oriented with", () => {
    const path = dbPath();
    const writer = open(path, "writer");
    writer.remember("Decision: staging deploys go through wrangler, not blue-green");
    finish(writer, event({ phase: "end", sessionId: "writer" }));
    writer.close();

    // The full chain Loop 4 measured: writer never called handoff, reader
    // never called recall, and the fact still crosses the session boundary.
    const reader = open(path, "reader");
    const oriented = orient(reader, event({ sessionId: "reader" }));
    expect(oriented.context).toContain("wrangler");
    reader.close();
  });
});

describe("the report shown to the human", () => {
  test("says plainly when nothing was recorded", () => {
    const path = dbPath();
    const d = open(path, "s1");
    const result = finish(d, event({ phase: "end", sessionId: "s1" }));
    expect(describePreserve(result, "end")).toContain("nothing recorded");
    d.close();
  });

  test("flags kept memory with no continuation packet", () => {
    const path = dbPath();
    const d = open(path, "s1");
    d.keep([d.remember("a plain observation about the build").id], { noChainRollup: true });
    const result = finish(d, event({ phase: "end", sessionId: "s1" }));
    expect(describePreserve(result, "end")).toContain("no handoff");
    d.close();
  });

  test("reports the rollup when one happened", () => {
    const path = dbPath();
    const d = open(path, "s1");
    d.remember("Decision: we chose bun for the repository scripts");
    const result = checkpoint(d, event({ phase: "checkpoint", sessionId: "s1" }));
    const line = describePreserve(result, "checkpoint");
    expect(line).toContain("before compaction");
    expect(line).toContain("wrote a handoff");
    d.close();
  });
});

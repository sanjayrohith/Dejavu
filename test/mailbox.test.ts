import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { memory } from "../src/index.ts";
import { dispatch, newDispatchState } from "../src/mcp.ts";

/**
 * The mailbox derives "who am I" from DEJAVU_AUTHOR, so a test that
 * replies to a message has to know what identity it is replying as.
 * This file used to rely on another test file having set the variable
 * first, which held only while the runner happened to order them that
 * way — set it here instead.
 */
const AUTHOR = "mailbox-test-agent";
const originalAuthor = process.env.DEJAVU_AUTHOR;

beforeEach(() => {
  process.env.DEJAVU_AUTHOR = AUTHOR;
});

afterEach(() => {
  if (originalAuthor === undefined) delete process.env.DEJAVU_AUTHOR;
  else process.env.DEJAVU_AUTHOR = originalAuthor;
});

describe("mailbox", () => {
  test("send, inbox, read, reply", () => {
    const d = memory();
    const m = d.send({ from: "pi", to: "opencode", body: "review diff" });
    expect(d.inbox("opencode").map((x) => x.id)).toEqual([m.id]);
    expect(d.read(m.id)).toBe(true);
    expect(d.inbox("opencode")).toEqual([]);
    const r = d.reply(m.id, "looks good", "opencode");
    expect(r.to).toBe("pi");
    expect(r.threadId).toBe(m.threadId);
    expect(d.inbox("pi")[0]!.body).toBe("looks good");
    d.close();
  });

  test("mcp dispatch exposes send/inbox/reply", () => {
    const d = memory();
    const state = newDispatchState();
    const sent = dispatch(d, state, "send", { to: "agent-b", body: "ping" });
    expect(sent.text).toContain("sent");
    const inbox = dispatch(d, state, "inbox", { to: "agent-b" });
    expect(inbox.text).toContain("ping");
    const id = inbox.text.match(/^[0-9A-Z]{26}/)![0];
    const reply = dispatch(d, state, "reply", { id, body: "pong" });
    expect(reply.text).toContain("replied");
    // The reply is addressed back to whoever sent the original, which is
    // this process's own identity.
    expect(dispatch(d, state, "inbox", { to: AUTHOR }).text).toContain("pong");
    d.close();
  });
});

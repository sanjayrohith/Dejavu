import { describe, expect, test } from "bun:test";
import { ulid, ulidTimestamp } from "../src/ulid.ts";

describe("ulid", () => {
  test("is 26 chars", () => {
    expect(ulid().length).toBe(26);
  });

  test("encodes the supplied timestamp", () => {
    const t = 1700000000000;
    const id = ulid(t);
    expect(ulidTimestamp(id)).toBe(t);
  });

  test("is monotonically sortable by time", () => {
    const ids: string[] = [];
    let t = Date.now();
    for (let i = 0; i < 50; i++) {
      ids.push(ulid(t));
      t += 1;
    }
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  test("rejects bad input", () => {
    expect(() => ulidTimestamp("short")).toThrow();
    expect(() => ulidTimestamp("U".repeat(26))).toThrow(); // U not in alphabet
  });
});

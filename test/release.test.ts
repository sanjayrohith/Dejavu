import { describe, expect, test } from "bun:test";
import packageJson from "../package.json";
import { VERSION } from "../src/version.ts";

describe("release metadata", () => {
  test("package and runtime versions stay aligned", () => {
    expect(packageJson.version).toBe(VERSION);
  });

  test("production package includes the public release documents", () => {
    expect(packageJson.files).toEqual(expect.arrayContaining([
      "src",
      "README.md",
      "CHANGELOG.md",
      "SECURITY.md",
      "docs/ROADMAP.md",
      "docs/shared-memory.md",
      "docs/shared-memory-implementation-contract.md",
      "docs/shared-security-review.md",
      "LICENSE",
    ]));
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentMemoryContext } from "../src/context.ts";

const dirs: string[] = [];
const originalScope = process.env.DEJAVU_SCOPE;
const originalRepository = process.env.DEJAVU_REPOSITORY;

afterEach(() => {
  if (originalScope === undefined) delete process.env.DEJAVU_SCOPE;
  else process.env.DEJAVU_SCOPE = originalScope;
  if (originalRepository === undefined) delete process.env.DEJAVU_REPOSITORY;
  else process.env.DEJAVU_REPOSITORY = originalRepository;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("automatic memory context", () => {
  test("explicit scope wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "dejavu-context-"));
    dirs.push(dir);
    process.env.DEJAVU_SCOPE = "global";
    process.env.DEJAVU_REPOSITORY = "personal";
    expect(currentMemoryContext(dir)).toMatchObject({
      scope: "global",
      repository: "personal",
      source: "env",
    });
  });

  test("same origin produces the same repository scope across checkouts", () => {
    delete process.env.DEJAVU_SCOPE;
    const a = repo("alpha", "git@github.com:acme/project.git");
    const b = repo("beta", "https://github.com/acme/project");
    const contextA = currentMemoryContext(join(a, "src"));
    const contextB = currentMemoryContext(join(b, "src"));
    expect(contextA.scope).toBe(contextB.scope);
    expect(contextA.source).toBe("git-remote");
  });

  test("different remotes never share a retrieval scope", () => {
    delete process.env.DEJAVU_SCOPE;
    const a = repo("project", "https://github.com/acme/one.git");
    const b = repo("project", "https://github.com/acme/two.git");
    expect(currentMemoryContext(a).scope).not.toBe(currentMemoryContext(b).scope);
  });
});

function repo(name: string, remote: string): string {
  const parent = mkdtempSync(join(tmpdir(), "dejavu-context-"));
  dirs.push(parent);
  const root = join(parent, name);
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, ".git", "config"),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remote}\n`,
  );
  return root;
}

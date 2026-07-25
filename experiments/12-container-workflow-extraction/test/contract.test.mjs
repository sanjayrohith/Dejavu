import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function loadContract() {
  const source = await readFile(new URL("../src/contract.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

test("submission body uses customId as the retry idempotency key", async () => {
  const { extractionBody } = await loadContract();
  const marker = "exp12-contract-12345678";
  const body = extractionBody(marker);
  assert.equal(body.customId, marker);
  assert.equal(body.metadata.marker, marker);
  assert.match(body.content, new RegExp(marker));
});

test("only known Supermemory terminal states end polling", async () => {
  const { TERMINAL_STATUSES } = await loadContract();
  assert.equal(TERMINAL_STATUSES.has("queued"), false);
  assert.equal(TERMINAL_STATUSES.has("indexing"), false);
  assert.equal(TERMINAL_STATUSES.has("done"), true);
  assert.equal(TERMINAL_STATUSES.has("failed"), true);
});

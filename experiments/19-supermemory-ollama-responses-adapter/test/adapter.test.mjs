import test from "node:test";
import assert from "node:assert/strict";
import { ResponseItemCache, expandReferences } from "../scripts/adapter-core.mjs";

const calls = [
  { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{\"q\":1}", status: "completed" },
  { type: "function_call", id: "fc_2", call_id: "call_2", name: "save", arguments: "{\"v\":2}", status: "completed" }
];

test("baseline request without references is passed through by identity", () => {
  const cache = new ResponseItemCache();
  const body = { model: "qwen3-coder:30b", input: [{ role: "user", content: "synthetic" }] };
  const result = expandReferences(body, cache);
  assert.equal(result.body, body);
  assert.equal(result.expanded, 0);
});

test("item references expand in place while function_call_output and ordering are preserved", () => {
  const cache = new ResponseItemCache();
  cache.store({ id: "resp_1", output: calls });
  const output = { type: "function_call_output", call_id: "call_1", output: "synthetic result" };
  const tail = { role: "user", content: "tail" };
  const result = expandReferences({ input: [{ role: "system", content: "head" }, { type: "item_reference", id: "fc_2" }, output, tail] }, cache);
  assert.deepEqual(result.body.input, [{ role: "system", content: "head" }, calls[1], output, tail]);
  assert.equal(result.body.input[2], output);
});

test("response IDs expand to their ordered output list", () => {
  const cache = new ResponseItemCache();
  cache.store({ id: "resp_1", output: calls });
  assert.deepEqual(expandReferences({ input: [{ type: "item_reference", id: "resp_1" }] }, cache).body.input, calls);
});

test("unknown and expired references fail closed", () => {
  let now = 100;
  const cache = new ResponseItemCache({ ttlMs: 10, now: () => now });
  assert.throws(() => expandReferences({ input: [{ type: "item_reference", id: "missing" }] }, cache), { code: "unknown_reference" });
  cache.store({ id: "resp_1", output: calls });
  now = 111;
  assert.throws(() => expandReferences({ input: [{ type: "item_reference", id: "fc_1" }] }, cache), { code: "expired_reference" });
});

test("ID collisions reject the whole cache write", () => {
  const cache = new ResponseItemCache();
  cache.store({ id: "resp_1", output: calls });
  assert.throws(() => cache.store({ id: "resp_2", output: [{ ...calls[0], name: "different" }] }), { code: "reference_collision" });
  assert.equal(cache.stats().entries, 3);
});

test("bounded cache evicts least recently used IDs and fails closed", () => {
  const cache = new ResponseItemCache({ maxEntries: 2 });
  cache.store({ id: "resp_1", output: [{ type: "message", id: "msg_1", role: "assistant", content: [] }] });
  cache.store({ id: "resp_2", output: [] });
  assert.equal(cache.stats().entries, 2);
  assert.throws(() => cache.resolve("resp_1"), { code: "expired_reference" });
  assert.equal(cache.stats().evictions, 1);
});

test("small metadata-stripping normalization is explicit", () => {
  const cache = new ResponseItemCache();
  cache.store({ id: "resp_1", output: calls });
  const item = expandReferences({ input: [{ type: "item_reference", id: "fc_1" }] }, cache, { variant: "strip-output-metadata" }).body.input[0];
  assert.equal("id" in item, false);
  assert.equal("status" in item, false);
  assert.equal(item.call_id, "call_1");
});

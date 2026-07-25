import test from "node:test";
import assert from "node:assert/strict";
import { requestFeatures, responseFeatures, sanitizeProtocolText } from "../scripts/redaction.mjs";

test("evidence describes reference protocol without recording content or IDs", () => {
  const token = "ORBITAL-MANGO-741";
  const id = "item_private_123";
  const features = requestFeatures({ input: [{ type: "item_reference", id }, { type: "function_call_output", call_id: "private_call", output: token }] });
  const encoded = JSON.stringify(features);
  assert.equal(encoded.includes(token), false);
  assert.equal(encoded.includes(id), false);
  assert.equal(encoded.includes("private_call"), false);
  assert.deepEqual(features.input.map((x) => x.type), ["item_reference", "function_call_output"]);
  assert.equal(features.input[1].call_id_present, true);
});

test("response evidence records shape and digest, never output text", () => {
  const token = "ORBITAL-MANGO-741";
  const evidence = responseFeatures(200, new Headers({ "content-type": "application/json" }), JSON.stringify({ id: "private_response", output: [{ type: "message", content: token }] }));
  assert.equal(JSON.stringify(evidence).includes(token), false);
  assert.equal(JSON.stringify(evidence).includes("private_response"), false);
  assert.equal(evidence.status, 200);
});

test("protocol sanitizer redacts the synthetic token and quoted values", () => {
  const result = sanitizeProtocolText('rejected "private-id" for ORBITAL-MANGO-741');
  assert.equal(result.includes("private-id"), false);
  assert.equal(result.includes("ORBITAL-MANGO-741"), false);
});

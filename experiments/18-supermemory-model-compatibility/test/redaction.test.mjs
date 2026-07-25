import test from "node:test";
import assert from "node:assert/strict";
import { requestFeatures, responseFeatures, sanitizeFailure, sanitizeProtocolText } from "../scripts/redaction.mjs";

test("request recording preserves protocol features but not content", () => {
  const secret = "PRIVATE-PROMPT-DO-NOT-LOG";
  const features = requestFeatures({ model: "model", stream: false, messages: [{ role: "user", content: secret }], tools: [{ type: "function", function: { name: "private_name" } }], response_format: { type: "json_object" }, options: { temperature: 0 } });
  const encoded = JSON.stringify(features);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes("private_name"), false);
  assert.equal(features.tools.count, 1);
  assert.deepEqual(features.options.keys, ["temperature"]);
  assert.equal(features.response_format.type, "json_object");
  assert.deepEqual(features.top_level_keys, ["messages", "model", "options", "response_format", "stream", "tools"]);
});

test("Responses API nested format and input are described without content", () => {
  const features = requestFeatures({ model: "model", input: [{ type: "message", role: "user", content: "PRIVATE INPUT" }], text: { format: { type: "json_schema", name: "private_schema", strict: true, schema: {} } } });
  const encoded = JSON.stringify(features);
  assert.equal(encoded.includes("PRIVATE INPUT"), false);
  assert.equal(encoded.includes("private_schema"), false);
  assert.equal(features.response_format.type, "json_schema");
  assert.equal(features.input[0].type, "message");
});

test("response recording retains shape and status but not response text", () => {
  const secret = "PRIVATE-RESPONSE-DO-NOT-LOG";
  const features = responseFeatures(200, new Headers({ "content-type": "application/json" }), JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: secret } }] }));
  assert.equal(JSON.stringify(features).includes(secret), false);
  assert.equal(features.status, 200);
  assert.equal(features.choice.finish_reason, "stop");
  assert.equal(features.choice.message_content.bytes, Buffer.byteLength(secret));
});

test("failure sanitizer removes API keys and bearer credentials", () => {
  const sanitized = sanitizeFailure(new Error("bad sm_abc123 and Bearer top-secret"));
  assert.equal(sanitized.message.includes("sm_abc123"), false);
  assert.equal(sanitized.message.includes("top-secret"), false);
});

test("protocol sanitizer keeps failure class while redacting values", () => {
  const sanitized = sanitizeProtocolText('unsupported input type "private-content" for ORBITAL-MANGO-741');
  assert.match(sanitized, /unsupported input type/);
  assert.equal(sanitized.includes("private-content"), false);
  assert.equal(sanitized.includes("ORBITAL-MANGO-741"), false);
});

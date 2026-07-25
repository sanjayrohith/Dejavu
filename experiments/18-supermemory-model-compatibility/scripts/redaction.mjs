import { createHash } from "node:crypto";

export function digest(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 12);
}

export function textDescriptor(value) {
  if (typeof value !== "string") return { type: value === null ? "null" : typeof value };
  return { type: "string", bytes: Buffer.byteLength(value), sha256_12: digest(value) };
}

export function jsonShape(value, depth = 0) {
  if (depth > 4) return "depth-limit";
  if (value === null) return "null";
  if (Array.isArray(value)) return { type: "array", length: value.length, items: value.length ? jsonShape(value[0], depth + 1) : "empty" };
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().slice(0, 80).map((key) => [key, jsonShape(value[key], depth + 1)]));
  }
  return typeof value;
}

export function requestFeatures(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const input = Array.isArray(body?.input) ? body.input : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const options = body?.options && typeof body.options === "object" ? Object.keys(body.options).sort() : [];
  const responseFormat = body?.response_format ?? body?.text?.format;
  return {
    top_level_keys: Object.keys(body ?? {}).sort(),
    model: typeof body?.model === "string" ? body.model : null,
    stream: body?.stream ?? null,
    response_format: responseFormat ? {
      type: responseFormat.type ?? null,
      has_json_schema: Boolean(responseFormat.json_schema ?? responseFormat.schema),
      schema_name_sha256_12: (responseFormat.json_schema?.name ?? responseFormat.name) ? digest(responseFormat.json_schema?.name ?? responseFormat.name) : null,
      strict: responseFormat.json_schema?.strict ?? responseFormat.strict ?? null
    } : null,
    tools: { present: "tools" in (body ?? {}), count: tools.length, types: [...new Set(tools.map((x) => x?.type ?? "unknown"))], function_names_sha256_12: tools.map((x) => digest(x?.function?.name ?? x?.name ?? "")) },
    tool_choice: body?.tool_choice === undefined ? null : (typeof body.tool_choice === "string" ? body.tool_choice : jsonShape(body.tool_choice)),
    options: { present: "options" in (body ?? {}), keys: options },
    messages: messages.map((m) => ({ role: m?.role ?? null, content: textDescriptor(typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? null)), has_tool_calls: Array.isArray(m?.tool_calls), tool_call_count: m?.tool_calls?.length ?? 0 })),
    input: input.map((item) => ({ type: item?.type ?? null, role: item?.role ?? null, content: textDescriptor(typeof item?.content === "string" ? item.content : JSON.stringify(item?.content ?? null)), call_id_present: Boolean(item?.call_id) }))
  };
}

export function sanitizeProtocolText(value) {
  return String(value ?? "")
    .replace(/sm_[A-Za-z0-9_-]+/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/ORBITAL-MANGO-741/g, "[REDACTED_FIXTURE_TOKEN]")
    .replace(/([\"'])(?:(?!\1).){4,}\1/g, "$1[REDACTED_QUOTED_VALUE]$1")
    .slice(0, 240);
}

export function responseFeatures(status, headers, raw) {
  const base = { status, content_type: headers.get("content-type") ?? null, bytes: Buffer.byteLength(raw), sha256_12: digest(raw) };
  try {
    const parsed = JSON.parse(raw);
    const choice = parsed?.choices?.[0];
    return {
      ...base,
      parse: "json",
      shape: jsonShape(parsed),
      choice: choice ? {
        finish_reason: choice.finish_reason ?? null,
        message_content: textDescriptor(choice.message?.content),
        has_tool_calls: Array.isArray(choice.message?.tool_calls),
        tool_call_count: choice.message?.tool_calls?.length ?? 0
      } : null,
      error: parsed?.error ? { type: parsed.error.type ?? null, code: parsed.error.code ?? null, message_sanitized: sanitizeProtocolText(parsed.error.message), message: textDescriptor(parsed.error.message) } : null
    };
  } catch (error) {
    return { ...base, parse: "non-json", parse_error: { name: error.name, message_sha256_12: digest(error.message) } };
  }
}

export function sanitizeFailure(value) {
  const text = String(value ?? "");
  return { name: value?.name ?? "Error", message: sanitizeProtocolText(text), message_sha256_12: digest(text) };
}

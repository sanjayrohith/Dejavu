import policyFile from "./policy.json" with { type: "json" };
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

type Env = Record<string, string | undefined>;
export type Policy = typeof policyFile;

const SECRET_NAMES = ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "OPENAI_API_KEY"] as const;

export function opaqueTenant(tenant: string): string {
  return `t_${createHash("sha256").update(tenant).digest("hex").slice(0, 16)}`;
}

export function inspectEnvironment(env: Env = process.env) {
  const cloudflareToken = env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN;
  const gatewayId = env.AI_GATEWAY_ID || env.CLOUDFLARE_AI_GATEWAY_ID || "default";
  const checks = {
    accountId: Boolean(env.CLOUDFLARE_ACCOUNT_ID),
    gatewayId: Boolean(gatewayId),
    providerKey: Boolean(env.OPENAI_API_KEY),
    cloudflareApiToken: Boolean(cloudflareToken),
    explicitLiveConsent: env.ALLOW_LIVE_INFERENCE === "1",
    spendLimitVerified: env.AIG_SPEND_LIMIT_VERIFIED === "1",
  };
  const missingForLive: string[] = [];
  if (!checks.accountId) missingForLive.push("CLOUDFLARE_ACCOUNT_ID");
  if (!checks.providerKey) missingForLive.push("OPENAI_API_KEY (BYOK provider credential)");
  if (!checks.explicitLiveConsent) missingForLive.push("ALLOW_LIVE_INFERENCE=1");
  if (policyFile.requireVerifiedGatewaySpendLimit && !checks.spendLimitVerified)
    missingForLive.push("AIG_SPEND_LIMIT_VERIFIED=1 (operator attestation that this gateway has a blocking spend-limit rule)");

  const controlPlaneMissing = checks.cloudflareApiToken
    ? []
    : ["CLOUDFLARE_API_TOKEN (standalone harness cannot reuse Wrangler's OAuth session as a bearer binding)"];

  return {
    schemaVersion: 1,
    readyForLive: missingForLive.length === 0,
    checks,
    selected: {
      gatewayId: gatewayId === "default" ? "default" : "[configured]",
      model: policyFile.allowedModels[0],
      endpointKind: "AI Gateway BYOK compatibility endpoint",
    },
    missingForLive,
    controlPlaneMissing,
    secrets: Object.fromEntries(SECRET_NAMES.map((name) => [name, env[name] ? "set" : "unset"])),
    note: "No credential values are read into output. Presence is reported only.",
  };
}

export function validateRequest(model: string, maxTokens: number, metadata: Record<string, string>, policy: Policy = policyFile) {
  if (!policy.allowedModels.includes(model)) throw new Error(`model is not allowed by policy: ${model}`);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > policy.maxOutputTokens)
    throw new Error(`max_tokens must be an integer from 1 through ${policy.maxOutputTokens}`);
  for (const key of policy.requiredMetadata) if (!metadata[key]) throw new Error(`required metadata missing: ${key}`);
  if (metadata.purpose !== policy.purpose) throw new Error(`purpose is not allowed: ${metadata.purpose}`);
}

export function buildRequest(env: Env = process.env, trace = randomUUID()) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || "<account-id>";
  const gatewayId = env.AI_GATEWAY_ID || env.CLOUDFLARE_AI_GATEWAY_ID || "default";
  const model = policyFile.allowedModels[0];
  const maxTokens = policyFile.maxOutputTokens;
  const metadata = {
    tenant: opaqueTenant(env.MEMORY_TENANT || "example-tenant"),
    purpose: policyFile.purpose,
    trace,
  };
  validateRequest(model, maxTokens, metadata);
  return {
    url: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat/chat/completions`,
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY || "<provider-key>"}`,
      "content-type": "application/json",
      "cf-aig-metadata": JSON.stringify(metadata),
      "cf-aig-collect-log-payload": String(policyFile.collectLogPayload),
      "cf-aig-request-timeout": String(policyFile.requestTimeoutMs),
      "cf-aig-max-attempts": String(policyFile.maxAttempts),
    },
    body: {
      model,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [
        { role: "system", content: "Extract one durable memory. Return JSON only: {kind,text}. Do not infer missing facts." },
        { role: "user", content: "Decision: use SQLite for local memory because it is inspectable." },
      ],
    },
    metadata,
  };
}

export function redactRequest(request: ReturnType<typeof buildRequest>) {
  return {
    ...request,
    url: request.url.replace(/\/v1\/[^/]+\//, "/v1/[account]/"),
    headers: { ...request.headers, authorization: "Bearer [REDACTED]" },
  };
}

async function save(path: string | undefined, value: unknown) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (path) await writeFile(path, text, { mode: 0o600 });
  console.log(text.trim());
}

async function main() {
  const command = process.argv[2] || "preflight";
  const outIndex = process.argv.indexOf("--out");
  const out = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
  if (command === "preflight") {
    const result = inspectEnvironment();
    await save(out, result);
    if (!result.readyForLive) process.exitCode = 2;
    return;
  }
  const request = buildRequest();
  if (command === "dry-run") {
    await save(out, { inferenceCalls: 0, request: redactRequest(request), policy: policyFile });
    return;
  }
  if (command !== "live") throw new Error("usage: harness.ts preflight|dry-run|live [--out PATH]");
  const preflight = inspectEnvironment();
  if (!preflight.readyForLive) throw new Error(`live blocked by preflight: ${preflight.missingForLive.join("; ")}`);

  // Exactly one fetch exists in the harness. Redirect following is disabled to avoid credential forwarding.
  const started = performance.now();
  const response = await fetch(request.url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(policyFile.requestTimeoutMs + 1000),
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  const responseText = await response.text();
  let responseBody: unknown;
  try { responseBody = JSON.parse(responseText); } catch { responseBody = { nonJsonBytes: responseText.length }; }
  const artifact = {
    inferenceCalls: 1,
    request: redactRequest(request),
    response: {
      status: response.status,
      ok: response.ok,
      durationMs: Math.round(performance.now() - started),
      gatewayLogId: response.headers.get("cf-aig-log-id"),
      providerRequestId: response.headers.get("x-request-id"),
      body: responseBody,
    },
    caveat: "Provider response usage is evidence of tokens, not authoritative billed cost. Confirm cost and metadata in AI Gateway logs.",
  };
  await save(out, artifact);
  if (!response.ok) process.exitCode = 1;
}

if (import.meta.main) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });

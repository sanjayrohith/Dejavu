import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildRequest, inspectEnvironment, opaqueTenant, redactRequest, validateRequest } from "../harness";
import policy from "../policy.json";

describe("redacted bounded harness", () => {
  test("preflight reports exact seams without credential values", () => {
    const report = inspectEnvironment({
      CLOUDFLARE_ACCOUNT_ID: "acct-secret",
      OPENAI_API_KEY: "provider-secret",
    });
    const serialized = JSON.stringify(report);
    expect(report.readyForLive).toBe(false);
    expect(report.missingForLive).toContain("ALLOW_LIVE_INFERENCE=1");
    expect(report.missingForLive.some((item) => item.startsWith("AIG_SPEND_LIMIT_VERIFIED"))).toBe(true);
    expect(report.controlPlaneMissing[0]).toContain("CLOUDFLARE_API_TOKEN");
    expect(serialized).not.toContain("acct-secret");
    expect(serialized).not.toContain("provider-secret");
  });

  test("request carries opaque tenant, purpose, trace, privacy, and retry controls", () => {
    const request = buildRequest({
      CLOUDFLARE_ACCOUNT_ID: "acct-secret",
      OPENAI_API_KEY: "provider-secret",
      MEMORY_TENANT: "customer@example.com",
    }, "trace-14");
    const metadata = JSON.parse(request.headers["cf-aig-metadata"]);
    expect(metadata).toEqual({ tenant: opaqueTenant("customer@example.com"), purpose: "memory-extraction", trace: "trace-14" });
    expect(request.headers["cf-aig-collect-log-payload"]).toBe("false");
    expect(request.headers["cf-aig-max-attempts"]).toBe("1");
    expect(request.body.max_tokens).toBeLessThanOrEqual(policy.maxOutputTokens);
    const redacted = JSON.stringify(redactRequest(request));
    expect(redacted).not.toContain("acct-secret");
    expect(redacted).not.toContain("provider-secret");
  });

  test("policy rejects model, purpose, and token escape", () => {
    const metadata = { tenant: "t_x", purpose: "memory-extraction", trace: "x" };
    expect(() => validateRequest("openai/gpt-4o-mini", 48, metadata)).not.toThrow();
    expect(() => validateRequest("openai/gpt-5", 48, metadata)).toThrow("not allowed");
    expect(() => validateRequest("openai/gpt-4o-mini", 49, metadata)).toThrow("max_tokens");
    expect(() => validateRequest("openai/gpt-4o-mini", 48, { ...metadata, purpose: "chat" })).toThrow("purpose");
  });

  test("source has a single network call site and no secret literals", () => {
    const source = readFileSync(new URL("../harness.ts", import.meta.url), "utf8");
    expect(source.match(/await fetch\(/g)?.length).toBe(1);
    expect(source).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });
});

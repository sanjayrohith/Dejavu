import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createRemoteJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  derivePersonalNamespace,
  normalizeTeamDomain,
  verifyAccessJwt,
} from "../access-identity.mjs";

const issuer = "https://example.cloudflareaccess.com";
const audience = "configured-access-application-aud";
const nowSeconds = 1_800_000_000;
let privateKey;
let jwks;
let server;
let baseUrl;

async function assertion(overrides = {}) {
  const claims = {
    sub: "stable-access-user-id",
    aud: audience,
    iss: issuer,
    iat: nowSeconds - 10,
    exp: nowSeconds + 300,
    ...overrides,
  };
  const jwt = new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "ephemeral-test-key" });
  return jwt.sign(privateKey);
}

function resolver() {
  // A new resolver per assertion prevents cache state from hiding a JWKS fetch.
  return createRemoteJWKSet(new URL("/certs", baseUrl), { cacheMaxAge: 0 });
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  jwks = { keys: [{ ...publicJwk, alg: "RS256", use: "sig", kid: "ephemeral-test-key" }] };
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(jwks));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("Access JWT cryptographic contract", () => {
  test("accepts a signed, current assertion with exact issuer and audience", async () => {
    const result = await verifyAccessJwt({
      token: await assertion(), audience, issuer, jwks: resolver(), now: new Date(nowSeconds * 1000),
    });
    expect(result.namespace).toBe(derivePersonalNamespace(issuer, "stable-access-user-id"));
    expect(result.expiresAt).toBe(nowSeconds + 300);
  });

  test("two assertions for one verified subject select one namespace", async () => {
    const first = await verifyAccessJwt({
      token: await assertion({ iat: nowSeconds - 20 }), audience, issuer, jwks: resolver(), now: new Date(nowSeconds * 1000),
    });
    const second = await verifyAccessJwt({
      token: await assertion({ iat: nowSeconds - 5 }), audience, issuer, jwks: resolver(), now: new Date(nowSeconds * 1000),
    });
    expect(second.namespace).toBe(first.namespace);
  });

  test("rejects a token for a different Access application", async () => {
    await expect(verifyAccessJwt({
      token: await assertion(), audience: "other-app", issuer, jwks: resolver(), now: new Date(nowSeconds * 1000),
    })).rejects.toThrow();
  });

  test("rejects a token from a different Access team", async () => {
    await expect(verifyAccessJwt({
      token: await assertion(), audience, issuer: "https://other.cloudflareaccess.com", jwks: resolver(), now: new Date(nowSeconds * 1000),
    })).rejects.toThrow();
  });

  test("rejects an expired assertion", async () => {
    await expect(verifyAccessJwt({
      token: await assertion({ exp: nowSeconds - 30 }), audience, issuer, jwks: resolver(), now: new Date(nowSeconds * 1000),
    })).rejects.toThrow();
  });

  test("rejects an assertion without a subject", async () => {
    await expect(verifyAccessJwt({
      token: await assertion({ sub: undefined }), audience, issuer, jwks: resolver(), now: new Date(nowSeconds * 1000),
    })).rejects.toThrow();
  });
});

describe("production domain boundary", () => {
  test("accepts only a Cloudflare Access team hostname", () => {
    expect(normalizeTeamDomain("Example.CloudflareAccess.com")).toBe("example.cloudflareaccess.com");
    expect(() => normalizeTeamDomain("https://example.cloudflareaccess.com")).toThrow();
    expect(() => normalizeTeamDomain("attacker.example")).toThrow();
    expect(() => normalizeTeamDomain("example.cloudflareaccess.com.evil.test")).toThrow();
  });
});

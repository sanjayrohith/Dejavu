import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

const ACCESS_SUFFIX = ".cloudflareaccess.com";

export function normalizeTeamDomain(input) {
  const value = String(input ?? "").trim().toLowerCase();
  if (!value) throw new Error("teamDomain is required");
  if (value.includes("://") || value.includes("/") || value.includes(":")) {
    throw new Error("teamDomain must be a hostname, not a URL");
  }
  if (!value.endsWith(ACCESS_SUFFIX) || value === ACCESS_SUFFIX.slice(1)) {
    throw new Error(`teamDomain must end in ${ACCESS_SUFFIX}`);
  }
  return value;
}

/**
 * This identifier chooses a namespace; it is not an authorization credential.
 * Authorization must be checked again on every connection/request.
 */
export function derivePersonalNamespace(issuer, subject) {
  if (typeof issuer !== "string" || !issuer) throw new Error("verified issuer is required");
  if (typeof subject !== "string" || !subject) throw new Error("verified subject is required");
  const digest = createHash("sha256")
    .update("dejavu/access-person/v1\0")
    .update(issuer)
    .update("\0")
    .update(subject)
    .digest("base64url");
  return `access-person-v1:${digest}`;
}

/**
 * Low-level verifier. Tests use it with an ephemeral real RSA key and HTTP JWKS.
 * Application code should use verifyCloudflareAccessJwt below.
 */
export async function verifyAccessJwt({ token, audience, issuer, jwks, now = new Date() }) {
  if (typeof token !== "string" || token.split(".").length !== 3) {
    throw new Error("a compact Access JWT is required");
  }
  if (typeof audience !== "string" || !audience) throw new Error("configured audience is required");
  if (typeof issuer !== "string" || !issuer) throw new Error("configured issuer is required");
  if (typeof jwks !== "function") throw new Error("JWKS resolver is required");

  const { payload, protectedHeader } = await jwtVerify(token, jwks, {
    issuer,
    audience,
    algorithms: ["RS256"],
    currentDate: now,
    clockTolerance: 5,
    requiredClaims: ["iat", "exp", "sub"],
  });

  if (protectedHeader.alg !== "RS256") throw new Error("Access JWT must use RS256");
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Access JWT subject must be a non-empty string");
  }

  return {
    namespace: derivePersonalNamespace(issuer, payload.sub),
    issuer,
    subject: payload.sub,
    audience: payload.aud,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}

export async function verifyCloudflareAccessJwt({ token, audience, teamDomain, now = new Date() }) {
  const domain = normalizeTeamDomain(teamDomain);
  const issuer = `https://${domain}`;
  const certs = new URL("/cdn-cgi/access/certs", issuer);
  const jwks = createRemoteJWKSet(certs, {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
  return verifyAccessJwt({ token, audience, issuer, jwks, now });
}

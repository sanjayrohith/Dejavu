#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { verifyCloudflareAccessJwt } from "./access-identity.mjs";

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument near ${key ?? "end"}`);
    result[key.slice(2)] = value;
  }
  return result;
}

try {
  const args = options(process.argv.slice(2));
  if (!args["token-file"] || !args["team-domain"] || !args.audience) {
    throw new Error("usage: verify-session.mjs --token-file FILE --team-domain TEAM.cloudflareaccess.com --audience ACCESS_AUD");
  }

  const token = (await readFile(args["token-file"], "utf8")).trim();
  const identity = await verifyCloudflareAccessJwt({
    token,
    teamDomain: args["team-domain"],
    audience: args.audience,
  });

  // Deliberately do not print the assertion, email, or raw Access subject.
  console.log(JSON.stringify({
    verified: true,
    namespace: identity.namespace,
    issuer: identity.issuer,
    issuedAt: new Date(identity.issuedAt * 1000).toISOString(),
    expiresAt: new Date(identity.expiresAt * 1000).toISOString(),
  }, null, 2));
} catch (error) {
  console.error(`Access identity verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

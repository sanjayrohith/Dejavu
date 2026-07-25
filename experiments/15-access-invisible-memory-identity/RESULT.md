# Experiment 15 — RESULT

Run date: 2026-06-11  
Verdict: **PARTIAL PASS — real laptop identity verified; cross-machine objective blocked on independent remote ceremony**

No Worker or other public endpoint was deployed. No API/service token was created. No Access assertion, email, raw subject, or reusable credential is committed.

## Real Access evidence

A pre-existing `cloudflared` user session was safely available on the laptop. The real path executed was:

```text
cloudflared 2026.3.0 cached user session
  -> compact assertion in mode-0600 temporary file
  -> jose 6.2.3
  -> HTTPS fetch of the real Access team's /cdn-cgi/access/certs
  -> RS256 signature + configured issuer + configured AUD + time validation
  -> derived namespace
  -> temporary assertion deleted
```

Sanitized result:

```json
{
  "verified": true,
  "issuerHost": "<redacted-access-team>.cloudflareaccess.com",
  "audienceSha256Prefix": "<redacted>",
  "namespaceSha256Prefix": "<redacted>",
  "issuedAt": "<redacted>",
  "expiresAt": "<redacted>"
}
```

The expected audience was supplied separately to the verifier; it was not accepted from the assertion. `cloudflared access token` completed from cached user state without an API key or a new interactive login. Public evidence intentionally redacts the real team hostname, audience digest, namespace digest, and token timestamps. The verifier fetched real remote signing keys and returned success. This is genuine Access session evidence, not a synthetic token.

This proves that a valid existing Access login can be invisible to a local agent and can select a personal namespace without provisioning a static API key. The assertion itself remains a short-lived replayable bearer credential.

## Runnable verifier tests

Command:

```bash
cd experiments/15-access-invisible-memory-identity
bun test
```

Result with Bun 1.3.12 and `jose` 6.2.3:

```text
7 pass
0 fail
11 expect() calls
```

Covered:

- valid RS256 assertion, exact issuer, exact audience, and current lifetime;
- renewed assertions for one subject derive the same namespace;
- wrong application audience rejected;
- wrong Access team issuer rejected;
- expired assertion rejected;
- missing subject rejected;
- production wrapper accepts only a Cloudflare Access team hostname.

The test assertions use an ephemeral RSA key and HTTP JWKS server. They prove the runnable cryptographic contract and rejection behavior; they are explicitly **not** presented as remote Access proof. The separate run above supplies the real Access/JWKS evidence.

## What failed to be proven

There was no independently authenticated remote-agent session and no Access-protected memory authority available within the non-deployment boundary. Copying the laptop's cached assertion to a remote host would only prove bearer replay and would undermine the question. Creating a service token would introduce reusable client credentials and likewise answer a different question.

A new remote host must complete one user/device trust ceremony (SSO browser flow or managed WARP enrollment). That is irreducible if credentials are neither copied nor provisioned. Consequently, one namespace across laptop and remote agents is **not yet proven**.

## Security result

- **Audience:** exact application AUD pinning works and is mandatory.
- **Expiry:** local validation rejects after `exp`; namespace remains stable across renewed tokens for the same `(issuer, sub)`.
- **Revocation:** the Access edge can re-evaluate policy/session state, but this standalone signature verifier has no per-user revocation oracle. An issued token may validate offline until `exp`; JWKS rotation is not per-user revocation and local JWKS caches can delay key changes.
- **Boundary:** the verified JWT authorizes the request; the derived namespace does not. Token/cache theft, compromised hosts, malicious authenticated writes, and authorization of long-lived streams remain outside what identity derivation solves.

## Exact next remote proof

Use one non-public Access-protected memory hostname and its configured AUD. Independently authenticate laptop and remote as the same person without copying token/cache state; validate both assertions against live JWKS; prove different JWT bytes produce the same namespace hash; write on laptop and recall on remote. Then test another AUD and another user as negatives. Finally revoke the remote session, compare immediate Access-edge behavior with offline JWT behavior, and prove denial after `exp` including reconnect of any long-lived stream. Full procedure and acceptance conditions are in `README.md`.

# Experiment 15 — Access as invisible personal memory identity

## Question

Can a laptop agent and a remote agent select one **personal** Dejavu memory namespace from Cloudflare Access identity, without configuring a reusable API key in either agent?

Proposed request path:

```text
human SSO/WARP session -> short-lived Access assertion -> exact JWT validation
  -> SHA-256("dejavu/access-person/v1", verified issuer, verified sub)
  -> one personal namespace
```

The namespace is a routing key, not a credential. Every request/connection still has to be authorized. No Worker was deployed for this experiment.

## What is implemented

`access-identity.mjs` validates a compact assertion with `jose` and Cloudflare Access's live JWKS endpoint. Production validation pins all of:

- the configured team issuer, `https://<team>.cloudflareaccess.com`;
- the **configured Access application AUD** (never learned from the untrusted token);
- `RS256` and the key selected from `/cdn-cgi/access/certs`;
- required `iat`, `exp`, and non-empty `sub` claims;
- JWT time validity (including `nbf` when present, with five seconds of clock tolerance).

Only after validation does it derive a stable namespace from `(issuer, sub)`. It does not use email, because email is mutable and needlessly identifying. The CLI deliberately does not print the token, email, or raw subject.

`run-real.sh` asks installed `cloudflared` for a user token. A valid cached login makes this non-interactive; otherwise `cloudflared` starts the real browser/IdP ceremony. The assertion exists only in a mode-0600 temporary file and is removed on exit. There is no service token, API token, or committed bearer credential.

## Run

Cryptographic contract tests (ephemeral RSA key, real `jose` signing/verification, and a real HTTP JWKS server):

```bash
cd experiments/15-access-invisible-memory-identity
bun install
bun test
```

These tests are executable verifier evidence, **not a claim that synthetic tokens came from Access**. They cover correct validation, stable namespace across renewed assertions, wrong audience, wrong issuer, expiry, missing subject, and production team-domain constraints.

Real Access session and live Access JWKS:

```bash
./run-real.sh \
  https://memory.example.com \
  your-team.cloudflareaccess.com \
  YOUR_CONFIGURED_ACCESS_APPLICATION_AUD
```

The AUD must come from the Access application configuration. Deriving it from the assertion under test would make the audience check circular. Do not redirect output to a shared log: the output contains the stable pseudonymous namespace.

## Threat boundary

### This establishes

- Possession of a currently valid bearer assertion signed by the configured Access team for the configured application.
- A stable pseudonymous personal key for two independently issued assertions with the same verified team and Access subject.
- Rejection by the application verifier after JWT expiry and rejection of cross-team/cross-application assertions.
- No long-lived API key needs to be injected into the agent environment.

### This does not establish

- **Bearer theft resistance.** A process that can read the `cloudflared` cache, browser cookies, command memory, or an assertion can replay it until it stops being accepted. Access reduces static-secret distribution; it does not turn a bearer JWT into proof-of-possession.
- **Host integrity.** A compromised laptop/remote host can act as its user. OS permissions, remote-host isolation, and least privilege remain required.
- **Authorization from a namespace string.** Knowing the digest must never grant access. The service must validate Access on every request or connection and bind all reads/writes to the verified namespace server-side.
- **Memory-content safety.** An authenticated agent can still write poisoned or sensitive memory. Dejavu's trust/provenance and content controls remain separate.
- **Two-machine continuity yet.** This run had a real cached laptop session, but no independently authenticated remote session and no protected memory authority. It therefore does not claim the objective is fully proven.

## Audience, expiry, and revocation

- **Audience:** pin the one Access application's AUD from trusted configuration. Team signature alone is insufficient: another application in the same team can issue a validly signed token.
- **Expiry:** `exp` is enforced locally. Session duration controls the exposure window; renewal produces another assertion and the same `(issuer, sub)` namespace. Agents need clock synchronization.
- **Policy changes / user revocation:** Access can deny a new request/session at its edge after policy or session revocation. A standalone offline JWT verifier has no per-token revocation feed; an already issued, cached assertion can remain cryptographically valid until `exp`. JWKS key removal/rotation is broad key revocation, not a dependable per-user revocation mechanism, and verifier/JWKS caches add delay. A production design should put the authority behind Access **and** validate the assertion at the application, use short sessions, and close long-lived SSE/WebSocket connections at or before `exp` so reauthorization occurs.
- **Logout:** deleting a local cache or logging out prevents normal reuse on that client but cannot claw back a copied bearer assertion from an attacker.

## Irreducible remote ceremony and exact next proof

A new remote machine cannot silently become a person without either (a) copying a reusable bearer credential, (b) installing a reusable machine/service secret, or (c) completing a trust ceremony. Options (a) and (b) violate this experiment's goal. The irreducible blocker is therefore a one-time independent user/device ceremony on the remote host: browser/IdP login through `cloudflared`, or managed WARP enrollment with an Access policy that resolves the same user identity. Subsequent assertion renewal may be invisible while that session is valid.

The next remote proof must be:

1. Create an Access-protected, non-public test memory hostname with the direct origin/Workers route unavailable; record its trusted team domain and AUD. Do not use a publicly reachable bypass URL.
2. Set a short (for example 10-minute) Access session. Do not create a service token or distribute an API token.
3. On the laptop, use its own SSO/WARP state to obtain assertion A. On the remote machine, independently complete the one-time SSO/WARP ceremony and obtain assertion B. Never copy assertion A or `~/.cloudflared` to the remote.
4. Validate both against live Access JWKS and the same configured AUD. Record only hashes of issuer, subject/derived namespace, token `iat`, and `exp`; prove A and B derive the same namespace while the JWT bytes differ.
5. Through the protected authority, write a nonce from the laptop and recall it from the remote. Verify a different user and a token for another AUD cannot access that namespace.
6. Revoke the remote Access session/policy. Measure denial at the Access edge, then separately show whether an isolated offline verifier still accepts B until `exp`. Wait past `exp`, close/reopen any stream, and prove both edge and application deny B.

That run would answer the cross-machine question. The present result proves the local cryptographic and cached-session portions and makes the remaining human ceremony explicit.

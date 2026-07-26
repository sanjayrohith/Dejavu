# Security

## Supported surface

The supported production surface in v0.1.0 is local Dejavu: one SQLite database used by one operating-system user.

Shared Dejavu is preview-only. Do not expose or deploy `shared-server` until the blocking review in [`docs/shared-security-review.md`](docs/shared-security-review.md) is complete.

## Data classification

Local Dejavu stores plaintext SQLite at `~/.dejavu/dejavu.db` unless `DEJAVU_DB` overrides the path. It is designed for project context, decisions, procedures, and handoffs.

Do not store:

- passwords, tokens, private keys, or credentials;
- customer data;
- regulated or highly sensitive personal data;
- content that is not permitted on the local machine.

Repository scope is a retrieval boundary, not an operating-system security boundary. Processes that can read the database file can inspect all local memory rows.

## Reporting a vulnerability

Do not open a public issue containing exploit details or memory content. Contact the repository owner privately through the security-reporting channel listed on the GitHub repository.

Include:

- affected version or commit;
- local or shared-preview surface;
- minimal reproduction without real secrets;
- expected and observed isolation behavior;
- any deletion, logging, or retention implications.

## Shared preview

Bearer-token mappings in local Wrangler dogfood prove memory-space routing only. They are not production identity. A production shared release requires verified identity, short-lived and revocable sessions, cross-owner isolation, content policy, audit boundaries, retention/deletion policy, and an encryption decision.

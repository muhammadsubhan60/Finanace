# Security review (M8), 7 Nov 2026

Scope: web app (pages, server actions, route handlers), worker, DB layer, integrations. Checked against spec section 12.

## Fixed in this review

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | The Leopards Push webhook accepted unauthenticated status updates when no shared secret was configured. A forged "Returned to shipper" would trigger an inventory write-off. | Deny by default: the endpoint returns 401 until a secret is configured, and compares secrets in constant time. Tests cover a missing, wrong and empty secret. |
| 2 | High | Users could not change their password, so every account stayed on the seed password. | Added **My account**: change password (min 12 chars, rejects the seed pattern, signs out other sessions, audited), 2FA status and active sessions. |
| 3 | Medium | A pasted label + value ("API Key* …") was stored as a credential and failed later at the provider. | Credential fields containing spaces or line breaks are rejected when saving. |
| 4 | Low | No HSTS or Permissions-Policy header. | HSTS (production only) and a restrictive Permissions-Policy added. |

## Verified

- **RBAC:** the server checks permissions on every page (`requireUser(perm)`) and every action (`act(perm)` → `requirePerm`). Deny by default. Tested by fetching every page as MD (all 200; `/users` → forbidden), as staff (profit pages → forbidden, CSV export → 403) and anonymously (→ login).
- **Separation of duties:** requesters can't approve their own requests where the policy requires it. Approvers must hold an approver role and decide once. Rejecting needs a comment.
- **Ledger:** insert-only API (`postEntry`), `$jsonSchema` validator, hash chain with a nightly verifier, idempotency keys. Closed and final periods reject entries. The RUNBOOK has a DB role with insert/find only on the ledger collections.
- **Audit:** every write records user, IP, request id and before/after hashes. Secret-looking keys are redacted in the stored payload.
- **Secrets:** integration credentials are AES-256-GCM encrypted, never sent to the browser (the UI shows only "saved") and never logged. Leopards `slip_link` URLs contain base64 credentials and are never stored.
- **CSRF:** Next.js server actions check Origin against Host. Logout is POST-only. Cookies are httpOnly, SameSite=Lax, Secure in production, with server-side sessions (12 h TTL index).
- **Auth hardening:** login rate limit of 5 failures per email+IP per 15 min. TOTP is mandatory for owner and finance reviewer (role flag). Accountant access is time-limited.
- **Injection:** user search input is regex-escaped or sanitized before Mongo `$regex`. All inputs are Zod-validated or parsed with strict money parsing.
- **Uploads:** allow-listed MIME types, 10 MB limit, randomised names, stored outside `public/` and never served directly.
- **PII:** phones are masked in lists unless the user has `pii:full`. Orders keep only name, phone and city.

## Accepted / open

- The CSP allows `'unsafe-inline'` scripts (the theme no-flash script and the Next.js runtime). Moving to nonces is a follow-up.
- Shopify webhooks need the per-store signing secret. Without it they are rejected (401).
- `APP_ENCRYPTION_KEY` must be backed up separately from database backups. A restored database can't decrypt credentials without it.
- Dependency audit (`pnpm audit`) and Sentry are not wired yet. Do both before production.

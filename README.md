# Delta Finance

Finance module and book of record for the Delta Labs local ecommerce division. Spec: [docs/SPEC.md](docs/SPEC.md) · plan: [docs/PLAN.md](docs/PLAN.md) · runbook: [docs/RUNBOOK.md](docs/RUNBOOK.md) · open questions: [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md).

```
apps/web                 Next.js 16 App Router (UI, server actions, webhooks)
apps/worker              Background worker (syncs, auto-finalize, alerts, chain verification)
packages/core            Pure domain logic: money, profit engine, ledger, posting templates, matching (no I/O)
packages/config-schema   Zod Agreement Profile + seed (Draft 3)
packages/db              Mongo client, append-only journal, services
packages/integrations    Adapters: Leopards, TCS, Shopify, Meta + mocks
```

Quick start: see [docs/RUNBOOK.md](docs/RUNBOOK.md#local-development).

## Rules

- Money is integer paisa. Splits use largest-remainder rounding.
- Every business rule comes from the Agreement Profile (versioned, dual approval).
- The ledger is append-only and hash-chained. Corrections are reversal + new entries.
- Every external call goes through an adapter. Mocks ship, so the app works with no credentials.
# Finanace
# Finanace

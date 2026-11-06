# Build Plan

Lean implementation of `docs/SPEC.md`. Every business rule comes from the Agreement Profile. Money is integer paisa throughout.

## Phases

| Phase | Spec milestones | Scope | Done when |
|---|---|---|---|
| **P1 Core** | M2 (+ ledger rules of M1) | `packages/core`: Money, largest-remainder split, `computePeriod`, withdrawal evaluation, ledger validation and reversal, hash chain, posting templates, status normalization, matching strategies, settlement matching, CSV parsing. `packages/config-schema`: Zod Agreement Profile and seed. | All 8.3 vectors and property tests pass. |
| **P2 Foundations + ledger** | M0, M1 | pnpm monorepo, Mongo replica set (dev script), DB package (repos, append-only journal with `$jsonSchema` validator, indexes), session auth with roles matrix and optional TOTP, audit log on every write, seed script. | Login works per role; journal rejects edits; audit rows appear. |
| **P3 Manual ops** | M1 UI, M3 | Profile editor with versioning, diff and dual approval. Expenses and approvals, capital tranches, withdrawals, simple stock, periods (checklist, close, statement, objections, auto-final), print/CSV statement. | A full month runs end-to-end with manual data. |
| **P4 Integrations** | M4, M5, M6 | Adapter interfaces + mocks; Leopards real adapter (endpoints flagged OPEN); Trax/TCS mocks; Shopify GraphQL; Meta insights. Courier-first intake (CSV, bulk CN paste, manual), matching queue, status mapping UI, settlement CSV import (idempotent), reconciliation view, unallocated ad spend queue. Worker process with schedules. | Settlement file imports, matches, flags and posts exactly once. |
| **P5 Dashboard + alerts** | M7 | Dashboard metrics with drill-down links and definitions, alert rules engine (in-app). | Each number links to records. |
| **P6 Hardening** | M2 gate, M8 | RUNBOOK, OPEN_QUESTIONS, demo seed; engine coverage gate; security review ([SECURITY_REVIEW.md](SECURITY_REVIEW.md)); load test; backup/restore drill. | ✅ 7 Nov 2026 — see results below. |

## Status

All phases P1–P6 complete. Results:

- **Tests:** 53 unit tests (core 40, integrations 9, config 4) + full-month E2E (`pnpm --filter @delta/db e2e`). **Engine coverage 100%** (branches, lines, statements, functions), enforced in `packages/core/vitest.config.ts`.
- **Live integrations:** Leopards verified against production (282 real packets, 4 cheques reconciled). TCS auth and endpoints verified; there's no shipment history to parse yet.
- **Load test** (`pnpm --filter @delta/db load-test`: 50k orders, 50k shipments, 500k events, 150k journal lines, 12 months), data-layer p95:

| Query | p95 |
|---|---|
| Dashboard, current month | 279–488 ms |
| Dashboard, 12 months | 0.83–1.16 s |
| Dashboard, 12 months, one store | 564 ms |
| Period estimate (engine on ledger) | 235–291 ms |
| Shipments / orders list pages | 17 / 25 ms |

  Getting there took covered indexes for ledger balances, the COD position computed in the database, and concurrent dashboard queries. Pre-aggregated rollups aren't needed at this volume; revisit above ~200k shipments.
- **Backup/restore drill:** dump 1 s, restore 14 s. 41 collections, 0 count mismatches. The hash chain verifies and the trial balance balances after restore.

## Next (not in v1 scope)

- Courier booking from the app (phase 2 in the spec).
- Playwright e2e for the close, withdraw and config flows. Today these are covered by the service-level E2E script.
- Sentry and `pnpm audit` in CI.
- S3/R2 file store. XLSX import.

## Deliberate simplifications (to avoid over-engineering)

- **Jobs:** the worker uses a small Mongo-backed scheduler with leases instead of BullMQ + Redis (the spec marks BullMQ as [DEFAULT]; Redis is not installed here). The job interface is kept so BullMQ can be swapped in.
- **Auth:** a small in-house session layer (random token in an httpOnly cookie, stored in `sessions`). The Auth.js credentials provider only supports JWT sessions, and the spec requires server-side sessions. Passwords use scrypt and TOTP uses RFC 6238, both from `node:crypto`.
- **Tables:** server-rendered tables with server-side pagination instead of TanStack Table.
- **PDF export:** a print-optimised statement page (browser "Save as PDF") plus CSV, so no PDF library.
- **File storage:** uploaded CSVs are hashed and their parsed rows are stored in `import_jobs`. S3/R2 is behind a `FileStore` interface, with a local-disk default.
- **XLSX:** CSV only in v1 (export XLSX as CSV from the courier portal). Listed in OPEN_QUESTIONS.

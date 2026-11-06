
# Delta Labs Local Ecommerce Division — Finance Module (Build Spec v1.1)

**v1.1 changes (owner answers, 6 Nov 2026):** only Leopards credentials exist today; ad accounts are PKR paid by card (no FX in v1); courier-first matching because bookings are made in the courier portal; reinvestment treatment is changed from the admin panel; stock valuation kept minimal; alerts are in-app only (no email).

**Audience:** Claude Code / Codex. Build exactly what is in this document. Where something is marked **[DEFAULT]** it is an assumption the owner has not yet confirmed; implement it, but keep it configurable. Where marked **[OPEN]**, implement behind a config flag or stub and list it in `docs/OPEN_QUESTIONS.md`.

**Owner:** Muhammad Subhan (Delta Labs). **Primary users:** Muhammad (investor), Hanan (Managing Director of the division), Abdur Rehman (CFO / Finance Reviewer).

---

## 0. Decisions already made by the owner

| Topic                  | Decision                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenancy                | **Internal tool, single organisation.** Do not build billing or tenant onboarding. Still put `orgId` on every document so the model can grow later [DEFAULT, cheap insurance].                  |
| Stack                  | **Next.js (App Router) + TypeScript + MongoDB.**                                                                                                                                                  |
| Couriers               | Leopards (live), Trax, TCS (later). **Direct API where available + CSV import fallback**, especially for COD settlement.                                                                          |
| v1 scope               | **Core:** ledger, profit engine, courier integrations, Meta Ads, Shopify (multiple stores), manual expenses, simple stock and payroll as expense entries.                                         |
| Hard-coding            | **Nothing business-specific may be hard-coded.** Splits, caps, percentages, buffers, categories, status mappings, schedules and approval limits are all configuration.                            |
| Currency               | **PKR only** (integer paisa). Meta ad accounts are PKR, paid **by card**, so there is no FX in v1. Keep one optional `currency` field on spend rows so multi-currency can be added later. |
| Couriers available now | **Leopards only** (owner has credentials). Trax and TCS ship as adapters with mocks + CSV import and are switched on when credentials exist.                                                      |
| Booking                | Bookings are made **in the courier portal, not in this app**. The module must work **courier-first** (section 7.2a).                                                                        |
| Reinvestment treatment | Owner will change it from the **admin panel**. It is a setting in the Agreement Profile (new version with dual approval), never code.                                                             |
| Stock                  | Minimal: simple ledger, weighted-average default, valuation method configurable. No heavy stock UI in v1.                                                                                               |
| Alerts                 | **In-app only.** No email, no WhatsApp.                                                                                                                                                           |
| UI language            | English.                                                                                                                                                                                                |

Not in v1: multi-tenant SaaS, billing, payroll computation (only expense entry), TikTok/Google Ads, courier booking (tracking and settlement only; booking is phase 2).

---

## 1. What the module does (plain summary)

The division is a 50/50 departmental partnership between Muhammad (Delta Labs, funds it) and Hanan (runs it). The module is the **single book of record** for the division. It:

1. Pulls live data: Shopify orders, courier shipment status and COD, Meta ad spend.
2. Records expenses, capital tranches, stock movements.
3. Closes each month, computes **Net Profit**, applies **Reinvestment**, splits **Shared Profit**, enforces **withdrawal caps and cash safeguards**, tracks **Undrawn Balances**, and finalizes periods automatically after the objection window.
4. Shows live metrics (sales, delivery rate, RTO, COD pending, ad spend, ROAS, profit to date) per store, project and courier.
5. Keeps an append-only audit trail so no partner can silently change history.

Every rule below must come from an **Agreement Profile** (section 4), not from code.

---

## 2. Tech stack and architecture

- **Next.js 15+, App Router, TypeScript strict.** Server Components for read pages; Route Handlers and Server Actions for writes.
- **MongoDB (Atlas or self-hosted replica set).** Multi-document transactions are required, so a replica set is mandatory. Use the official `mongodb` driver or Mongoose; validate all input and all config with **Zod** and share schemas between client and server.
- **Auth:** Auth.js (credentials + optional TOTP 2FA). Sessions are server-side. Role checks are enforced on the server for every route and action, never only in the UI.
- **UI:** Tailwind + shadcn/ui, TanStack Table, Recharts. Light and dark. Responsive (owner will use mobile).
- **Background jobs:** a **separate worker process** in the same repo (monorepo `apps/web`, `apps/worker`), using BullMQ + Redis [DEFAULT]. Do not run long syncs inside Next.js request handlers. Deployable on Railway.
- **File storage:** receipts and imported CSVs go to S3-compatible storage [DEFAULT: Cloudflare R2 or S3]; store only metadata in MongoDB.
- **Secrets:** all third-party credentials are stored **encrypted at rest** (AES-256-GCM, key from env `APP_ENCRYPTION_KEY`), decrypted only inside the worker/server, never sent to the browser, never logged.
- **Timezone:** `Asia/Karachi` for all period boundaries and displays. Store timestamps in UTC.
- **Money:** integer **paisa** (`1 PKR = 100`). Never floats. Use a `Money` helper (BigInt or safe integer) and **largest-remainder rounding** for any split.

### Repo layout

```
/apps/web            Next.js app (UI + API routes)
/apps/worker         BullMQ workers, schedulers
/packages/core       Pure TypeScript domain logic (profit engine, ledger, rules). No I/O.
/packages/db         Mongo schemas, repositories, migrations
/packages/integrations  Shopify, Meta, courier adapters (shared interface)
/packages/config-schema Zod schemas for Agreement Profile and other config
/docs                SPEC.md (this file), OPEN_QUESTIONS.md, RUNBOOK.md
```

**Rule:** all money logic lives in `packages/core` as pure functions with unit tests. The web app and worker only call it.

---

## 3. Roles and permissions

| Role                 | Who          | Can do                                                                                                                                                     |
| -------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner`            | Muhammad     | Everything. Propose and approve config changes. Approve tranches and withdrawals.                                                                          |
| `md`               | Hanan        | View everything in the division. Create expenses, upload CSVs, raise objections, request approvals, propose config changes. Cannot spend or approve alone. |
| `finance_reviewer` | Abdur Rehman | Reconcile, close periods, post adjusting journal entries, issue monthly reports. Cannot change config alone.                                               |
| `staff`            | Team         | Orders and shipments views only (configurable per user). No profit or capital data.                                                                        |
| `accountant`       | Independent  | **Read-only, time-limited**, can comment on disputed items.                                                                                          |

Permissions are a configurable matrix (`roles` collection), not constants in code. Ship the above as the seed.

**Dual-approval actions** (agreement clause 17.1): any change to split, reinvestment, caps, funding envelope, or settlement rules needs approval from **both** `owner` and `md`. See section 4.4.

---

## 4. Agreement Profile (the heart of "not hard-coded")

A single versioned configuration document that drives the engine.

### 4.1 Shape (Zod-validated; example values reflect Draft 3 of the agreement)

```jsonc
{
  "orgId": "delta-labs",
  "divisionId": "local-ecom",
  "version": 1,
  "effectiveFrom": "2026-11-09",          // period start date it applies from
  "status": "active",                      // draft | pending_approval | active | superseded

  "partners": [
    { "partnerId": "muhammad", "userId": "...", "label": "Muhammad (Investor)", "sharePct": 50, "isCapitalProvider": true },
    { "partnerId": "hanan",    "userId": "...", "label": "Hanan (MD)",          "sharePct": 50, "isCapitalProvider": false }
  ],

  "term": { "start": "2026-11-09", "months": 12, "pilotReviewDay": 90, "ordinaryNoticeDays": 60 },

  "revenueRecognition": {
    "event": "delivered_and_cod_settled",  // enum: delivered | delivered_and_paid | delivered_and_cod_settled
    "excludeStatuses": ["rto", "cancelled", "refunded", "artificial"],
    "netOf": ["discounts", "refunds", "taxes_collected"]
  },

  "reinvestment": {
    "pct": 30,
    "basis": "net_profit",
    "treatment": "expense_no_credit",       // enum: expense_no_credit | credit_partners_pro_rata  (OPEN: owner may change)
    "fundLedger": true
  },

  "distribution": { "basis": "shared_profit", "rounding": "largest_remainder" },

  "withdrawalCap": { "enabled": true, "perPartnerMinor": 5000000, "months": 6, "applyToAllPartners": true },

  "cashSafeguards": {
    "bufferDays": 60,
    "include": ["known_liabilities", "payroll", "taxes", "refunds", "courier_return_exposure", "fixed_costs_next_n_days", "inventory_needs_next_n_days"],
    "requireWrittenCalcForExtraReserve": true
  },

  "lossCarryForward": { "enabled": true, "scope": "within_term", "excludePostTermination": true },

  "finalization": { "mode": "auto_after_days", "days": 30, "objectionWindowDays": 30, "correctionWindowMonths": 12, "correctionReasons": ["fraud", "concealment", "breach_of_trust", "arithmetical_error", "recording_error"] },

  "reporting": { "closeDayOfMonth": 10, "payoutTargetDayOfMonth": 15 },

  "overDistribution": { "method": "net_against_own_future_distributions", "personalRepaymentOnlyFor": ["fraud", "concealment"] },

  "capital": {
    "envelopeMinor": 50000000,
    "providerPartnerId": "muhammad",
    "tranchesRequireApproval": true,
    "returnRules": { "firstMonthsLocked": 6, "quarterlySurplusReview": true, "requireLiabilitiesCovered": true, "requireBufferFunded": true }
  },

  "expenseCategories": [ /* see 4.2 */ ],

  "approvalPolicy": [ /* see 4.3 */ ],

  "overheadAllocation": { "mode": "none_until_signed", "entries": [] },

  "currency": { "base": "PKR", "multiCurrency": false },

  "statusMappings": { /* per courier, see 7.2 */ },

  "matching": {
    "mode": "courier_first",                 // courier_first | shopify_first
    "strategies": [                          // tried in order, editable in admin panel
      { "type": "reference_field", "field": "order_ref" },
      { "type": "shopify_tracking_number" },
      { "type": "fuzzy", "keys": ["phone", "cod_amount", "city"], "dateWindowDays": 3, "minConfidence": 0.9 },
      { "type": "manual_queue" }
    ]
  },

  "stock": { "valuation": "weighted_average" }
}
```

### 4.2 Expense categories (data, not enum)

```jsonc
{ "key": "ads", "label": "Advertising", "type": "operating", "deductible": true, "source": ["meta_ads","manual"], "parent": null }
```

Seed set (all editable, add/disable at runtime): `cogs`, `ads`, `fulfilment_delivery`, `return_charges`, `payment_fees`, `payroll`, `overhead` (disabled until a signed allocation exists), `venture_tax` (sales tax and withholding **of the venture only**), `provision`, `reinvestment` (system category, engine-managed), `other`.

**Hard rule enforced by engine, configurable by flag:** a partner's *personal income tax* is not an expense category. Provide no category for it. If a user tries to post one, reject with a clear message.

### 4.3 Approval policy (data)

```jsonc
{ "action": "spend", "scope": "single_purchase", "limitMinor": 0, "approvers": ["owner"], "requires": "requester_and_separate_approver" }
{ "action": "new_recurring_cost", "approvers": ["owner","md"], "mode": "all" }
{ "action": "financing", "approvers": ["owner","md"], "mode": "all", "requiresSignedDocument": true }
{ "action": "config_change", "approvers": ["owner","md"], "mode": "all" }
```

Default limits are blank, as in Schedule B of the agreement. If no limit is configured for an action, the action requires approval (**silence is not approval**).

### 4.4 Versioning and change flow

- Profiles are **immutable once active**. A change creates a new draft version.
- Draft → `pending_approval` → needs approval from all required approvers (`owner` and `md`) → becomes `active` from `effectiveFrom`, and the previous version becomes `superseded`.
- A closed or final period is always computed with the version that was effective on the period start. Never recompute history with a newer version.
- UI: a **diff view** between versions, and a clear "effective from" date.
- Every approval is recorded with user, time, IP, and a comment.

---

## 5. Domain model (MongoDB collections)

All documents: `_id`, `orgId`, `createdAt`, `createdBy`, `updatedAt` (only for mutable non-ledger docs). Money fields are `...Minor` integers.

| Collection                             | Purpose (key fields)                                                                                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`, `roles`                   | Auth, role matrix, optional TOTP.                                                                                                                                                                                          |
| `agreement_profiles`                 | Section 4. Versioned, immutable once active.                                                                                                                                                                               |
| `stores`                             | `storeId`, name, platform (`shopify`), domain, `projectId`, status.                                                                                                                                                  |
| `projects`                           | Schedule A items: name, brand, launch date, funding tranche, exclusions, `inDivision` flag.                                                                                                                              |
| `integrations`                       | Per provider/account: type, label, encrypted credentials, status, last sync, error state, scopes.                                                                                                                          |
| `ad_accounts`                        | `externalId`, currency, `storeIds[]`, pixel ids, status.                                                                                                                                                               |
| `couriers`                           | Configured courier accounts (provider, label, credentials ref, cost centre, mapping profile id).                                                                                                                           |
| `orders`                             | Normalized order from Shopify: `storeId`, externalId, name, lineItems, totals, discounts, taxes, payment method (COD/prepaid), customer (minimal PII), status timeline, `trackingNumbers[]`.                           |
| `order_refunds`                      | Refunds with amounts and dates.                                                                                                                                                                                            |
| `shipments`                          | `courierId`, `cn` (consignment/tracking number), `orderId`, `codAmountMinor`, `normalizedStatus`, `providerStatus`, `events[]`, `bookedAt`, `deliveredAt`, `rtoAt`, freight/charges, `settlementId`. |
| `shipment_events`                    | Raw + normalized event log (idempotent by `provider+cn+eventTimestamp+status`).                                                                                                                                          |
| `cod_settlements`                    | A courier remittance: courier, reference, date, gross COD, deductions (freight, fees), net received, bank txn link, status, source (`api`/`csv`).                                                                      |
| `cod_settlement_lines`               | Per-CN lines; matched to `shipments`; mismatch flags.                                                                                                                                                                    |
| `ad_spend_daily`                     | `adAccountId`, date, campaignId, `spendMinor` (PKR), impressions, clicks, purchases, revenue (attributed, informational).                                                                                              |
| `expenses`                           | Category, amount, date, payee, store/project, receipt refs, status (`draft/pending/approved/posted/rejected`), requester, approver, source (`manual`, `ads_sync`, `courier_charge`, `import`).                   |
| `stock_items`, `stock_movements`   | Simple ledger: purchases in, sales out (from orders), adjustments; valuation = lower of cost and recoverable value (configurable method, default weighted average).                                                        |
| `capital_tranches`                   | Planned/approved/released tranche (amount, purpose, release date, status).                                                                                                                                                 |
| `journal_entries`, `journal_lines` | **Append-only double-entry ledger.** See section 6.                                                                                                                                                                  |
| `accounts`                           | Chart of accounts (seeded, configurable).                                                                                                                                                                                  |
| `periods`                            | One per month: status machine (section 8), snapshots, report ref, finalization dates.                                                                                                                                      |
| `period_snapshots`                   | Immutable computed statement for a period at close (inputs hash, engine version, profile version, outputs).                                                                                                                |
| `partner_accounts`                   | Running per-partner balances derived from journal (cached, rebuildable).                                                                                                                                                   |
| `withdrawals`                        | Requests and payments per partner, with cap/safeguard evaluation attached.                                                                                                                                                 |
| `objections`                         | Period/item objections, status, comments, resolution, accountant ruling.                                                                                                                                                   |
| `approvals`                          | Generic approval requests and decisions.                                                                                                                                                                                   |
| `audit_log`                          | Every write: who, what, before/after hash, IP, request id. Append-only.                                                                                                                                                    |
| `alerts`                             | In-app alerts and acknowledgements.                                                                                                                                                                                        |
| `import_jobs`                        | CSV import runs: file, mapping profile, row results, errors.                                                                                                                                                               |
| `sync_runs`                          | Integration sync runs, cursors, durations, errors.                                                                                                                                                                         |

Indexes: unique on external ids per integration, `(orgId, periodId)`, `(shipments.cn, courierId)`, `(orders.storeId, externalId)`, time-based indexes on events.

---

## 6. Ledger rules (append-only, double-entry)

- `journal_entries` = header (date, periodId, source, memo, reversalOf?). `journal_lines` = `accountId`, debit/credit minor, optional `partnerId`, `storeId`, `projectId`, `refType/refId`.
- **Never update or delete.** Corrections are **reversal entries + new entries** ("dated adjusting entries", agreement clause 7.1). Enforce this in the repository layer, and additionally with a MongoDB schema validator and a DB user for the app that has no delete rights on these collections.
- Each entry must balance (sum debit = sum credit). Reject otherwise.
- A closed or final period rejects new entries dated inside it, except through the **correction workflow** (section 8.4).
- Optional integrity: store `prevHash`/`hash` per entry (hash chain) so tampering is detectable; add a nightly verifier.

### Chart of accounts (seed, editable)

Assets: `bank`, `cash`, `courier_cod_in_transit`, `courier_cod_receivable_settled_pending`, `inventory`.
Liabilities: `accounts_payable`, `card_payable`, `accrued_liabilities`, `taxes_payable`.
Equity/partner: `capital_muhammad`, `reinvestment_fund`, `partner_profit_<partnerId>` (undrawn balance), `partner_drawings_<partnerId>`.
Income: `sales`, `sales_returns_discounts`.
Expenses: one per expense category.
Memo (non-posting): `loss_carry_forward`.

### Core postings (examples)

- Capital tranche released: Dr `bank` / Cr `capital_muhammad`.
- Stock bought: Dr `inventory` / Cr `bank`.
- Delivered COD order (per revenue recognition config): Dr `courier_cod_in_transit` / Cr `sales`; and Dr `cogs` / Cr `inventory`.
- Courier settlement: Dr `bank` + Dr courier fees expense / Cr `courier_cod_in_transit`.
- Ad spend day: Dr `ads` / Cr `card_payable`; card bill paid: Dr `card_payable` / Cr `bank`.
- Month close: Dr/Cr results into partner and reinvestment accounts via the engine output (section 8.2).
- Partner withdrawal: Dr `partner_profit_<id>` / Cr `bank`.

Posting rules are defined in code as a **table of configurable posting templates** (keyed by event type and revenue recognition setting), not scattered `if` statements.

---

## 7. Integrations

### 7.0 Common requirements

- Adapter interface per provider; the rest of the app never calls provider SDKs directly.
- **Idempotent ingestion** (natural keys), **retries with exponential backoff**, **rate-limit awareness**, **circuit breaker** per integration, resumable cursors in `sync_runs`.
- **Always store raw payloads** (`shipment_events.raw`) for audit, scrubbed of secrets.
- Webhooks: verify signature or shared secret, respond fast (store + enqueue), process async.
- Every integration has a **Health panel**: last success, lag, error count, "Test connection" button, and "Resync range" action.
- Mock adapters + fixtures so everything works without live credentials. **Ship the app usable with only mocks + CSV imports.**

### 7.1 Shopify (multiple stores)

- One **custom app per store** (Admin API access token), stored encrypted in `integrations`.
- Use the Admin **GraphQL** API; sync orders, refunds, fulfilments, products, inventory items (cost) with incremental `updated_at` cursors, plus webhooks (`orders/create`, `orders/updated`, `refunds/create`, `orders/cancelled`). Verify against current Shopify API version at build time and pin the version in config.
- Order ↔ shipment matching follows `matching.strategies` in the profile (see 7.2a). Shopify is **enrichment** in courier-first mode: it supplies product, cost, discount and refund detail for orders that match a courier booking.
- Store only the minimum customer PII needed (name, phone, city); mask phone in lists.

### 7.2 Couriers: Leopards, Trax, TCS

**Today:** only Leopards credentials exist, so build and test the **Leopards adapter first**; Trax and TCS adapters are mocks + CSV import until credentials arrive.

**Facts and uncertainty.** Official API docs for these couriers are not public; third-party connectors show booking, cancel, tracking (poll or webhook) and COD amount sent at booking. Auth differs: Leopards API key + merchant password; TCS account number + token/password + cost centre; Trax API key from the portal. **COD settlement/remittance via API is unconfirmed for all three.** Therefore:

1. **Define a normalized interface** and implement adapters against it, with the exact endpoints/fields filled in from the owner's real merchant docs [OPEN]:

```ts
interface CourierAdapter {
  testConnection(): Promise<Result>;
  fetchTracking(cn: string): Promise<ShipmentSnapshot>;          // status + events
  fetchTrackingBatch?(cns: string[]): Promise<ShipmentSnapshot[]>;
  handleWebhook?(req): Promise<ShipmentEvent[]>;                 // if provider supports
  fetchSettlements?(range): Promise<Settlement[]>;               // only if provider API supports it
  // phase 2: bookShipment, cancelShipment, fetchCities, fetchTariff
}
```

2. **Normalized status enum:** `booked`, `picked_up`, `in_transit`, `out_for_delivery`, `delivery_attempted`, `delivered`, `return_initiated`, `returned_to_origin` (RTO), `cancelled`, `lost_or_damaged`, `unknown`.
3. **Status mappings are data** (`agreement_profiles.statusMappings` or a `status_maps` collection): provider status string → normalized status, editable in UI with a "unmapped statuses seen" list so new provider strings never break anything.
4. **Settlement fallback (required in v1): CSV/XLSX import** with **configurable column-mapping profiles per courier** (saved, versioned). Flow: upload → preview mapped rows → validate → match lines to shipments by CN → show mismatches (amount differs, CN unknown, already settled, delivered-but-unsettled) → confirm → post journal entries. Idempotent: re-uploading the same file must not double-post (file hash + line keys).
5. **Reconciliation view:** per courier: COD in transit, delivered not yet settled, settled, disputed, RTO, aging buckets (0–7, 8–14, 15–30, 30+ days, thresholds configurable).
6. **Polling schedule** configurable per courier (e.g., open shipments every N hours; stop polling after terminal status).
7. Courier charges (freight, COD fee, return fee) come from API fields or settlement lines and post to the configured expense categories.

### 7.2a Courier-first mode and matching (owner books in the courier portal)

Because bookings are created in the Leopards portal, the app cannot rely on Shopify holding tracking numbers. The **courier booking is the source of truth for shipments, COD amounts and delivery status**. Build it like this:

1. **Shipment intake (any of these, all supported, configurable):**
   - **API sync by date range** if the Leopards merchant API can list booked packets for a date range **[OPEN: confirm with Leopards docs]**.
   - **CSV/XLSX import of the booking list** downloaded from the portal, with a saved column-mapping profile.
   - **Bulk paste of CN numbers** (one per line) to start tracking them via the tracking API.
   - **Manual add** of a single CN.
2. **Tracking:** once a CN exists, the worker polls the tracking API on a schedule until a terminal status.
3. **Matching a shipment to a Shopify order** runs `matching.strategies` in order, stopping at the first confident match:
   1. **Reference field:** the consignee reference / order number the owner types into the booking (recommend the Shopify order number, e.g. `#1042`). Highest confidence.
   2. **Shopify fulfilment tracking number**, if staff paste it there.
   3. **Fuzzy match** on normalized phone + COD amount + city within a date window (default 3 days). Show a confidence score. Auto-link only at or above `minConfidence`; otherwise send to the queue.
   4. **Manual queue:** a screen with side-by-side candidate orders and one-click link. Remember manual links.
4. **Unmatched is not blocking.** In `courier_first` mode an unmatched shipment still counts for COD, delivery rate, RTO and settlement. It simply lacks product and cost detail, so COGS for it uses a configurable fallback (average cost ratio per store, set in the admin panel) and is flagged "estimated" until matched. The pre-close checklist shows the count of unmatched shipments as a **warning, not a blocker** (owner can switch to blocking in config).
5. **Revenue recognition** under `courier_first`: a shipment's COD amount is the revenue figure for delivered shipments; Shopify totals are used to cross-check and flag differences (price edited at booking, partial delivery).
6. **Process tip shown in the UI onboarding:** put the Shopify order number in the courier booking's reference/order-id field. It removes most manual matching at zero cost.

### 7.3 Meta Ads

- **Marketing API insights** at ad-account level, daily, broken down by campaign (and ad set optionally). Auth via a **System User access token** [DEFAULT] stored encrypted; handle token expiry with alerting.
- Map each ad account to one or more stores/projects (and pixels) in `ad_accounts`. Spend is recorded **against the store/campaign that incurred it**. If an account is shared with another Delta Labs division, support **split by actual spend** using a campaign-to-division mapping [agreement clause 5.4]; unmapped campaigns go to an "unallocated" queue and are excluded from the division until assigned.
- **Currency and payment:** ad accounts are PKR and paid **by card**, so spend is already in PKR. Post daily spend as Dr `ads` / Cr `card_payable`; when the card bill is paid, Dr `card_payable` / Cr `bank`. Card payments and ad spend therefore reconcile separately (add `card_payable` to the chart of accounts).
- Re-pull the last N days each run (Meta restates numbers); upsert idempotently.
- Attributed revenue/ROAS from Meta is **informational only**; the profit engine uses real delivered/settled revenue.

---

## 8. Period lifecycle and the profit engine

### 8.1 Period state machine

`open` → `closing` (data freeze + checks) → `closed` (report issued, objection window starts) → `final` (auto after `finalization.days` with no open objection; objection pauses only the disputed items).
Also `reopened_for_correction` (restricted, section 8.4).

- Close day and payout day come from the profile (`closeDayOfMonth`, `payoutTargetDayOfMonth`). A scheduler creates the close checklist, reminds the finance reviewer, and the system **never auto-closes with failed checks**.
- **Pre-close checklist (blocking, configurable):** all integrations synced to month end; no unmapped courier statuses; no unmatched settlement lines; no unallocated ad spend; no draft/pending expenses dated in the period; stock reconciled; bank balance entered.
- Final is **automatic** (agreement clause 7.6). Show a countdown on every closed period. An objection (with item reference, reason, amount) pauses finality of that item only.

### 8.2 Engine: pure function

`computePeriod(input, profile) -> PeriodResult`. Input is a snapshot (ledger-derived totals), so the function is deterministic and testable. Store `inputsHash`, `engineVersion`, `profileVersion` in `period_snapshots`.

Steps (all integer paisa):

1. **Net sales** = per `revenueRecognition` (delivered / delivered+paid / delivered+COD settled) minus returns, discounts, taxes collected; exclude statuses listed.
2. **COGS** = cost of units actually sold (stock ledger valuation method from config). Unsold stock stays in inventory at prudent recoverable value; apply write-downs.
3. **Operating expenses** = sum by category (ads, fulfilment, return charges, payment fees, payroll, overhead if enabled, venture tax, provisions). Each deducted **once**. Provisions: reserving cash for a provided liability does not deduct it again.
4. `profitBeforeLosses = netSales − cogs − opex`.
5. **Loss carry-forward:** `opening = lossBalance`. If `profitBeforeLosses < 0`, `lossBalance += |loss|`, NetProfit = 0. Else `applied = min(opening, profitBeforeLosses)`, `NetProfit = profitBeforeLosses − applied`, `lossBalance = opening − applied`. Respect `scope: within_term` and exclude post-termination losses.
6. **Reinvestment** = `round(NetProfit × reinvestment.pct)`. Post to `reinvestment_fund` per `reinvestment.treatment`:
   - `expense_no_credit`: expense category `reinvestment`, no partner credit (current agreement).
   - `credit_partners_pro_rata`: also records a per-partner claim on the fund (supports the fairness options the owner is still considering). Implement both now so the owner can switch by creating a new profile version.
7. **SharedProfit** = NetProfit − Reinvestment. Allocate by `partners[].sharePct` with largest-remainder rounding.
8. **Cash safeguards:** `reserve = knownLiabilities + payrollDue + taxesDue + refundsExpected + courierReturnExposure + fixedCostsNext(bufferDays) + inventoryNeedsNext(bufferDays)`; `distributableCash = max(0, bankAndCash − reserve)`. Show the **calculation line by line** in the report. Funds sitting in the `reinvestment_fund` ledger are not distributable.
9. **Withdrawable per partner** = `min(allocationPlusUndrawn, cap if within cap months, partnerShareOfDistributableCash)`. Cap months are counted from `term.start`.
10. **Undrawn Balance** = allocation (and prior undrawn) minus withdrawals. Belongs to the partner; usable as business capital only with that partner's recorded consent.
11. **Over-distribution:** if a later correction shows a partner got more than his Final entitlement, create a **netting receivable against that partner's own future distributions**. Personal repayment is flagged only for reasons in `overDistribution.personalRepaymentOnlyFor`.
12. Output: full statement (sales to profit waterfall, per project and portfolio, prior losses, provision changes, reinvestment, allocations, withdrawals, undrawn, cash, stock ageing, courier balances), plus warnings.

### 8.3 Acceptance test vectors (must pass; from the agreement)

Using `pct=30`, `partners 50/50`, `cap=PKR 50,000 for 6 months`, sufficient cash, no loss balance:

| Net Profit | Reinvestment | Shared  | Each partner allocation | Draw (cap) | Undrawn each |
| ---------- | ------------ | ------- | ----------------------- | ---------- | ------------ |
| 0          | 0            | 0       | 0                       | 0          | 0            |
| 100,000    | 30,000       | 70,000  | 35,000                  | 35,000     | 0            |
| 200,000    | 60,000       | 140,000 | 70,000                  | 50,000     | 20,000       |
| 500,000    | 150,000      | 350,000 | 175,000                 | 50,000     | 125,000      |

- Threshold: Net Profit **142,858** is the smallest whole-rupee amount at which each partner can draw **50,000** (35% of 142,858 = 50,000.30).
- **Loss carry-forward:** month 1 loss of 80,000, month 2 profit before losses 200,000 → NetProfit 120,000 → reinvestment 36,000 → shared 84,000 → 42,000 each.
- Rounding: 3 partners at 33.34/33.33/33.33 splits with no lost or created paisa (sum of parts always equals total).
- Profile switch: a period computed with profile v1 must remain reproducible after profile v2 becomes active.
- After month 6 the cap no longer applies; reinvestment and safeguards still do.
- Idempotence: running `computePeriod` twice with the same snapshot yields identical output and the same hash.

Write these as Vitest unit tests in `packages/core` **before** the UI. Also add property-based tests (fast-check): totals always reconcile; no negative allocations; rounding never leaks paisa.

### 8.4 Corrections after Final

Final periods are immutable except through a **correction request** with a permitted reason (`finalization.correctionReasons`) within `correctionWindowMonths`, requiring approval from `owner` and `md` (or an accountant ruling when disputed). Result: reversal + new entries dated in the **current** period with a link to the original, an updated statement for the old period shown side by side, and netting under 8.2 step 11. Never silently edit history.

---

## 9. Live metrics and dashboards

**Dashboard (default: current month, switchable range, filters: store, project, courier, ad account):**

- Sales (gross, net), orders, AOV.
- Fulfilment funnel: booked → in transit → delivered, with **delivery rate, RTO rate, average delivery time**.
- **COD position:** in transit, delivered-unsettled, settled, disputed; aging.
- Ad spend, ROAS (platform), **MER** (net sales ÷ ad spend), CPA on delivered orders.
- Contribution margin after delivery cost, running **Net Profit to date** (estimate, clearly labelled "not final").
- Cash: bank balance, reserve required, distributable cash, reinvestment fund balance.
- Partner cards: allocation to date, withdrawn this month, cap remaining, undrawn balance.
- Alerts panel.

Every number links to the underlying records (drill-down to orders, shipments, expenses, journal lines). Metric definitions live in code **and** are shown in a tooltip ("how is this calculated").

Pages: Dashboard, Orders, Shipments, COD & Settlements (reconciliation + CSV import), Ads, Expenses (+ approvals), Stock (simple), Capital & Tranches, Periods (close checklist, statements, objections), Partner Accounts & Withdrawals, Configuration (Agreement Profile editor, categories, mappings, approval policy), Integrations (health), Users & Roles, Audit Log, Alerts.

Statement export: PDF and CSV, with a footer: profile version, engine version, generated-at, inputs hash.

---

## 10. Workflows

1. **Expense:** create (with receipt) → policy check → approval if needed (requester ≠ approver for material amounts) → post journal → visible in period. Hanan can create and request; owner approves per policy.
2. **Capital tranche:** propose in schedule → both partners approve → release recorded with bank reference → posts to capital account. Block release beyond envelope; warn near it.
3. **Withdrawal:** partner requests → system evaluates cap, safeguards, undrawn balance and **shows the calculation** → approver pays → posts to drawings. Never allow a withdrawal that breaks cap or safeguards without a recorded override reason approved by both partners [DEFAULT].
4. **Config change:** draft → diff → dual approval → effective date (section 4.4).
5. **Objection:** raise on a closed period item → pauses that item's finality → comments → resolution (agree adjust / accountant ruling) → correction entries.
6. **Courier settlement import:** section 7.2 step 4.

---

## 11. Alerts (in-app only)

Configurable rules (data): cash below reserve; reinvestment fund unspent beyond N days [info]; COD delivered-unsettled older than X days per courier; RTO rate above threshold; ad spend spike vs 7-day average; integration failing or token expiring; unmapped courier status; unmatched orders/shipments; period close due; period about to become Final; partner at cap; approval pending longer than 2 business days (agreement clause 6.3).

---

## 12. Security, audit and compliance

- Server-side RBAC on every route; deny by default. Resource-level checks (staff cannot see profit).
- All writes create `audit_log` entries (before/after hash, user, IP, request id). Audit log is append-only and viewable by owner, md, finance reviewer, accountant.
- Encrypted credentials; secrets never in logs; Content Security Policy; CSRF protection on mutations; rate limiting on auth; optional TOTP 2FA, **mandatory for owner and finance_reviewer** [DEFAULT].
- Backups: automated daily + point-in-time if Atlas. Document restore in `RUNBOOK.md`.
- Customer PII minimised and masked; access to full phone numbers requires a role flag. Respect Pakistani law on electronic data (PECA 2016); a data-protection statute is not yet in force as of this spec, so keep PII handling conservative.
- Do not delete data; "archive" instead. Financial records retention follows legal requirements (confirm with tax advisor).

---

## 13. Build plan (milestones, each with acceptance criteria)

**M0 — Foundations.** Monorepo, CI, lint/type/test, env validation, Mongo connection with transactions, auth + roles seed, audit middleware, `Money` helper. *Done when:* login works with roles, audit entries appear for writes.

**M1 — Config and ledger core.** Agreement Profile schema, editor, versioning, dual approval. Chart of accounts, journal engine (append-only, balanced, reversal-only). *Done when:* profile v1 can be created, approved by two users, and journal entries reject edits/deletes.

**M2 — Profit engine (pure).** `computePeriod` + all test vectors in 8.3 passing; property tests; snapshot hashing. *Done when:* tests green with 100% branch coverage on `packages/core/engine`.

**M3 — Manual operations.** Expenses, categories, approvals, capital tranches, withdrawals, simple stock ledger, periods and close checklist, statements (PDF/CSV), objections, auto-finalization scheduler. *Done when:* a full month can be run end-to-end with manual data and matches the vectors.

**M4 — Shopify.** Multi-store sync + webhooks, order normalization, refunds, product costs, unmatched queue. *Done when:* two test stores sync incrementally and idempotently.

**M5 — Couriers.** Adapter interface, mock adapters, **Leopards adapter first (real credentials)**, courier-first intake (API/CSV/bulk CN paste), matching engine and manual queue, status mapping UI, tracking sync, settlement CSV import with mapping profiles and reconciliation view; Trax and TCS adapters added when credentials exist. *Done when:* a settlement file imports, matches shipments, flags mismatches and posts entries exactly once.

**M6 — Meta Ads.** Ad accounts, daily insights sync with restatement window, store/campaign mapping, unallocated queue, card-payment reconciliation. *Done when:* ad spend flows into the correct store and the period statement.

**M7 — Dashboards and alerts.** Metrics, drill-downs, alerts engine. *Done when:* every dashboard number is traceable to records.

**M8 — Hardening.** Security review, load test with realistic volumes (e.g., 50k orders, 500k events), backup/restore drill, runbook, seed/demo data script.

---

## 14. Non-functional requirements

- Money exactness (integers); any float use in money paths fails review.
- All list views paginated server-side; imports streamed; sync jobs resumable.
- p95 page load under 1.5 s on dashboard with 12 months of data (use pre-aggregated daily rollups, rebuildable from source).
- Deterministic, reproducible statements; rebuild tooling for rollups and `partner_accounts` caches from the ledger.
- Observability: structured logs, request ids, error tracking (Sentry [DEFAULT]), job dashboards.
- Test pyramid: unit (core) → integration (Mongo in-memory replica set) → e2e (Playwright for close/withdraw/config flows).

---

## 15. Mapping from the agreement to features (traceability)

| Agreement clause (Draft 3)                      | Feature                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| 4.1, 9.1–9.3 capital, tranches, capital ledger | `capital_tranches`, `capital_muhammad`, return rules in profile              |
| 5.4 stores, pixels, ad accounts                 | `stores`, `ad_accounts`, campaign-to-division mapping, split by actual spend |
| 5.5 stock                                       | stock ledger, count requests                                                     |
| 6.1–6.6 approvals, emergency pause             | approval policy, `pause` flag on spend categories with review deadline         |
| 7.1 Finance System, entries never deleted       | append-only ledger                                                               |
| 7.2–7.4 Net Profit, losses                     | engine steps 1–5                                                                |
| 7.5 report by 10th, payout 15th                 | reporting schedule, close checklist                                              |
| 7.6 auto-Final after 30 days                    | period state machine                                                             |
| 7.7 over-distribution netting                   | engine step 11                                                                   |
| 8.1–8.2 30% reinvestment                       | engine step 6, `reinvestment_fund`                                             |
| 8.3–8.4 cap, undrawn balance                   | engine steps 9–10, partner accounts                                             |
| 8.5 cash checks, 60-day buffer                  | engine step 8 with visible calculation                                           |
| 12.9 data access, Schedule F asset register     | integrations + assets register page                                              |
| 15.1 independent accountant                     | `accountant` role, objections                                                  |
| 17.1 changes need both partners                 | dual-approval config flow                                                        |

---

## 16. Open items to resolve (put in `docs/OPEN_QUESTIONS.md` and keep the app working without them)

1. **Leopards:** share the merchant API docs. Confirm whether the API can (a) list booked packets by date range, (b) return COD settlement/payment status, (c) push webhooks. Everything else in section 7.2a has a fallback.
2. **Trax and TCS:** credentials and docs when available. Until then: mocks + CSV.
3. Reference field convention for bookings (recommended: Shopify order number).
4. Whether payroll will later need computation (currently manual entries).
5. Hosting targets (web + worker + Redis + Mongo) and backup policy.

**Resolved by owner (6 Nov 2026):** ad accounts are PKR paid by card (no FX); reinvestment treatment is edited from the admin panel (profile version, dual approval); stock valuation stays minimal with weighted average default; alerts are in-app only; matching is courier-first.

---

## 17. How to run this with Claude Code / Codex

1. Put this file at `docs/SPEC.md` in an empty repo.
2. Kickoff prompt: *"Read docs/SPEC.md fully. Start with milestone M0 and M1 only. Before coding, write a short plan and list any assumptions. Implement `packages/core` first with tests from section 8.3. Do not hard-code any business rule; read it from the Agreement Profile. Stop after each milestone and show test results."*
3. Rules for the agent: no floats for money; no updates/deletes on ledger collections; all business rules from config; every external call behind an adapter; mocks first; ask before adding dependencies not listed here.

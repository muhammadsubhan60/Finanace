# Runbook

## Local development

```bash
pnpm install
cp .env.example .env            # then set APP_ENCRYPTION_KEY=$(openssl rand -hex 32)
pnpm db:start                   # single-node replica set on :27018 (transactions need a replica set)
pnpm seed -- --demo             # config + ~6 weeks of mock data (omit --demo for config only)
pnpm dev                        # web on http://localhost:3000
pnpm worker                     # background worker (separate process)
pnpm test                       # core engine + ledger tests (Vitest + fast-check)
```

Seed users (password `SEED_PASSWORD`, default `ChangeMe!2026`): `muhammad@deltalabs.pk` (owner), `hanan@deltalabs.pk` (md), `abdur@deltalabs.pk` (finance_reviewer), `staff@deltalabs.pk`, `accountant@example.com` (90-day access). The owner and finance reviewer must enrol TOTP at first login.

## Going live with Leopards

1. Integrations → Leopards → Credentials: API key + API password (production base URL by default). Choose **Live**, Save, then **Test connection**.
2. Optionally give LCS the Push API callback `https://<host>/api/webhooks/courier/int-leopards` and a shared secret (stored as "Push API shared secret").
3. The worker then:
   - pulls bookings from the last 7 days (`getBookedPacketLastStatus`);
   - polls open CNs every `pollHours`;
   - creates settlements from `getShippingCharges`, grouped by cheque/invoice number.

## Ledger protection

- The application never updates or deletes `journal_entries` or `journal_lines`. Only `postEntry` writes them.
- Give the app a DB user that cannot delete or update ledger collections:

```js
use admin
db.createRole({ role: "deltaApp", privileges: [
  { resource: { db: "delta_finance", collection: "" }, actions: ["find","insert","update","remove","createIndex","createCollection","collMod"] },
], roles: [] })
// Ledger: insert + find only
db.createRole({ role: "deltaLedgerAppendOnly", privileges: [
  { resource: { db: "delta_finance", collection: "journal_entries" }, actions: ["find","insert"] },
  { resource: { db: "delta_finance", collection: "journal_lines" }, actions: ["find","insert"] },
  { resource: { db: "delta_finance", collection: "audit_log" }, actions: ["find","insert"] },
], roles: [] })
```

  Collection-level privileges in MongoDB are additive, so in production grant `deltaApp` per collection, excluding `journal_entries`, `journal_lines` and `audit_log`, and grant those three through `deltaLedgerAppendOnly` only.
- Hash chain: `pnpm --filter @delta/db verify-chain`. The worker also runs it nightly and raises a critical alert if the chain breaks.

## Backups and restore

- Atlas: enable continuous backup (point-in-time). Self-hosted: nightly `mongodump --oplog --gzip --archive=/backups/delta-$(date +%F).gz`, keeping 30 days.
- Restore drill (quarterly): `mongorestore --gzip --archive=<file> --oplogReplay --nsInclude='delta_finance.*'` into a scratch cluster, then run `verify-chain` and open a closed period. The statement page shows **Reproducible ✓** when the stored snapshot recomputes to the same hash.

## Drills and checks

- **Backup/restore drill** (last run 7 Nov 2026: 41 collections, 0 mismatches, chain OK): dump, then `mongorestore --nsFrom='delta_finance.*' --nsTo='delta_finance_drill.*'`. Verify counts, chain and trial balance, then drop the drill database.
- **Back up `APP_ENCRYPTION_KEY` separately** (password manager). Without it, restored integration credentials can't be decrypted.
- **Load test:** `pnpm --filter @delta/db load-test` (scratch DB `delta_finance_load`; drop it afterwards). Target: p95 < 1.5 s.
- **Engine coverage gate:** `pnpm --filter @delta/core coverage`, which must stay at 100%.

## Security setup before go-live

1. Every user changes their password in **My account**. The seed password is rejected as a new password.
2. Owner and finance reviewer enrol TOTP. It's enforced at login.
3. Leopards Push API: set the shared secret under Integrations. Until then the webhook returns 401.
4. Run behind HTTPS. HSTS is sent in production.

## Period close (finance reviewer)

1. After month end, open Periods → the month. Fix every failed blocking check (links next to each one).
2. Enter the bank balance and reserve components → **Start close** (freezes data) → **Compute and close**.
3. The statement is issued and the objection window starts. The period becomes Final automatically after `finalization.days`.

## Rotating the encryption key

Integration credentials are AES-256-GCM encrypted with `APP_ENCRYPTION_KEY`. To rotate, re-enter the credentials in the UI after changing the key. Old ciphertexts cannot be read with the new key.

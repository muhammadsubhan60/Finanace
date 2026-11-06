import type { Db } from "mongodb";

const COLLECTIONS = [
  "users", "roles", "sessions", "agreement_profiles", "stores", "projects", "integrations", "ad_accounts", "couriers",
  "orders", "order_refunds", "shipments", "shipment_events", "cod_settlements", "cod_settlement_lines", "ad_spend_daily",
  "expenses", "stock_items", "stock_movements", "capital_tranches", "journal_entries", "journal_lines", "accounts", "periods",
  "period_snapshots", "partner_accounts", "withdrawals", "objections", "approvals", "audit_log", "alerts", "alert_rules",
  "import_jobs", "sync_runs", "counters", "job_locks", "mapping_profiles", "unmapped_statuses", "bank_balances", "manual_links",
];

/** Validators that make the ledger structurally append-friendly; deletes/updates are blocked by the app DB role (see RUNBOOK). */
const VALIDATORS: Record<string, object> = {
  journal_entries: {
    $jsonSchema: {
      bsonType: "object",
      required: ["orgId", "date", "periodId", "source", "lines", "seq", "hash", "prevHash"],
      properties: {
        date: { bsonType: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        seq: { bsonType: ["int", "long", "double"] },
        lines: { bsonType: "array", minItems: 2 },
      },
    },
  },
  journal_lines: {
    $jsonSchema: {
      bsonType: "object",
      required: ["orgId", "entryId", "accountId", "debitMinor", "creditMinor", "periodId"],
      properties: { debitMinor: { bsonType: ["int", "long", "double"], minimum: 0, multipleOf: 1 }, creditMinor: { bsonType: ["int", "long", "double"], minimum: 0, multipleOf: 1 } },
    },
  },
};

export async function ensureSchema(db: Db) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const name of COLLECTIONS) {
    if (!existing.has(name)) await db.createCollection(name, VALIDATORS[name] ? { validator: VALIDATORS[name], validationLevel: "strict" } : {});
    else if (VALIDATORS[name]) await db.command({ collMod: name, validator: VALIDATORS[name], validationLevel: "strict" });
  }
  const ix = (c: string, spec: Record<string, 1 | -1>, opts: { unique?: boolean; partialFilterExpression?: object; expireAfterSeconds?: number } = {}) => db.collection(c).createIndex(spec, opts);
  await Promise.all([
    ix("users", { orgId: 1, email: 1 }, { unique: true }),
    ix("sessions", { expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ix("agreement_profiles", { orgId: 1, version: 1 }, { unique: true }),
    ix("journal_entries", { orgId: 1, seq: 1 }, { unique: true }),
    ix("journal_entries", { orgId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }),
    ix("journal_entries", { orgId: 1, periodId: 1 }),
    ix("journal_lines", { orgId: 1, periodId: 1, accountId: 1 }),
    // Covered indexes for balance aggregations (no document fetch): by date range and by period.
    ix("journal_lines", { orgId: 1, date: 1, source: 1, accountId: 1, debitMinor: 1, creditMinor: 1 }),
    ix("journal_lines", { orgId: 1, periodId: 1, source: 1, accountId: 1, debitMinor: 1, creditMinor: 1 }),
    ix("journal_lines", { orgId: 1, storeId: 1, date: 1, source: 1, accountId: 1, debitMinor: 1, creditMinor: 1 }),
    ix("shipments", { orgId: 1, storeId: 1, bookedAt: -1 }),
    ix("orders", { orgId: 1, createdAt: -1 }),
    ix("journal_lines", { orgId: 1, refType: 1, refId: 1 }),
    ix("orders", { orgId: 1, storeId: 1, externalId: 1 }, { unique: true }),
    ix("orders", { orgId: 1, name: 1 }),
    ix("shipments", { orgId: 1, courierId: 1, cn: 1 }, { unique: true }),
    ix("shipments", { orgId: 1, normalizedStatus: 1, bookedAt: -1 }),
    ix("shipments", { orgId: 1, orderId: 1 }),
    ix("shipment_events", { orgId: 1, dedupeKey: 1 }, { unique: true }),
    ix("shipment_events", { orgId: 1, cn: 1, eventAt: -1 }),
    ix("cod_settlements", { orgId: 1, courierId: 1, reference: 1 }, { unique: true }),
    ix("cod_settlement_lines", { orgId: 1, settlementId: 1 }),
    ix("ad_spend_daily", { orgId: 1, adAccountId: 1, date: 1, campaignId: 1 }, { unique: true }),
    ix("expenses", { orgId: 1, date: -1 }),
    ix("periods", { orgId: 1, periodId: 1 }, { unique: true }),
    ix("period_snapshots", { orgId: 1, periodId: 1, createdAt: -1 }),
    ix("audit_log", { orgId: 1, at: -1 }),
    ix("alerts", { orgId: 1, dedupeKey: 1 }, { unique: true }),
    ix("import_jobs", { orgId: 1, fileHash: 1, kind: 1 }),
    ix("approvals", { orgId: 1, status: 1 }),
  ]);
}

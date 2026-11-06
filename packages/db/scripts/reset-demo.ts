/**
 * One-time owner-approved reset (6 Nov 2026, option A): remove demo-generated data before importing real history.
 * Keeps users (incl. TOTP), roles, sessions, Agreement Profiles, accounts, stores, projects, couriers, ad accounts,
 * integrations (encrypted credentials), alert rules and the audit log. Take a mongodump first (see RUNBOOK).
 */
import { audit, closeDb, getDb, ORG_ID, systemCtx } from "../src";

const CLEAR = [
  "orders", "order_refunds", "shipments", "shipment_events", "cod_settlements", "cod_settlement_lines", "ad_spend_daily",
  "expenses", "stock_items", "stock_movements", "stock_counts", "capital_tranches", "journal_entries", "journal_lines",
  "counters", "periods", "period_snapshots", "partner_accounts", "withdrawals", "objections", "approvals", "alerts",
  "import_jobs", "sync_runs", "jobs", "job_locks", "mapping_profiles", "unmapped_statuses", "manual_links",
  "netting_receivables", "corrections", "webhook_events", "login_attempts", "bank_balances",
];

const db = await getDb();
const before: Record<string, number> = {};
for (const c of CLEAR) before[c] = await db.collection(c).countDocuments();
console.log("before:", Object.fromEntries(Object.entries(before).filter(([, n]) => n)));
for (const c of CLEAR) await db.collection(c).deleteMany({});
// Mock Shopify/Meta would regenerate fake orders and ad spend; switch them off until real credentials exist.
const off = await db.collection("integrations").updateMany({ orgId: ORG_ID, type: { $in: ["shopify", "meta"] }, mode: "mock" }, { $set: { enabled: false, lastSuccessAt: null, cursor: null } });
await db.collection("integrations").updateMany({ orgId: ORG_ID }, { $set: { lastError: null, errorCount: 0 } });
await audit(systemCtx("owner-approved-reset"), "data.reset_demo", "database", "delta_finance", before, { cleared: CLEAR, mockIntegrationsDisabled: off.modifiedCount, reason: "Owner chose option A: replace demo data with real Leopards history" });
const left: Record<string, number> = {};
for (const c of CLEAR) left[c] = await db.collection(c).countDocuments();
console.log("after: all cleared =", Object.values(left).every((n) => n === 0), "· mock integrations disabled:", off.modifiedCount);
console.log("kept:", { users: await db.collection("users").countDocuments(), profiles: await db.collection("agreement_profiles").countDocuments(), integrations: await db.collection("integrations").countDocuments(), audit_log: await db.collection("audit_log").countDocuments() });
await closeDb();

/**
 * Seed: roles, users, Agreement Profile v1 (Draft 3), chart of accounts, stores, couriers, integrations (mock), alert rules.
 *   pnpm seed            → base config only (idempotent)
 *   pnpm seed --demo     → also generates ~6 weeks of mock orders, shipments, settlements, ad spend, expenses
 */
import { AgreementProfile, SEED_PROFILE } from "@delta/config-schema";
import { addDays, karachiDate, periodIdOf } from "@delta/core";
import { mockOrders, MockCourierAdapter } from "@delta/integrations";
import {
  closeDb, ensureSchema, getDb, hashPassword, ORG_ID, SEED_ROLES, seedAccounts, SEED_ALERT_RULES, systemCtx,
  upsertOrder, upsertShipment, applyTracking, runMatching, recordSettlement, runIntegration, post, purchaseStock, ensurePeriod,
} from "../src";

const demo = process.argv.includes("--demo");
const PASSWORD = process.env.SEED_PASSWORD ?? "ChangeMe!2026";

async function main() {
  const db = await getDb();
  await ensureSchema(db);
  const now = new Date();
  const up = (col: string, _id: string, doc: Record<string, unknown>) => db.collection(col).updateOne({ _id: _id as never }, { $setOnInsert: { _id, orgId: ORG_ID, createdAt: now, createdBy: "seed", ...doc } }, { upsert: true });

  for (const r of SEED_ROLES) await up("roles", `role:${r.key}`, r);
  const users = [
    { email: "muhammad@deltalabs.pk", name: "Muhammad Subhan", role: "owner", partnerId: "muhammad" },
    { email: "hanan@deltalabs.pk", name: "Hanan", role: "md", partnerId: "hanan" },
    { email: "abdur@deltalabs.pk", name: "Abdur Rehman", role: "finance_reviewer" },
    { email: "staff@deltalabs.pk", name: "Ops Staff", role: "staff" },
    { email: "accountant@example.com", name: "Independent Accountant", role: "accountant", accessExpiresAt: new Date(Date.now() + 90 * 86_400_000) },
  ];
  for (const u of users) await up("users", `user:${u.role}`, { ...u, passwordHash: hashPassword(PASSWORD), status: "active", totpSecret: null });

  const profile = AgreementProfile.parse({ ...SEED_PROFILE, partners: SEED_PROFILE.partners.map((p) => ({ ...p, userId: p.partnerId === "muhammad" ? "user:owner" : "user:md" })) });
  await up("agreement_profiles", "profile-v1", { ...profile, activatedAt: now, changeNote: "Seed: agreement Draft 3" });
  for (const a of seedAccounts(profile)) await up("accounts", a._id, a);
  for (const r of SEED_ALERT_RULES) await up("alert_rules", `rule:${r.key}`, r);

  await up("projects", "proj-apparel", { name: "Apparel brand", brand: "Delta Wear", launchDate: "2026-11-09", fundingTranche: null, exclusions: [], inDivision: true });
  await up("projects", "proj-home", { name: "Home goods", brand: "Delta Home", launchDate: "2026-11-09", fundingTranche: null, exclusions: [], inDivision: true });
  await up("stores", "store-wear", { name: "Delta Wear", platform: "shopify", domain: "delta-wear.myshopify.com", projectId: "proj-apparel", status: "active" });
  await up("stores", "store-home", { name: "Delta Home", platform: "shopify", domain: "delta-home.myshopify.com", projectId: "proj-home", status: "active" });
  await up("couriers", "courier-leopards", { provider: "leopards", label: "Leopards (LCS)", costCentre: null, defaultStoreId: null, pollHours: 4 });
  await up("couriers", "courier-trax", { provider: "trax", label: "Trax", costCentre: null, defaultStoreId: null, pollHours: 6 });
  await up("couriers", "courier-tcs", { provider: "tcs", label: "TCS", costCentre: null, defaultStoreId: null, pollHours: 6 });
  await up("ad_accounts", "adacct-main", { externalId: "1234567890", label: "Delta Labs main", currency: "PKR", storeIds: ["store-wear", "store-home"], pixelIds: [], status: "active", dedicated: false, campaignMap: { "c-prospecting": { division: "local-ecom", storeId: "store-wear" }, "c-retargeting": { division: "local-ecom", storeId: "store-home" } } });

  const integ = (id: string, d: Record<string, unknown>) => up("integrations", id, { mode: "mock", credentialsEnc: null, enabled: true, settings: {}, cursor: null, lastSuccessAt: null, lastError: null, errorCount: 0, ...d });
  await integ("int-shopify-wear", { type: "shopify", provider: "shopify", label: "Shopify — Delta Wear", refId: "store-wear", settings: { apiVersion: "2026-10" } });
  await integ("int-shopify-home", { type: "shopify", provider: "shopify", label: "Shopify — Delta Home", refId: "store-home", settings: { apiVersion: "2026-10" } });
  await integ("int-leopards", { type: "courier", provider: "leopards", label: "Leopards (LCS)", refId: "courier-leopards", settings: { pollHours: 4 } });
  await integ("int-trax", { type: "courier", provider: "trax", label: "Trax", refId: "courier-trax", enabled: false, settings: { pollHours: 6 } });
  await integ("int-tcs", { type: "courier", provider: "tcs", label: "TCS", refId: "courier-tcs", enabled: false, settings: { pollHours: 6 } });
  await integ("int-meta", { type: "meta", provider: "meta", label: "Meta Ads — main", refId: "adacct-main", settings: { restateDays: 7, apiVersion: "v24.0" } });
  console.log(`Seeded. Users (password "${PASSWORD}"):`, users.map((u) => u.email).join(", "));

  if (demo) await seedDemo(profile);
}

async function seedDemo(profile: AgreementProfile) {
  const db = await getDb();
  if (await db.collection("orders").estimatedDocumentCount()) return console.log("Demo data already present — skipped.");
  const ctx = systemCtx("demo-seed");
  const start = new Date(Date.now() - 40 * 86_400_000);
  const startDate = karachiDate(start);
  await ensurePeriod(periodIdOf(startDate));

  // Capital + stock
  await post(ctx, { type: "capital_tranche_released", date: startDate, trancheId: "demo-t1", amountMinor: 150_000_000, providerPartnerId: "muhammad", bankRef: "DEMO-HBL-001" }, profile);
  await db.collection("capital_tranches").insertOne({ _id: "demo-t1" as never, orgId: ORG_ID, amountMinor: 150_000_000, purpose: "Initial stock and ads", plannedDate: startDate, status: "released", releaseDate: startDate, bankRef: "DEMO-HBL-001", createdAt: new Date(), createdBy: "seed" });
  for (const [sku, title, qty, cost] of [["TSH-01", "Cotton T-Shirt", 400, "280000"], ["HOD-02", "Fleece Hoodie", 150, "270000"], ["CAP-03", "Baseball Cap", 300, "90000"], ["JNS-04", "Denim Jeans", 200, "280000"]] as const)
    await purchaseStock({ ...ctx, permissions: ["*"] }, { sku, title, quantity: qty, totalCost: cost, date: startDate, paidFrom: "bank" });

  // Orders → bookings in "the courier portal" (85% with order ref) → tracking → settlements
  const courier = new MockCourierAdapter("leopards");
  let cnN = 1;
  for (const storeId of ["store-wear", "store-home"]) {
    const orders = mockOrders(storeId, start, 40, storeId === "store-wear" ? 7 : 4);
    for (const o of orders) {
      await upsertOrder(ORG_ID, storeId, o);
      if (o.cancelledAt || o.paymentMethod !== "cod") continue;
      const cn = `KI${String(700000000 + cnN++).padStart(9, "0")}`;
      const booked = new Date(Date.parse(o.createdAt) + 6 * 3_600_000);
      const withRef = cnN % 7 !== 0;
      const id = await upsertShipment(ctx, "courier-leopards", { cn, orderRef: withRef ? o.name : null, codMinor: o.totalMinor, consignee: o.customer, bookedAt: booked.toISOString(), providerStatus: "", events: [] }, "csv");
      const mc = new MockCourierAdapter("leopards", () => booked);
      await applyTracking(ctx, id, await mc.fetchTracking(cn));
    }
  }
  void courier;
  await runMatching(ctx);

  // Weekly settlements for parcels delivered ≥ 4 days ago
  const delivered = await db.collection("shipments").find({ orgId: ORG_ID, normalizedStatus: "delivered", deliveredAt: { $lt: new Date(Date.now() - 4 * 86_400_000) } }).sort({ deliveredAt: 1 }).toArray();
  const weeks = new Map<string, typeof delivered>();
  for (const s of delivered) {
    const wk = karachiDate(new Date(s.deliveredAt.getTime() - (s.deliveredAt.getDay() * 86_400_000)));
    weeks.set(wk, [...(weeks.get(wk) ?? []), s]);
  }
  let n = 1;
  for (const [wk, list] of weeks) {
    const date = addDays(wk, 7) > karachiDate() ? karachiDate() : addDays(wk, 7);
    await recordSettlement(ctx, { courierId: "courier-leopards", reference: `LCS-CHQ-${1000 + n++}`, date, source: "csv", lines: list.map((s) => ({ cn: s.cn, codMinor: s.codAmountMinor, freightMinor: 18_000, codFeeMinor: Math.round(s.codAmountMinor * 0.01), returnFeeMinor: 0 })) });
  }

  // Ads via the mock Meta integration (30 days), and a few manual expenses posted directly
  await runIntegration("int-meta", { from: addDays(karachiDate(), -38), to: karachiDate() });
  for (const [cat, amt, payee, day] of [["payroll", 15_000_000, "Team salaries", 25], ["fulfilment_delivery", 2_500_000, "Packaging supplies", 30], ["other", 800_000, "Product photography", 33]] as const) {
    const id = `demo-exp-${cat}`;
    const date = addDays(startDate, day);
    await db.collection("expenses").insertOne({ _id: id as never, orgId: ORG_ID, categoryKey: cat, amountMinor: amt, date, payee, recurring: false, paidFrom: "bank", receipts: [], status: "posted", source: "manual", requesterId: "user:md", requesterName: "Hanan", createdAt: new Date(), updatedAt: new Date() });
    await post(ctx, { type: "expense_posted", date, expenseId: id, categoryKey: cat, amountMinor: amt, paidFrom: "bank" }, profile);
  }
  await db.collection("integrations").updateMany({ orgId: ORG_ID, enabled: true }, { $set: { lastSuccessAt: new Date() } });
  console.log("Demo data created:", await db.collection("orders").countDocuments(), "orders,", await db.collection("shipments").countDocuments(), "shipments,", n - 1, "settlements");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);

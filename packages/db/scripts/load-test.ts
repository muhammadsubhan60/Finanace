/**
 * M8 load test on a scratch database (MONGODB_DB=delta_finance_load): 50k orders, 50k shipments, 500k events,
 * 12 months of settlements, ad spend and journal lines; then times the dashboard and heavy page queries.
 *   pnpm --filter @delta/db load-test            (generate + measure)
 *   pnpm --filter @delta/db load-test --measure  (measure only)
 */
process.env.MONGODB_DB = "delta_finance_load";
import { AgreementProfile, SEED_PROFILE } from "@delta/config-schema";
import { addDays, karachiDate } from "@delta/core";
import { closeDb, dashboard, ensureSchema, estimatePeriod, getDb, ORG_ID, seedAccounts } from "../src";

const N_ORDERS = 50_000;
const EVENTS_PER_SHIPMENT = 10;
const measureOnly = process.argv.includes("--measure");
const rnd = (() => { let s = 42; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
const STATUS = ["delivered", "delivered", "delivered", "delivered", "delivered", "delivered", "returned_to_origin", "returned_to_origin", "in_transit", "booked"] as const;

async function generate() {
  const db = await getDb();
  await db.dropDatabase();
  await ensureSchema(db);
  const profile = AgreementProfile.parse(SEED_PROFILE);
  await db.collection("agreement_profiles").insertOne({ _id: "profile-v1" as never, ...profile, activatedAt: new Date(), createdAt: new Date(), createdBy: "load" });
  await db.collection("accounts").insertMany(seedAccounts(profile).map((a) => ({ ...a, orgId: ORG_ID })) as never[]);
  await db.collection("couriers").insertOne({ _id: "courier-leopards" as never, orgId: ORG_ID, provider: "leopards", label: "Leopards" });
  const start = Date.parse(addDays(karachiDate(), -365) + "T05:00:00Z");
  const t0 = Date.now();
  const B = 5_000;
  let lineSeq = 0;
  for (let b = 0; b < N_ORDERS; b += B) {
    const orders = [], ships = [], events = [], jl = [], sl = [];
    for (let i = b; i < Math.min(N_ORDERS, b + B); i++) {
      const created = new Date(start + Math.floor((i / N_ORDERS) * 365 * 86_400_000));
      const cod = (1 + Math.floor(rnd() * 3)) * 119_900;
      const st = STATUS[Math.floor(rnd() * STATUS.length)]!;
      const delivered = st === "delivered" ? new Date(created.getTime() + (2 + rnd() * 4) * 86_400_000) : null;
      const settled = st === "delivered" && delivered!.getTime() < Date.now() - 7 * 86_400_000;
      const sid = `s${i}`;
      orders.push({ _id: `o${i}`, orgId: ORG_ID, storeId: i % 2 ? "store-a" : "store-b", externalId: `x${i}`, name: `#${10_000 + i}`, createdAt: created, paymentMethod: "cod", totalMinor: cod, customer: { name: "C", phone: `0300${String(i).padStart(7, "0")}`, city: "Lahore" }, lineItems: [], trackingNumbers: [], status: "open" });
      ships.push({ _id: sid, orgId: ORG_ID, courierId: "courier-leopards", provider: "leopards", cn: `LT${String(i).padStart(10, "0")}`, orderRef: `#${10_000 + i}`, orderId: `o${i}`, storeId: i % 2 ? "store-a" : "store-b", codAmountMinor: cod, normalizedStatus: st, providerStatus: st, consignee: {}, bookedAt: created, bookedDate: karachiDate(created), deliveredAt: delivered, rtoAt: null, settlementId: settled ? `set-${Math.floor(i / 200)}` : null, revenueRecognized: settled, cogsMinor: 35_000, cogsEstimated: false, source: "api", createdAt: created, updatedAt: created });
      for (let e = 0; e < EVENTS_PER_SHIPMENT; e++) events.push({ orgId: ORG_ID, dedupeKey: `${sid}:${e}`, shipmentId: sid, cn: `LT${String(i).padStart(10, "0")}`, provider: "leopards", providerStatus: "Dispatched", normalizedStatus: "in_transit", eventAt: new Date(created.getTime() + e * 3_600_000), createdAt: created });
      if (settled) {
        const date = karachiDate(new Date(delivered!.getTime() + 7 * 86_400_000));
        const base = { orgId: ORG_ID, entryId: `e-${Math.floor(i / 200)}`, date, periodId: date.slice(0, 7), source: "cod_settlement", storeId: i % 2 ? "store-a" : "store-b" };
        jl.push({ _id: `l${lineSeq++}`, ...base, accountId: "sales", debitMinor: 0, creditMinor: cod }, { _id: `l${lineSeq++}`, ...base, accountId: "exp_cogs", debitMinor: 35_000, creditMinor: 0 }, { _id: `l${lineSeq++}`, ...base, accountId: "inventory", debitMinor: 0, creditMinor: 35_000 }, { _id: `l${lineSeq++}`, ...base, accountId: "bank", debitMinor: cod - 20_000, creditMinor: 0 }, { _id: `l${lineSeq++}`, ...base, accountId: "exp_fulfilment_delivery", debitMinor: 20_000, creditMinor: 0 });
        sl.push({ orgId: ORG_ID, settlementId: `set-${Math.floor(i / 200)}`, courierId: "courier-leopards", cn: `LT${i}`, codMinor: cod, flag: "ok", resolved: true });
      }
    }
    await db.collection("orders").insertMany(orders as never[], { ordered: false });
    await db.collection("shipments").insertMany(ships as never[], { ordered: false });
    await db.collection("shipment_events").insertMany(events as never[], { ordered: false });
    if (jl.length) await db.collection("journal_lines").insertMany(jl as never[], { ordered: false });
    if (sl.length) await db.collection("cod_settlement_lines").insertMany(sl as never[], { ordered: false });
  }
  const ads = [];
  for (let d = 0; d < 365; d++) for (const c of ["c1", "c2", "c3"]) ads.push({ orgId: ORG_ID, adAccountId: "adacct", date: addDays(karachiDate(), -365 + d), campaignId: c, campaignName: c, spendMinor: 800_000, revenueMinor: 2_000_000, purchases: 5, allocation: "division", storeId: "store-a" });
  await db.collection("ad_spend_daily").insertMany(ads as never[]);
  const counts = Object.fromEntries(await Promise.all(["orders", "shipments", "shipment_events", "journal_lines", "cod_settlement_lines", "ad_spend_daily"].map(async (c) => [c, await db.collection(c).estimatedDocumentCount()])));
  console.log(`generated in ${((Date.now() - t0) / 1000).toFixed(1)} s:`, counts);
}

async function time<T>(label: string, fn: () => Promise<T>, runs = 5) {
  await fn(); // warm
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  const p95 = ms[Math.min(ms.length - 1, Math.ceil(ms.length * 0.95) - 1)]!;
  console.log(`${label.padEnd(44)} median ${ms[Math.floor(ms.length / 2)]!.toFixed(0).padStart(5)} ms · p95 ${p95.toFixed(0).padStart(5)} ms ${p95 > 1500 ? "✗ over 1.5 s" : "✓"}`);
  return p95;
}

async function measure() {
  const db = await getDb();
  await ensureSchema(db); // indexes/validators current
  const today = karachiDate();
  await time("dashboard: current month", () => dashboard(ORG_ID, { from: `${today.slice(0, 7)}-01`, to: today }));
  await time("dashboard: 12 months", () => dashboard(ORG_ID, { from: addDays(today, -365), to: today }));
  await time("dashboard: 12 months, one store", () => dashboard(ORG_ID, { from: addDays(today, -365), to: today, storeId: "store-a" }));
  await time("period estimate (engine on ledger)", () => estimatePeriod(ORG_ID, addDays(today, -40).slice(0, 7)));
  await time("shipments list page + count (status filter)", () => Promise.all([db.collection("shipments").find({ orgId: ORG_ID, normalizedStatus: "delivered" }).sort({ bookedAt: -1 }).limit(50).toArray(), db.collection("shipments").countDocuments({ orgId: ORG_ID, normalizedStatus: "delivered" })]));
  await time("orders list page + count", () => Promise.all([db.collection("orders").find({ orgId: ORG_ID }).sort({ createdAt: -1 }).limit(50).toArray(), db.collection("orders").countDocuments({ orgId: ORG_ID })]));
  await time("journal drill-down (sales, 1 month)", () => db.collection("journal_lines").find({ orgId: ORG_ID, accountId: "sales", periodId: addDays(today, -40).slice(0, 7) }).sort({ date: -1 }).limit(100).toArray());
  await time("tracking events for one CN", () => db.collection("shipment_events").find({ orgId: ORG_ID, cn: "LT0000025000" }).sort({ eventAt: -1 }).toArray());
}

if (!measureOnly) await generate();
await measure();
await closeDb();

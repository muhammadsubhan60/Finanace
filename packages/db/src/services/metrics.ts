import { agingBucket, karachiDate, karachiStartOfDayUtc, periodIdOf, ratio, safeDiv, addDays } from "@delta/core";
import { getDb } from "../client";
import { balances, crBal, dr } from "../journal";
import { estimatePeriod, type SnapshotDoc } from "./periods";
import { getCurrentProfile } from "./profile";
import type { ShipmentDoc } from "./couriers";

export interface DashFilters {
  from: string;
  to: string;
  storeId?: string;
  courierId?: string;
  adAccountId?: string;
}

/** All dashboard figures. Every figure is computed from records the UI can drill into. */
export async function dashboard(orgId: string, f: DashFilters) {
  const db = await getDb();
  const fromUtc = karachiStartOfDayUtc(f.from);
  const toUtc = karachiStartOfDayUtc(addDays(f.to, 1));
  // Independent queries start immediately and run concurrently with the aggregations below.
  const tail = Promise.all([
    balances(orgId, { date: { $lte: karachiDate() } }),
    estimatePeriod(orgId, periodIdOf(karachiDate())),
    latestClosedSnapshot(orgId),
    db.collection("shipments").countDocuments({ orgId, orderId: null }),
    db.collection("orders").countDocuments({ orgId, createdAt: { $gte: fromUtc, $lt: toUtc }, ...(f.storeId ? { storeId: f.storeId } : {}) }),
  ]);
  const sMatch: Record<string, unknown> = { orgId, bookedAt: { $gte: fromUtc, $lt: toUtc } };
  if (f.storeId) sMatch.storeId = f.storeId;
  if (f.courierId) sMatch.courierId = f.courierId;
  const [funnel] = await db.collection<ShipmentDoc>("shipments").aggregate<{
    booked: number; delivered: number; rto: number; inTransit: number; deliveredValue: number; deliveryDaysSum: number; deliveryDaysN: number;
  }>([
    { $match: sMatch },
    {
      $group: {
        _id: null,
        booked: { $sum: 1 },
        delivered: { $sum: { $cond: [{ $eq: ["$normalizedStatus", "delivered"] }, 1, 0] } },
        rto: { $sum: { $cond: [{ $eq: ["$normalizedStatus", "returned_to_origin"] }, 1, 0] } },
        inTransit: { $sum: { $cond: [{ $in: ["$normalizedStatus", ["booked", "picked_up", "in_transit", "out_for_delivery", "delivery_attempted", "return_initiated"]] }, 1, 0] } },
        deliveredValue: { $sum: { $cond: [{ $eq: ["$normalizedStatus", "delivered"] }, "$codAmountMinor", 0] } },
        deliveryDaysSum: { $sum: { $cond: [{ $and: [{ $eq: ["$normalizedStatus", "delivered"] }, { $ne: ["$deliveredAt", null] }] }, { $divide: [{ $subtract: ["$deliveredAt", "$bookedAt"] }, 86_400_000] }, 0] } },
        deliveryDaysN: { $sum: { $cond: [{ $and: [{ $eq: ["$normalizedStatus", "delivered"] }, { $ne: ["$deliveredAt", null] }] }, 1, 0] } },
      },
    },
  ]).toArray();
  const fn = funnel ?? { booked: 0, delivered: 0, rto: 0, inTransit: 0, deliveredValue: 0, deliveryDaysSum: 0, deliveryDaysN: 0 };

  // COD position (all time, not range-limited — it is a balance)
  const cMatch: Record<string, unknown> = { orgId };
  if (f.courierId) cMatch.courierId = f.courierId;
  if (f.storeId) cMatch.storeId = f.storeId;
  const profile = await getCurrentProfile();
  const today = karachiDate();
  // COD position aggregated in the database (no per-shipment documents loaded into memory).
  const nowMs = Date.now();
  const bucketBounds = profile.agingBucketsDays;
  const codRows = await db.collection<ShipmentDoc>("shipments").aggregate<{ _id: { kind: string; days: number | null }; v: number }>([
    { $match: { ...cMatch, normalizedStatus: { $nin: ["returned_to_origin", "cancelled", "lost_or_damaged"] } } },
    {
      $group: {
        _id: {
          kind: { $cond: [{ $ne: ["$settlementId", null] }, "settled", { $cond: [{ $eq: ["$normalizedStatus", "delivered"] }, "unsettled", "transit"] }] },
          days: { $cond: [{ $and: [{ $eq: ["$settlementId", null] }, { $eq: ["$normalizedStatus", "delivered"] }, { $ne: ["$deliveredAt", null] }] }, { $floor: { $divide: [{ $subtract: [new Date(nowMs), "$deliveredAt"] }, 86_400_000] } }, null] },
        },
        v: { $sum: "$codAmountMinor" },
      },
    },
  ]).toArray();
  const codPos = { inTransitMinor: 0, deliveredUnsettledMinor: 0, settledMinor: 0, aging: {} as Record<string, number> };
  for (const r of codRows) {
    if (r._id.kind === "settled") codPos.settledMinor += r.v;
    else if (r._id.kind === "transit") codPos.inTransitMinor += r.v;
    else {
      codPos.deliveredUnsettledMinor += r.v;
      const b = agingBucket(r._id.days ?? 0, bucketBounds);
      codPos.aging[b] = (codPos.aging[b] ?? 0) + r.v;
    }
  }
  const disputed = await db.collection("cod_settlement_lines").aggregate<{ t: number }>([{ $match: { orgId, resolved: false, ...(f.courierId ? { courierId: f.courierId } : {}) } }, { $group: { _id: null, t: { $sum: "$codMinor" } } }]).next();

  // Ads
  const aMatch: Record<string, unknown> = { orgId, date: { $gte: f.from, $lte: f.to }, allocation: "division" };
  if (f.adAccountId) aMatch.adAccountId = f.adAccountId;
  if (f.storeId) aMatch.storeId = f.storeId;
  const ads = (await db.collection("ad_spend_daily").aggregate<{ spend: number; rev: number }>([{ $match: aMatch }, { $group: { _id: null, spend: { $sum: "$spendMinor" }, rev: { $sum: "$revenueMinor" } } }]).next()) ?? { spend: 0, rev: 0 };
  const adSeries = await db.collection("ad_spend_daily").aggregate<{ _id: string; spend: number }>([{ $match: aMatch }, { $group: { _id: "$date", spend: { $sum: "$spendMinor" } } }, { $sort: { _id: 1 } }]).toArray();

  // Ledger-based sales (net) in range
  const lMatch: Record<string, unknown> = { date: { $gte: f.from, $lte: f.to }, source: { $nin: ["period_close"] } };
  if (f.storeId) lMatch.storeId = f.storeId;
  const b = await balances(orgId, lMatch);
  const netSales = crBal(b, "sales") - dr(b, "sales_returns_discounts") - dr(b, "sales_refunds");
  const cogs = dr(b, "exp_cogs");
  const deliveryCosts = dr(b, "exp_fulfilment_delivery") + dr(b, "exp_return_charges") + dr(b, "exp_payment_fees");
  const adsLedger = dr(b, "exp_ads");

  // Daily sales series from delivered shipments
  const series = await db.collection<ShipmentDoc>("shipments").aggregate<{ _id: string; delivered: number; value: number }>([
    { $match: { ...sMatch, normalizedStatus: "delivered" } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$deliveredAt", timezone: "Asia/Karachi" } }, delivered: { $sum: 1 }, value: { $sum: "$codAmountMinor" } } },
    { $sort: { _id: 1 } },
  ]).toArray();

  // Cash + engine estimate for current month
  const [all, est, latestSnap, unmatched, ordersCount] = await tail;

  return {
    sales: { grossMinor: fn.deliveredValue, netMinor: netSales, orders: ordersCount, shipments: fn.booked, aovMinor: safeDiv(fn.deliveredValue, fn.delivered) },
    funnel: { booked: fn.booked, inTransit: fn.inTransit, delivered: fn.delivered, rto: fn.rto, deliveryRate: ratio(fn.delivered, fn.delivered + fn.rto), rtoRate: ratio(fn.rto, fn.delivered + fn.rto), avgDeliveryDays: fn.deliveryDaysN ? fn.deliveryDaysSum / fn.deliveryDaysN : null },
    cod: { ...codPos, disputedMinor: disputed?.t ?? 0 },
    ads: { spendMinor: ads.spend, roas: ratio(ads.rev, ads.spend), mer: ratio(netSales, ads.spend), cpaDeliveredMinor: safeDiv(ads.spend, fn.delivered), series: adSeries },
    margin: { contributionMinor: netSales - cogs - adsLedger - deliveryCosts },
    profitToDate: { netProfitMinor: est.result.netProfitMinor, periodId: est.result.periodId, warnings: est.result.warnings },
    cash: { bankMinor: dr(all, "bank") + dr(all, "cash"), reserveMinor: est.result.cash.reserveMinor, distributableMinor: est.result.cash.distributableMinor, reinvestmentFundMinor: crBal(all, "reinvestment_fund") },
    partners: await partnerCards(orgId, latestSnap),
    series,
    unmatched,
  };
}

async function latestClosedSnapshot(orgId: string) {
  const db = await getDb();
  const p = await db.collection("periods").find({ orgId, status: { $in: ["closed", "final"] } }).sort({ periodId: -1 }).limit(1).next();
  return p?.snapshotId ? db.collection<SnapshotDoc>("period_snapshots").findOne({ _id: p.snapshotId }) : null;
}

export async function partnerCards(orgId: string, latest?: SnapshotDoc | null) {
  const db = await getDb();
  const profile = await getCurrentProfile();
  const snap = latest === undefined ? await latestClosedSnapshot(orgId) : latest;
  const thisMonth = periodIdOf(karachiDate());
  const allSnaps = await db.collection<SnapshotDoc>("period_snapshots").find({ orgId, kind: "close" }).toArray();
  const out = [];
  for (const p of profile.partners) {
    const allocated = allSnaps.reduce((s, x) => s + (x.result.partners.find((y) => y.partnerId === p.partnerId)?.allocationMinor ?? 0), 0);
    const w = await db.collection("withdrawals").aggregate<{ _id: null; all: number; month: number }>([
      { $match: { orgId, partnerId: p.partnerId, status: "paid" } },
      { $group: { _id: null, all: { $sum: "$amountMinor" }, month: { $sum: { $cond: [{ $eq: [{ $dateToString: { format: "%Y-%m", date: "$paidAt", timezone: "Asia/Karachi" } }, thisMonth] }, "$amountMinor", 0] } } } },
    ]).next();
    const net = await db.collection("netting_receivables").aggregate<{ t: number }>([{ $match: { orgId, partnerId: p.partnerId } }, { $group: { _id: null, t: { $sum: "$amountMinor" } } }]).next();
    const pr = snap?.result.partners.find((x) => x.partnerId === p.partnerId);
    const wSnap = snap ? await db.collection("withdrawals").aggregate<{ t: number }>([{ $match: { orgId, partnerId: p.partnerId, periodId: snap.periodId, status: { $in: ["approved", "paid"] } } }, { $group: { _id: null, t: { $sum: "$amountMinor" } } }]).next() : null;
    out.push({
      partnerId: p.partnerId,
      label: p.label,
      sharePct: p.sharePct,
      allocatedToDateMinor: allocated,
      withdrawnToDateMinor: w?.all ?? 0,
      withdrawnThisMonthMinor: w?.month ?? 0,
      undrawnMinor: allocated - (w?.all ?? 0) - (net?.t ?? 0),
      nettingMinor: net?.t ?? 0,
      capRemainingMinor: pr?.capMinor != null ? Math.max(0, pr.capMinor - (wSnap?.t ?? 0)) : null,
      lastPeriodId: snap?.periodId ?? null,
    });
  }
  return out;
}

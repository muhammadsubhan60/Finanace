import { addDays, karachiDate, periodIdOf, addMonths, formatPKR } from "@delta/core";
import { getDb, ORG_ID } from "../client";
import { audit, newId, type Ctx } from "../context";
import { estimatePeriod } from "./periods";
import { getCurrentProfile } from "./profile";

/** Alert rules are data (alert_rules collection). Seeded defaults; thresholds editable. */
export const SEED_ALERT_RULES = [
  { key: "cash_below_reserve", label: "Cash below reserve", enabled: true, severity: "critical", params: {} },
  { key: "reinvestment_unspent", label: "Reinvestment fund unspent", enabled: true, severity: "info", params: { days: 60 } },
  { key: "cod_unsettled_old", label: "Delivered COD unsettled too long", enabled: true, severity: "warning", params: { days: 14 } },
  { key: "rto_rate_high", label: "RTO rate above threshold", enabled: true, severity: "warning", params: { pct: 25, lookbackDays: 14, minShipments: 20 } },
  { key: "ad_spend_spike", label: "Ad spend spike vs 7-day average", enabled: true, severity: "warning", params: { multiple: 1.8 } },
  { key: "integration_failing", label: "Integration failing", enabled: true, severity: "critical", params: { errorCount: 3 } },
  { key: "token_expiring", label: "Token expiring", enabled: true, severity: "warning", params: { days: 7 } },
  { key: "unmapped_status", label: "Unmapped courier status", enabled: true, severity: "warning", params: {} },
  { key: "unmatched_shipments", label: "Unmatched shipments", enabled: true, severity: "info", params: { min: 10 } },
  { key: "period_close_due", label: "Period close due", enabled: true, severity: "warning", params: {} },
  { key: "period_final_soon", label: "Period about to become Final", enabled: true, severity: "info", params: { days: 5 } },
  { key: "partner_at_cap", label: "Partner at withdrawal cap", enabled: true, severity: "info", params: {} },
  { key: "approval_pending", label: "Approval pending > 2 business days", enabled: true, severity: "warning", params: { businessDays: 2 } },
];

type Fire = { key: string; dedupeKey: string; severity: string; title: string; detail: string; href?: string };

export async function evaluateAlerts(orgId = ORG_ID) {
  const db = await getDb();
  const rules = new Map((await db.collection("alert_rules").find({ orgId }).toArray()).map((r) => [r.key as string, r]));
  const on = (k: string) => rules.get(k)?.enabled !== false;
  const P = (k: string) => (rules.get(k)?.params ?? SEED_ALERT_RULES.find((r) => r.key === k)?.params ?? {}) as Record<string, number>;
  const sev = (k: string) => (rules.get(k)?.severity ?? SEED_ALERT_RULES.find((r) => r.key === k)?.severity ?? "info") as string;
  const fires: Fire[] = [];
  const today = karachiDate();
  const profile = await getCurrentProfile();

  if (on("cash_below_reserve")) {
    const est = await estimatePeriod(orgId, periodIdOf(today));
    if (est.result.warnings.some((w) => w.includes("below the required reserve")))
      fires.push({ key: "cash_below_reserve", dedupeKey: `cash_below_reserve:${today}`, severity: sev("cash_below_reserve"), title: "Cash is below the required reserve", detail: `Reserve ${formatPKR(est.result.cash.reserveMinor)} vs bank ${formatPKR(est.result.cash.bankAndCashMinor)}`, href: "/dashboard" });
  }
  if (on("cod_unsettled_old")) {
    const cutoff = new Date(Date.now() - P("cod_unsettled_old").days! * 86_400_000);
    const rows = await db.collection("shipments").aggregate<{ _id: string; n: number; v: number }>([{ $match: { orgId, normalizedStatus: "delivered", settlementId: null, deliveredAt: { $lt: cutoff } } }, { $group: { _id: "$courierId", n: { $sum: 1 }, v: { $sum: "$codAmountMinor" } } }]).toArray();
    for (const r of rows) fires.push({ key: "cod_unsettled_old", dedupeKey: `cod_unsettled_old:${r._id}:${today}`, severity: sev("cod_unsettled_old"), title: `${r.n} delivered COD parcels unsettled > ${P("cod_unsettled_old").days} days`, detail: `${formatPKR(r.v)} with courier ${r._id}`, href: `/cod?courier=${r._id}` });
  }
  if (on("rto_rate_high")) {
    const p = P("rto_rate_high");
    const since = new Date(Date.now() - p.lookbackDays! * 86_400_000);
    const r = await db.collection("shipments").aggregate<{ d: number; r: number }>([{ $match: { orgId, bookedAt: { $gte: since } } }, { $group: { _id: null, d: { $sum: { $cond: [{ $eq: ["$normalizedStatus", "delivered"] }, 1, 0] } }, r: { $sum: { $cond: [{ $eq: ["$normalizedStatus", "returned_to_origin"] }, 1, 0] } } } }]).next();
    if (r && r.d + r.r >= p.minShipments! && (r.r / (r.d + r.r)) * 100 > p.pct!)
      fires.push({ key: "rto_rate_high", dedupeKey: `rto_rate_high:${today}`, severity: sev("rto_rate_high"), title: `RTO rate ${((r.r / (r.d + r.r)) * 100).toFixed(1)}% (last ${p.lookbackDays} days)`, detail: `Threshold ${p.pct}%`, href: "/shipments?status=returned_to_origin" });
  }
  if (on("ad_spend_spike")) {
    const days = await db.collection("ad_spend_daily").aggregate<{ _id: string; s: number }>([{ $match: { orgId, allocation: "division", date: { $gte: addDays(today, -8), $lte: today } } }, { $group: { _id: "$date", s: { $sum: "$spendMinor" } } }, { $sort: { _id: 1 } }]).toArray();
    const last = days.find((d) => d._id === addDays(today, -1));
    const prior = days.filter((d) => d._id < addDays(today, -1));
    const avg = prior.length ? prior.reduce((a, b) => a + b.s, 0) / prior.length : 0;
    if (last && avg > 0 && last.s > avg * P("ad_spend_spike").multiple!)
      fires.push({ key: "ad_spend_spike", dedupeKey: `ad_spend_spike:${last._id}`, severity: sev("ad_spend_spike"), title: "Ad spend spike", detail: `${formatPKR(last.s)} yesterday vs 7-day average ${formatPKR(Math.round(avg))}`, href: "/ads" });
  }
  for (const i of await db.collection("integrations").find({ orgId, enabled: true }).toArray()) {
    if (on("integration_failing") && (i.errorCount ?? 0) >= P("integration_failing").errorCount!)
      fires.push({ key: "integration_failing", dedupeKey: `integration_failing:${i._id}:${today}`, severity: sev("integration_failing"), title: `${i.label} is failing`, detail: String(i.lastError ?? ""), href: "/integrations" });
    if (on("token_expiring") && i.tokenExpiresAt && i.tokenExpiresAt < new Date(Date.now() + P("token_expiring").days! * 86_400_000))
      fires.push({ key: "token_expiring", dedupeKey: `token_expiring:${i._id}`, severity: sev("token_expiring"), title: `${i.label} token expires soon`, detail: i.tokenExpiresAt.toISOString().slice(0, 10), href: "/integrations" });
  }
  if (on("unmapped_status")) {
    for (const u of await db.collection("unmapped_statuses").find({ orgId, resolved: { $ne: true } }).toArray())
      fires.push({ key: "unmapped_status", dedupeKey: `unmapped_status:${u.provider}:${u.status}`, severity: sev("unmapped_status"), title: `Unmapped ${u.provider} status "${u.status}"`, detail: `Seen ${u.count}×, e.g. ${u.example}`, href: "/configuration/status-mappings" });
  }
  if (on("unmatched_shipments")) {
    const n = await db.collection("shipments").countDocuments({ orgId, orderId: null });
    if (n >= P("unmatched_shipments").min!) fires.push({ key: "unmatched_shipments", dedupeKey: `unmatched_shipments:${today}`, severity: sev("unmatched_shipments"), title: `${n} shipments not matched to orders`, detail: "COGS is estimated until matched", href: "/shipments/matching" });
  }
  const prev = addMonths(periodIdOf(today), -1);
  const prevP = await db.collection("periods").findOne({ orgId, periodId: prev });
  if (on("period_close_due") && (!prevP || prevP.status === "open" || prevP.status === "closing") && Number(today.slice(8)) >= profile.reporting.closeDayOfMonth - 3)
    fires.push({ key: "period_close_due", dedupeKey: `period_close_due:${prev}`, severity: sev("period_close_due"), title: `Close ${prev} by day ${profile.reporting.closeDayOfMonth}`, detail: "Run the close checklist", href: `/periods/${prev}` });
  if (on("period_final_soon")) {
    for (const p of await db.collection("periods").find({ orgId, status: "closed", finalDueAt: { $lte: new Date(Date.now() + P("period_final_soon").days! * 86_400_000) } }).toArray())
      fires.push({ key: "period_final_soon", dedupeKey: `period_final_soon:${p.periodId}`, severity: sev("period_final_soon"), title: `${p.periodId} becomes Final on ${karachiDate(p.finalDueAt)}`, detail: "Raise objections before then", href: `/periods/${p.periodId}` });
  }
  if (on("approval_pending")) {
    const cutoff = businessDaysAgo(P("approval_pending").businessDays!);
    for (const a of await db.collection("approvals").find({ orgId, status: "pending", createdAt: { $lt: cutoff } }).toArray())
      fires.push({ key: "approval_pending", dedupeKey: `approval_pending:${a._id}`, severity: sev("approval_pending"), title: `Approval pending: ${a.title}`, detail: `Requested by ${a.requesterName} on ${karachiDate(a.createdAt)}`, href: "/approvals" });
  }
  if (on("reinvestment_unspent")) {
    const last = await db.collection("journal_lines").find({ orgId, accountId: "reinvestment_fund", debitMinor: { $gt: 0 } }).sort({ date: -1 }).limit(1).next();
    const firstCredit = await db.collection("journal_lines").find({ orgId, accountId: "reinvestment_fund", creditMinor: { $gt: 0 } }).sort({ date: 1 }).limit(1).next();
    const since = last?.date ?? firstCredit?.date;
    if (since && since < addDays(today, -P("reinvestment_unspent").days!))
      fires.push({ key: "reinvestment_unspent", dedupeKey: `reinvestment_unspent:${periodIdOf(today)}`, severity: sev("reinvestment_unspent"), title: "Reinvestment fund unspent", detail: `No reinvestment spend since ${since}`, href: "/dashboard" });
  }
  if (on("partner_at_cap")) {
    const { partnerCards } = await import("./metrics");
    for (const c of await partnerCards(orgId)) if (c.capRemainingMinor === 0) fires.push({ key: "partner_at_cap", dedupeKey: `partner_at_cap:${c.partnerId}:${c.lastPeriodId}`, severity: sev("partner_at_cap"), title: `${c.label} has reached the withdrawal cap`, detail: `For ${c.lastPeriodId}`, href: "/partners" });
  }

  for (const f of fires) await db.collection("alerts").updateOne({ orgId, dedupeKey: f.dedupeKey }, { $setOnInsert: { _id: newId() as never, orgId, ...f, createdAt: new Date(), acknowledgedAt: null } }, { upsert: true });
  return fires.length;
}

function businessDaysAgo(n: number): Date {
  const d = new Date();
  let left = n;
  while (left > 0) {
    d.setDate(d.getDate() - 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) left--;
  }
  return d;
}

export async function acknowledgeAlert(ctx: Ctx, id: string) {
  await (await getDb()).collection("alerts").updateOne({ _id: id as never, orgId: ctx.orgId }, { $set: { acknowledgedAt: new Date(), acknowledgedBy: ctx.userName } });
  await audit(ctx, "alert.ack", "alert", id, null, null);
}

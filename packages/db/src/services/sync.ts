import { addDays, karachiDate, periodBounds } from "@delta/core";
import {
  courierAdapter, decryptJson, encryptJson, LeopardsAdapter, metaAdapter, shopifyAdapter, TcsAdapter,
  type AdInsightRow, type ShopifyOrderIn,
} from "@delta/integrations";
import { getDb } from "../client";
import { audit, BusinessError, newId, requirePerm, systemCtx, type Ctx } from "../context";
import { post, reverseEntry } from "../journal";
import { applyTracking, recordSettlement, runMatching, shipmentsToPoll, upsertShipment, type ShipmentDoc } from "./couriers";
import { getCurrentProfile, getProfileFor } from "./profile";

export interface IntegrationDoc {
  _id: string;
  orgId: string;
  type: "shopify" | "courier" | "meta";
  provider: string;
  label: string;
  refId: string; // storeId | courierId | adAccountId
  mode: "mock" | "live";
  credentialsEnc?: string | null;
  enabled: boolean;
  settings: { pollHours?: number; restateDays?: number; apiVersion?: string };
  cursor?: string | null;
  lastSuccessAt?: Date | null;
  lastErrorAt?: Date | null;
  lastError?: string | null;
  errorCount: number;
  tokenExpiresAt?: Date | null;
}

const icol = async () => (await getDb()).collection<IntegrationDoc>("integrations");

function creds(i: IntegrationDoc): Record<string, string> | undefined {
  return i.credentialsEnc ? decryptJson(i.credentialsEnc) : undefined;
}

export async function saveCredentials(ctx: Ctx, integrationId: string, values: Record<string, string>, mode: "mock" | "live") {
  requirePerm(ctx, "integrations:manage");
  const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, v.trim()]));
  for (const [k, v] of Object.entries(clean))
    if (/[\r\n]/.test(v) || (/key|token|secret/i.test(k) && /\s/.test(v))) throw new BusinessError(`"${k}" contains spaces or line breaks — paste only the value, not the label`);
  const existing = await (await icol()).findOne({ _id: integrationId, orgId: ctx.orgId });
  if (!existing) throw new BusinessError("Integration not found");
  const merged = { ...(existing.credentialsEnc ? decryptJson(existing.credentialsEnc) : {}), ...clean };
  const set: Partial<IntegrationDoc> = { mode };
  if (Object.keys(clean).length) set.credentialsEnc = encryptJson(merged);
  if (mode === "live" && !Object.keys(merged).length) throw new BusinessError("Enter credentials before switching to live");
  await (await icol()).updateOne({ _id: integrationId, orgId: ctx.orgId }, { $set: set });
  await audit(ctx, "integration.credentials", "integration", integrationId, null, { mode, fields: Object.keys(clean) });
}

export async function setIntegrationEnabled(ctx: Ctx, id: string, enabled: boolean) {
  requirePerm(ctx, "integrations:manage");
  await (await icol()).updateOne({ _id: id, orgId: ctx.orgId }, { $set: { enabled } });
  await audit(ctx, "integration.enable", "integration", id, null, { enabled });
}

export async function testConnection(ctx: Ctx, id: string) {
  requirePerm(ctx, "integrations:manage");
  const i = await (await icol()).findOne({ _id: id, orgId: ctx.orgId });
  if (!i) throw new BusinessError("Integration not found");
  const a = i.type === "shopify" ? shopifyAdapter(i.refId, i.mode, creds(i)) : i.type === "meta" ? metaAdapter(i.mode, creds(i)) : courierAdapter(i.provider as "leopards", i.mode, creds(i));
  return a.testConnection();
}

/** Queue a job for the worker (resync range etc.). The web app never runs long syncs in a request. */
export async function enqueueJob(ctx: Ctx, type: string, params: Record<string, unknown>) {
  const db = await getDb();
  const job = { _id: newId(), orgId: ctx.orgId, type, params, status: "queued", createdAt: new Date(), createdBy: ctx.userId, attempts: 0 };
  await db.collection("jobs").insertOne(job as never);
  await audit(ctx, "job.enqueue", "job", job._id, null, { type, params });
  return job._id;
}

async function recordRun<T>(i: IntegrationDoc, kind: string, fn: () => Promise<T>): Promise<T> {
  const db = await getDb();
  const runId = newId();
  const started = new Date();
  await db.collection("sync_runs").insertOne({ _id: runId as never, orgId: i.orgId, integrationId: i._id, kind, startedAt: started, status: "running" });
  try {
    const r = await fn();
    await db.collection("sync_runs").updateOne({ _id: runId as never }, { $set: { status: "ok", finishedAt: new Date(), durationMs: Date.now() - started.getTime(), result: r } });
    await (await icol()).updateOne({ _id: i._id }, { $set: { lastSuccessAt: new Date(), lastError: null, errorCount: 0 } });
    return r;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    await db.collection("sync_runs").updateOne({ _id: runId as never }, { $set: { status: "error", finishedAt: new Date(), error: msg } });
    await (await icol()).updateOne({ _id: i._id }, { $set: { lastErrorAt: new Date(), lastError: msg }, $inc: { errorCount: 1 } });
    throw e;
  }
}

// ---------------- Shopify ----------------

export async function upsertOrder(orgId: string, storeId: string, o: ShopifyOrderIn) {
  const db = await getDb();
  const now = new Date();
  await db.collection("orders").updateOne(
    { orgId, storeId, externalId: o.externalId },
    {
      $setOnInsert: { _id: newId() as never, createdAtSys: now },
      $set: {
        name: o.name, createdAt: new Date(o.createdAt), updatedAtShop: new Date(o.updatedAt), cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
        financialStatus: o.financialStatus, paymentMethod: o.paymentMethod, totalMinor: o.totalMinor, subtotalMinor: o.subtotalMinor, discountsMinor: o.discountsMinor,
        taxesMinor: o.taxesMinor, shippingMinor: o.shippingMinor,
        customer: { name: o.customer.name ?? null, phone: o.customer.phone ?? null, city: o.customer.city ?? null }, // minimal PII
        lineItems: o.lineItems, trackingNumbers: o.trackingNumbers, status: o.cancelledAt ? "cancelled" : "open", updatedAt: now,
      },
    },
    { upsert: true },
  );
  const order = await db.collection("orders").findOne({ orgId, storeId, externalId: o.externalId });
  for (const r of o.refunds) {
    const res = await db.collection("order_refunds").updateOne({ orgId, externalId: r.externalId }, { $setOnInsert: { _id: newId() as never, orgId, orderId: order!._id, storeId, externalId: r.externalId, amountMinor: r.amountMinor, date: karachiDate(new Date(r.createdAt)), createdAt: now } }, { upsert: true });
    if (res.upsertedCount) {
      const recognized = await db.collection<ShipmentDoc>("shipments").findOne({ orgId, orderId: String(order!._id), revenueRecognized: true });
      if (recognized) {
        const profile = await getCurrentProfile();
        await post(systemCtx("shopify-sync"), { type: "order_refund", date: karachiDate(), refundId: String(res.upsertedId), amountMinor: r.amountMinor, storeId }, profile);
      }
    }
  }
}

async function syncShopify(i: IntegrationDoc, sinceOverride?: string) {
  const a = shopifyAdapter(i.refId, i.mode, creds(i));
  const since = sinceOverride ?? i.cursor ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  let cursor: string | null = null;
  let count = 0;
  let maxUpdated = since;
  do {
    const page = await a.fetchOrdersUpdatedSince(since, cursor);
    for (const o of page.orders) {
      await upsertOrder(i.orgId, i.refId, o);
      if (o.updatedAt > maxUpdated) maxUpdated = o.updatedAt;
      count++;
    }
    cursor = page.nextCursor;
  } while (cursor);
  if (!sinceOverride) await (await icol()).updateOne({ _id: i._id }, { $set: { cursor: maxUpdated } });
  await runMatching(systemCtx("shopify-sync"));
  return { orders: count };
}

// ---------------- Couriers ----------------

async function syncCourier(i: IntegrationDoc, range?: { from: string; to: string }) {
  const ctx = systemCtx(`courier-sync:${i.provider}`);
  const db = await getDb();
  const bookedAt = async (cn: string) => (await db.collection<ShipmentDoc>("shipments").findOne({ orgId: i.orgId, courierId: i.refId, cn }))?.bookedAt;
  const cache = new Map<string, Date | undefined>();
  const a = courierAdapter(i.provider as "leopards", i.mode, creds(i), (cn) => cache.get(cn));
  let intake = 0;
  // 1. Courier-first intake by date range when the API supports it (Leopards getBookedPacketLastStatus).
  if (a.listBookings) {
    const r = range ?? { from: addDays(karachiDate(), -7), to: karachiDate() };
    for (const s of await a.listBookings(r)) {
      await upsertShipment(ctx, i.refId, s, "api");
      intake++;
    }
  }
  // 2. Poll tracking for open shipments.
  const open = await shipmentsToPoll(i.orgId, i.refId, i.settings.pollHours ?? 4);
  for (const s of open) cache.set(s.cn, await bookedAt(s.cn));
  const snaps = a.fetchTrackingBatch ? await a.fetchTrackingBatch(open.map((s) => s.cn)) : await Promise.all(open.map((s) => a.fetchTracking(s.cn)));
  const found = new Set<string>();
  for (const snap of snaps) {
    const sh = open.find((s) => s.cn === snap.cn.toUpperCase());
    if (sh) {
      found.add(sh._id);
      await applyTracking(ctx, sh._id, snap);
    }
  }
  const missed = open.filter((s) => !found.has(s._id)).map((s) => s._id);
  if (missed.length) {
    await db.collection<ShipmentDoc>("shipments").updateMany({ _id: { $in: missed } }, { $inc: { pollMisses: 1 } as never, $set: { lastPolledAt: new Date() } });
    await db.collection<ShipmentDoc>("shipments").updateMany({ _id: { $in: missed }, pollMisses: { $gte: 3 } } as never, { $set: { pollStopped: true } as never });
  }
  // 3. Settlements by API where documented (Leopards getShippingCharges grouped by cheque no).
  let settlements = 0;
  if (i.mode === "live" && a instanceof LeopardsAdapter) {
    const unsettled = await db.collection<ShipmentDoc>("shipments").find({ orgId: i.orgId, courierId: i.refId, settlementId: null, normalizedStatus: { $in: ["delivered", "returned_to_origin"] } }).limit(500).toArray();
    const known = new Set((await db.collection("cod_settlements").distinct("reference", { orgId: i.orgId, courierId: i.refId })) as string[]);
    const statusByCn = new Map(unsettled.map((x) => [x.cn, x.normalizedStatus]));
    for (const s of await a.fetchSettlementsForCns(unsettled.map((x) => x.cn))) {
      if (known.has(s.reference)) continue;
      // LCS reports the booked collect amount even for returned parcels; nothing was collected on those.
      for (const l of s.lines) if (statusByCn.get(l.cn.toUpperCase()) === "returned_to_origin") l.codMinor = 0;
      s.netReceivedMinor = s.lines.reduce((t, l) => t + l.codMinor - l.freightMinor - l.codFeeMinor - l.returnFeeMinor, 0);
      await recordSettlement(ctx, { ...s, courierId: i.refId, source: "api", date: s.date || karachiDate() });
      settlements++;
    }
  }
  if (intake) await runMatching(ctx);
  return { intake, polled: open.length, settlements };
}

/** Courier webhook (Leopards Push API). Returns number of events stored. */
export async function handleCourierWebhook(integrationId: string, body: unknown, headers: Record<string, string>) {
  const i = await (await icol()).findOne({ _id: integrationId });
  if (!i || i.type !== "courier" || !i.enabled) throw Object.assign(new Error("Unknown integration"), { status: 404 });
  const a = courierAdapter(i.provider as "leopards", i.mode, creds(i));
  if (!a.handleWebhook) throw Object.assign(new Error("Webhooks not supported for this courier"), { status: 400 });
  const snaps = await a.handleWebhook(body, headers);
  const ctx = systemCtx(`webhook:${i.provider}`);
  for (const s of snaps) await upsertShipment(ctx, i.refId, s, "webhook");
  await (await icol()).updateOne({ _id: i._id }, { $set: { lastSuccessAt: new Date() } });
  return snaps.length;
}

export async function tcsSettlementByInvoice(ctx: Ctx, integrationId: string, invoiceNo: string) {
  requirePerm(ctx, "import:upload");
  const i = await (await icol()).findOne({ _id: integrationId, orgId: ctx.orgId });
  if (!i) throw new BusinessError("Integration not found");
  const a = courierAdapter("tcs", i.mode, creds(i));
  if (!(a instanceof TcsAdapter)) throw new BusinessError("TCS API is not live yet — use CSV import");
  const s = await a.fetchSettlementByInvoice(invoiceNo);
  if (!s) throw new BusinessError("No lines found for that invoice");
  return recordSettlement(ctx, { ...s, courierId: i.refId, source: "api" });
}

// ---------------- Meta Ads ----------------

export async function upsertAdRows(orgId: string, adAccountId: string, rows: AdInsightRow[]) {
  const db = await getDb();
  const acct = await db.collection("ad_accounts").findOne({ orgId, _id: adAccountId as never });
  const map = (acct?.campaignMap ?? {}) as Record<string, { division: "local-ecom" | "other"; storeId?: string }>;
  let changed = 0;
  for (const r of rows) {
    const m = map[r.campaignId];
    const allocation = m ? (m.division === "local-ecom" ? "division" : "other_division") : (acct?.storeIds?.length === 1 && acct?.dedicated ? "division" : "unallocated");
    const storeId = m?.storeId ?? (acct?.storeIds?.length === 1 ? acct.storeIds[0] : null);
    const key = { orgId, adAccountId, date: r.date, campaignId: r.campaignId };
    // A row the owner edited or deleted by hand keeps its manual value; Meta restatements don't overwrite it.
    if (await db.collection("ad_spend_daily").countDocuments({ ...key, manualOverride: { $exists: true } }, { limit: 1 })) continue;
    const res = await db.collection("ad_spend_daily").findOneAndUpdate(
      key,
      { $setOnInsert: { _id: newId() as never, createdAt: new Date() }, $set: { campaignName: r.campaignName, spendMinor: r.spendMinor, impressions: r.impressions, clicks: r.clicks, purchases: r.purchases, revenueMinor: r.revenueMinor, currency: r.currency, allocation, storeId, updatedAt: new Date() } },
      { upsert: true, returnDocument: "after" },
    );
    if (res) changed += await postAdRow(orgId, res as never);
  }
  return changed;
}

/** Post (or restate) one ad spend row. Restatements reverse the previous posting and post the new amount. */
export async function postAdRow(orgId: string, row: { _id: string; date: string; spendMinor: number; allocation: string; storeId?: string | null; postedEntryId?: string | null; postedMinor?: number | null; postVersion?: number }) {
  const want = row.allocation === "division" ? row.spendMinor : 0;
  const have = row.postedMinor ?? 0;
  if (want === have) return 0;
  const db = await getDb();
  const ctx = systemCtx("meta-sync");
  const periodOpen = async (d: string) => {
    const p = await db.collection("periods").findOne({ orgId, periodId: d.slice(0, 7) });
    return !p || p.status === "open";
  };
  const date = (await periodOpen(row.date)) ? row.date : karachiDate();
  if (row.postedEntryId) await reverseEntry(ctx, row.postedEntryId, date, "Meta restatement");
  const v = (row.postVersion ?? 0) + 1;
  let entryId: string | null = null;
  if (want > 0) {
    const profile = await getProfileFor(row.date, orgId);
    const e = await post(ctx, { type: "ad_spend_day", date, adSpendId: `${row._id}:v${v}`, amountMinor: want, storeId: row.storeId ?? undefined }, profile);
    entryId = e?._id ?? null;
  }
  await db.collection("ad_spend_daily").updateOne({ _id: row._id as never }, { $set: { postedEntryId: entryId, postedMinor: want, postVersion: v } });
  return 1;
}

export async function assignCampaign(ctx: Ctx, adAccountId: string, campaignId: string, division: "local-ecom" | "other", storeId?: string) {
  requirePerm(ctx, "integrations:manage");
  const db = await getDb();
  await db.collection("ad_accounts").updateOne({ _id: adAccountId as never, orgId: ctx.orgId }, { $set: { [`campaignMap.${campaignId}`]: { division, storeId: storeId || undefined } } });
  const rows = await db.collection("ad_spend_daily").find({ orgId: ctx.orgId, adAccountId, campaignId }).toArray();
  for (const r of rows) {
    await db.collection("ad_spend_daily").updateOne({ _id: r._id }, { $set: { allocation: division === "local-ecom" ? "division" : "other_division", storeId: storeId || null } });
    await postAdRow(ctx.orgId, { ...(r as unknown as Parameters<typeof postAdRow>[1]), allocation: division === "local-ecom" ? "division" : "other_division", storeId: storeId || null });
  }
  await audit(ctx, "ads.assign_campaign", "ad_account", adAccountId, null, { campaignId, division, storeId });
}

async function syncMeta(i: IntegrationDoc, range?: { from: string; to: string }) {
  const a = metaAdapter(i.mode, creds(i));
  const restate = i.settings.restateDays ?? 7;
  const r = range ?? { from: addDays(karachiDate(), -restate), to: karachiDate() };
  const db = await getDb();
  const acct = await db.collection("ad_accounts").findOne({ _id: i.refId as never });
  const rows = (await a.fetchDailyInsights(acct?.externalId ?? i.refId, r.from, r.to)).filter((x) => x.currency === "PKR" || (() => { throw new Error(`Unexpected currency ${x.currency}; v1 is PKR only`); })());
  return { rows: rows.length, posted: await upsertAdRows(i.orgId, i.refId, rows) };
}

/**
 * Owner correction of one day's ad spend. The ledger stays append-only: postAdRow reverses the previous posting
 * and posts the new amount (into the current period if the row's period is closed). Delete = amount 0, hidden from lists.
 */
export async function overrideAdSpend(ctx: Ctx, rowId: string, input: { amountMinor?: number; remove?: boolean; note: string }) {
  requirePerm(ctx, "journal:adjust");
  const note = input.note.trim();
  if (!note) throw new BusinessError("Give a reason for the change");
  const remove = !!input.remove;
  const amount = remove ? 0 : input.amountMinor;
  if (amount == null || !Number.isSafeInteger(amount) || amount < 0) throw new BusinessError("Amount must be zero or more");
  const db = await getDb();
  const col = db.collection("ad_spend_daily");
  const row = await col.findOne({ _id: rowId as never, orgId: ctx.orgId });
  if (!row) throw new BusinessError("Ad spend row not found");
  if (row.deletedAt) throw new BusinessError("This row was already deleted");
  const meta = row.manualOverride?.meta ?? { spendMinor: row.spendMinor, revenueMinor: row.revenueMinor, purchases: row.purchases };
  const set: Record<string, unknown> = {
    spendMinor: amount,
    manualOverride: { meta, byUserId: ctx.userId, byName: ctx.userName, at: new Date(), note },
    updatedAt: new Date(),
    ...(remove ? { deletedAt: new Date(), revenueMinor: 0, purchases: 0 } : {}),
  };
  const after = await col.findOneAndUpdate({ _id: rowId as never, orgId: ctx.orgId }, { $set: set }, { returnDocument: "after" });
  await postAdRow(ctx.orgId, after as never);
  await audit(ctx, remove ? "ads.delete_spend" : "ads.edit_spend", "ad_spend", rowId, { spendMinor: row.spendMinor, date: row.date, campaignId: row.campaignId }, { spendMinor: amount, note });
}

export async function payCardBill(ctx: Ctx, amountMinor: number, date: string, ref: string) {
  requirePerm(ctx, "withdrawal:pay");
  const profile = await getProfileFor(date);
  await post(ctx, { type: "card_bill_paid", date, refId: ref, amountMinor }, profile);
}

// ---------------- Runner ----------------

export async function runIntegration(integrationId: string, params: { from?: string; to?: string } = {}) {
  const i = await (await icol()).findOne({ _id: integrationId });
  if (!i || !i.enabled) return null;
  const range = params.from && params.to ? { from: params.from, to: params.to } : undefined;
  if (i.type === "shopify") return recordRun(i, "shopify", () => syncShopify(i, range ? new Date(range.from).toISOString() : undefined));
  if (i.type === "courier") return recordRun(i, "courier", () => syncCourier(i, range));
  return recordRun(i, "meta", () => syncMeta(i, range));
}

export async function listIntegrations(orgId: string) {
  return (await icol()).find({ orgId }).sort({ type: 1, label: 1 }).toArray();
}

export { periodBounds };

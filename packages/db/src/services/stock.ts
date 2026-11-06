import { karachiDate, parsePKR, periodIdOf } from "@delta/core";
import { getDb } from "../client";
import { audit, BusinessError, newId, requirePerm, type Ctx } from "../context";
import { post } from "../journal";
import { getProfileFor } from "./profile";

/** Simple stock ledger. Valuation: weighted average (default) — avg cost updated on each purchase. */
export async function purchaseStock(ctx: Ctx, args: { sku: string; title: string; quantity: number; totalCost: string; date: string; paidFrom: "bank" | "accounts_payable" }) {
  requirePerm(ctx, "stock:manage");
  if (!Number.isInteger(args.quantity) || args.quantity <= 0) throw new BusinessError("Quantity must be a positive whole number");
  const total = parsePKR(args.totalCost);
  const db = await getDb();
  const sku = args.sku.trim().toUpperCase();
  const item = await db.collection("stock_items").findOne({ orgId: ctx.orgId, sku });
  const profile = await getProfileFor(args.date);
  const qty0 = item?.onHand ?? 0;
  const val0 = item?.valueMinor ?? 0;
  const onHand = qty0 + args.quantity;
  const valueMinor = val0 + total;
  const avg = profile.stock.valuation === "weighted_average" ? Math.round(valueMinor / onHand) : Math.round(total / args.quantity);
  const moveId = newId();
  await db.collection("stock_movements").insertOne({ _id: moveId as never, orgId: ctx.orgId, sku, type: "purchase", quantity: args.quantity, valueMinor: total, date: args.date, createdAt: new Date(), createdBy: ctx.userId });
  await db.collection("stock_items").updateOne({ orgId: ctx.orgId, sku }, { $set: { title: args.title, onHand, valueMinor, avgCostMinor: avg, updatedAt: new Date() }, $setOnInsert: { _id: newId() as never, createdAt: new Date() } }, { upsert: true });
  await post(ctx, { type: "stock_purchased", date: args.date, refId: moveId, amountMinor: total, paidFrom: args.paidFrom }, profile);
  await audit(ctx, "stock.purchase", "stock_item", sku, { onHand: qty0 }, { onHand, avg });
}

/** Physical count: difference vs book becomes a count loss/gain; write-downs to recoverable value are separate. */
export async function recordCount(ctx: Ctx, args: { periodId: string; counts: { sku: string; counted: number; recoverableUnitMinor?: number }[] }) {
  requirePerm(ctx, "stock:manage");
  const db = await getDb();
  const date = karachiDate();
  const profile = await getProfileFor(date);
  for (const c of args.counts) {
    const item = await db.collection("stock_items").findOne({ orgId: ctx.orgId, sku: c.sku });
    if (!item) continue;
    const diff = c.counted - item.onHand;
    const avg = item.avgCostMinor ?? 0;
    let value = item.valueMinor;
    if (diff !== 0) {
      const amt = Math.abs(diff) * avg;
      const id = newId();
      await db.collection("stock_movements").insertOne({ _id: id as never, orgId: ctx.orgId, sku: c.sku, type: diff < 0 ? "count_loss" : "count_gain", quantity: diff, valueMinor: diff * avg, date, createdAt: new Date() });
      if (amt) await post(ctx, { type: "stock_adjustment", date, refId: id, amountMinor: amt, reason: diff < 0 ? "count_loss" : "count_gain" }, profile);
      value += diff * avg;
    }
    if (c.recoverableUnitMinor != null && c.recoverableUnitMinor < avg && c.counted > 0) {
      const wd = (avg - c.recoverableUnitMinor) * c.counted;
      const id = newId();
      await db.collection("stock_movements").insertOne({ _id: id as never, orgId: ctx.orgId, sku: c.sku, type: "write_down", quantity: 0, valueMinor: -wd, date, createdAt: new Date() });
      await post(ctx, { type: "stock_adjustment", date, refId: id, amountMinor: wd, reason: "write_down" }, profile);
      value -= wd;
    }
    await db.collection("stock_items").updateOne({ _id: item._id }, { $set: { onHand: c.counted, valueMinor: value, avgCostMinor: c.counted ? Math.round(value / c.counted) : avg } });
  }
  await db.collection("stock_counts").updateOne({ orgId: ctx.orgId, periodId: args.periodId || periodIdOf(date) }, { $set: { counts: args.counts, at: new Date(), by: ctx.userId }, $setOnInsert: { _id: newId() as never } }, { upsert: true });
  await audit(ctx, "stock.count", "stock_count", args.periodId, null, { items: args.counts.length });
}

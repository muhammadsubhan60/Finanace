"use server";

import { purchaseStock, recomputeEstimatedCogs, recordCount } from "@delta/db";
import { parsePKR } from "@delta/core";
import { act, str, type ActionState } from "@/lib/action";

export async function purchase(_: ActionState, fd: FormData) {
  return act("stock:manage", async (ctx) => {
    await purchaseStock(ctx, { sku: str(fd, "sku"), title: str(fd, "title"), quantity: Number(str(fd, "quantity")), totalCost: str(fd, "totalCost"), date: str(fd, "date"), paidFrom: str(fd, "paidFrom") as "bank" });
    return "Purchase posted";
  }, ["/stock"]);
}

export async function count(_: ActionState, fd: FormData) {
  const counts: { sku: string; counted: number; recoverableUnitMinor?: number }[] = [];
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith("count:")) continue;
    const sku = k.slice(6);
    const recov = str(fd, `recov:${sku}`);
    counts.push({ sku, counted: Number(v), recoverableUnitMinor: recov ? parsePKR(recov) : undefined });
  }
  return act("stock:manage", async (ctx) => {
    if (counts.some((c) => !Number.isInteger(c.counted) || c.counted < 0)) throw new Error("Counts must be whole numbers ≥ 0");
    await recordCount(ctx, { periodId: str(fd, "periodId"), counts });
    return "Count recorded";
  }, ["/stock"]);
}

export async function recompute(_: ActionState) {
  return act("stock:manage", async (ctx) => {
    const r = await recomputeEstimatedCogs(ctx);
    return `${r.trueUps} COGS true-ups (${(r.deltaMinor / 100).toLocaleString()} PKR), ${r.writeOffs} returns written off (${(r.writeOffMinor / 100).toLocaleString()} PKR)`;
  }, ["/stock", "/dashboard", "/periods"]);
}

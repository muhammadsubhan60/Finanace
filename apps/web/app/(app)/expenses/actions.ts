"use server";

import { createExpense } from "@delta/db";
import { act, str, type ActionState } from "@/lib/action";
import { localStore } from "@/lib/files";

export async function addExpense(_: ActionState, fd: FormData) {
  return act("expense:create", async (ctx) => {
    const receipts = [];
    for (const f of fd.getAll("receipts") as File[]) {
      if (!f || !f.size) continue;
      const r = await localStore.put(f.name, Buffer.from(await f.arrayBuffer()), f.type);
      receipts.push({ name: f.name, ...r });
    }
    const e = await createExpense(
      ctx,
      { categoryKey: str(fd, "categoryKey"), amount: str(fd, "amount"), date: str(fd, "date"), payee: str(fd, "payee"), storeId: str(fd, "storeId") || undefined, memo: str(fd, "memo") || undefined, recurring: fd.get("recurring") === "on" },
      { paidFrom: (str(fd, "paidFrom") || "bank") as "bank", receipts },
    );
    return e.status === "posted" ? "Expense posted" : "Expense submitted for approval";
  }, ["/expenses", "/approvals"]);
}

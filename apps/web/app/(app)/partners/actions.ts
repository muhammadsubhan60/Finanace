"use server";

import { payWithdrawal, requestWithdrawal } from "@delta/db";
import { act, str, type ActionState } from "@/lib/action";

export async function request(_: ActionState, fd: FormData) {
  return act("withdrawal:request", async (ctx) => {
    await requestWithdrawal(ctx, { partnerId: str(fd, "partnerId"), periodId: str(fd, "periodId"), amount: str(fd, "amount"), overrideReason: str(fd, "overrideReason") || undefined });
    return "Withdrawal requested; waiting for approval";
  }, ["/partners", "/approvals"]);
}

export async function pay(_: ActionState, fd: FormData) {
  return act("withdrawal:pay", async (ctx) => {
    await payWithdrawal(ctx, str(fd, "id"), str(fd, "bankRef"));
    return "Paid and posted to the ledger";
  }, ["/partners", "/dashboard"]);
}

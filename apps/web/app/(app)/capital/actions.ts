"use server";

import { proposeTranche, releaseTranche } from "@delta/db";
import { act, str, type ActionState } from "@/lib/action";

export async function propose(_: ActionState, fd: FormData) {
  return act("tranche:propose", async (ctx) => {
    await proposeTranche(ctx, { amount: str(fd, "amount"), purpose: str(fd, "purpose"), plannedDate: str(fd, "plannedDate") });
    return "Tranche proposed; both partners must approve";
  }, ["/capital", "/approvals"]);
}

export async function release(_: ActionState, fd: FormData) {
  return act("tranche:release", async (ctx) => {
    await releaseTranche(ctx, str(fd, "id"), str(fd, "bankRef"));
    return "Released and posted to the capital account";
  }, ["/capital", "/dashboard"]);
}

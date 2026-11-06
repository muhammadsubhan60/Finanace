"use server";

import { assignCampaign, payCardBill } from "@delta/db";
import { parsePKR } from "@delta/core";
import { act, str, type ActionState } from "@/lib/action";

export async function assign(_: ActionState, fd: FormData) {
  const [division, storeId] = str(fd, "target").split(":");
  return act("integrations:manage", async (ctx) => {
    await assignCampaign(ctx, str(fd, "adAccountId"), str(fd, "campaignId"), division === "local-ecom" ? "local-ecom" : "other", storeId);
    return "Campaign assigned; spend re-posted";
  }, ["/ads"]);
}

export async function payCard(_: ActionState, fd: FormData) {
  return act("withdrawal:pay", async (ctx) => {
    await payCardBill(ctx, parsePKR(str(fd, "amount")), str(fd, "date"), str(fd, "ref"));
    return "Card payment recorded";
  }, ["/ads"]);
}

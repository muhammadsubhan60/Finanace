"use server";

import { cancelClose, closePeriod, commentObjection, raiseObjection, requestCorrection, resolveObjection, saveCloseInputs, startClose } from "@delta/db";
import { parsePKR } from "@delta/core";
import { act, str, type ActionState } from "@/lib/action";

const paths = (fd: FormData) => [`/periods/${str(fd, "periodId")}`, "/periods", "/dashboard"];

export async function start(_: ActionState, fd: FormData) {
  return act("period:close", async (ctx) => {
    await startClose(ctx, str(fd, "periodId"));
    return "Close started: data for this period is frozen";
  }, paths(fd));
}
export async function cancel(_: ActionState, fd: FormData) {
  return act("period:close", async (ctx) => {
    await cancelClose(ctx, str(fd, "periodId"));
    return "Period reopened";
  }, paths(fd));
}
export async function close(_: ActionState, fd: FormData) {
  return act("period:close", async (ctx) => {
    const s = await closePeriod(ctx, str(fd, "periodId"));
    return `Closed. Statement issued (hash ${s.inputsHash.slice(0, 10)})`;
  }, paths(fd));
}
export async function saveInputs(_: ActionState, fd: FormData) {
  const keys = ["payrollDueMinor", "taxesDueMinor", "refundsExpectedMinor", "courierReturnExposureMinor", "fixedCostsNextBufferMinor", "inventoryNeedsNextBufferMinor", "extraReserveMinor", "extraReserveCalcRef"] as const;
  return act("period:close", async (ctx) => {
    await saveCloseInputs(ctx, str(fd, "periodId"), { bankBalance: str(fd, "bankBalance"), reserve: Object.fromEntries(keys.map((k) => [k, str(fd, k)])) });
    return "Inputs saved";
  }, paths(fd));
}
export async function object(_: ActionState, fd: FormData) {
  return act("objection:raise", async (ctx) => {
    await raiseObjection(ctx, { periodId: str(fd, "periodId"), itemRef: str(fd, "itemRef"), reason: str(fd, "reason"), amount: str(fd, "amount") || undefined });
    return "Objection raised; this item's finality is paused";
  }, paths(fd));
}
export async function comment(_: ActionState, fd: FormData) {
  return act(null, async (ctx) => {
    await commentObjection(ctx, str(fd, "id"), str(fd, "text"));
    return "Comment added";
  }, paths(fd));
}
export async function resolve(_: ActionState, fd: FormData) {
  return act("objection:resolve", async (ctx) => {
    await resolveObjection(ctx, str(fd, "id"), str(fd, "resolution") as "agreed_adjust", str(fd, "note"));
    return "Resolved";
  }, paths(fd));
}
export async function correction(_: ActionState, fd: FormData) {
  return act("journal:adjust", async (ctx) => {
    const lines = str(fd, "lines").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [accountId, d, c] = l.split(",").map((x) => x.trim());
      if (!accountId) throw new Error(`Bad line: ${l}`);
      return { accountId, debitMinor: d ? parsePKR(d) : 0, creditMinor: c ? parsePKR(c) : 0 };
    });
    await requestCorrection(ctx, { periodId: str(fd, "periodId"), reason: str(fd, "reason"), memo: str(fd, "memo"), lines });
    return "Correction submitted for owner + MD approval";
  }, [...paths(fd), "/approvals"]);
}

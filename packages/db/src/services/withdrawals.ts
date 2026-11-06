import { WithdrawalInput } from "@delta/config-schema";
import { computePeriod, karachiDate, parsePKR, periodBounds, type PartnerResult } from "@delta/core";
import { getDb } from "../client";
import { audit, BusinessError, newId, requirePerm, type Ctx } from "../context";
import { balances, crBal, dr, post } from "../journal";
import { registerApprovalHandler, requestApproval } from "./approvals";
import { getProfileVersion } from "./profile";
import type { PeriodDoc, SnapshotDoc } from "./periods";

export interface WithdrawalDoc {
  _id: string;
  orgId: string;
  partnerId: string;
  periodId: string;
  amountMinor: number;
  status: "requested" | "approved" | "paid" | "rejected";
  evaluation: { withdrawableMinor: number; limitedBy: string; partner: PartnerResult; distributableMinor: number; reserveMinor: number; cashLines: { label: string; minor: number }[]; breaches: string[] };
  overrideReason?: string;
  approvalId?: string;
  bankRef?: string;
  requestedBy: string;
  requestedByName: string;
  createdAt: Date;
  paidAt?: Date;
}

/** Re-run the engine for the closed period with today's cash and withdrawals so far; returns the calculation shown to the user. */
export async function evaluateWithdrawal(orgId: string, periodId: string, partnerId: string, amountMinor: number) {
  const db = await getDb();
  const p = await db.collection<PeriodDoc>("periods").findOne({ orgId, periodId });
  if (!p?.snapshotId || (p.status !== "closed" && p.status !== "final")) throw new BusinessError("Withdrawals are made against a closed period");
  const snap = await db.collection<SnapshotDoc>("period_snapshots").findOne({ _id: p.snapshotId });
  if (!snap) throw new BusinessError("Snapshot missing");
  const profile = (await getProfileVersion(snap.profileVersion, orgId))!;
  const b = await balances(orgId, { date: { $lte: karachiDate() } });
  const withdrawnSoFar = await db.collection<WithdrawalDoc>("withdrawals").aggregate<{ _id: string; t: number }>([{ $match: { orgId, periodId, status: { $in: ["approved", "paid"] } } }, { $group: { _id: "$partnerId", t: { $sum: "$amountMinor" } } }]).toArray();
  const input = structuredClone(snap.input);
  input.cash.bankAndCashMinor = dr(b, "bank") + dr(b, "cash");
  input.cash.reinvestmentFundBalanceMinor = crBal(b, "reinvestment_fund");
  for (const [pid, v] of Object.entries(input.partners)) v.withdrawnThisPeriodMinor = withdrawnSoFar.find((w) => w._id === pid)?.t ?? 0;
  const result = computePeriod(input, profile);
  const pr = result.partners.find((x) => x.partnerId === partnerId);
  if (!pr) throw new BusinessError("Unknown partner");
  const breaches: string[] = [];
  if (amountMinor > pr.withdrawableMinor) {
    if (pr.capRemainingMinor !== null && amountMinor > pr.capRemainingMinor) breaches.push("cap");
    if (amountMinor > pr.cashShareMinor - pr.withdrawnThisPeriodMinor) breaches.push("cash_safeguard");
    if (amountMinor > pr.availableMinor - pr.withdrawnThisPeriodMinor) breaches.push("undrawn_balance");
  }
  return {
    withdrawableMinor: pr.withdrawableMinor,
    limitedBy: pr.withdrawableLimitedBy,
    partner: pr,
    distributableMinor: result.cash.distributableMinor,
    reserveMinor: result.cash.reserveMinor,
    cashLines: [{ label: "Bank and cash", minor: result.cash.bankAndCashMinor }, { label: "Less reinvestment fund", minor: -result.cash.reinvestmentFundMinor }, ...result.cash.lines.map((l) => ({ label: `Less ${l.label.toLowerCase()}`, minor: -l.minor }))],
    breaches,
  };
}

export async function requestWithdrawal(ctx: Ctx, raw: unknown) {
  requirePerm(ctx, "withdrawal:request");
  const input = WithdrawalInput.parse(raw);
  const amountMinor = parsePKR(input.amount);
  if (amountMinor <= 0) throw new BusinessError("Amount must be positive");
  const evaluation = await evaluateWithdrawal(ctx.orgId, input.periodId, input.partnerId, amountMinor);
  if (evaluation.breaches.length && !input.overrideReason?.trim())
    throw new BusinessError(`This withdrawal breaks: ${evaluation.breaches.join(", ")}. A recorded override reason approved by both partners is required.`);
  const doc: WithdrawalDoc = { _id: newId(), orgId: ctx.orgId, partnerId: input.partnerId, periodId: input.periodId, amountMinor, status: "requested", evaluation, overrideReason: input.overrideReason || undefined, requestedBy: ctx.userId, requestedByName: ctx.userName, createdAt: new Date() };
  const db = await getDb();
  await db.collection<WithdrawalDoc>("withdrawals").insertOne(doc);
  await audit(ctx, "withdrawal.request", "withdrawal", doc._id, null, doc);
  const a = await requestApproval(ctx, { kind: "withdrawal", policyAction: evaluation.breaches.length ? "withdrawal_override" : "withdrawal", refId: doc._id, title: `Withdrawal ${input.partnerId} for ${input.periodId}`, amountMinor });
  await db.collection<WithdrawalDoc>("withdrawals").updateOne({ _id: doc._id }, { $set: { approvalId: a._id } });
  return doc;
}

export async function payWithdrawal(ctx: Ctx, id: string, bankRef: string) {
  requirePerm(ctx, "withdrawal:pay");
  if (!bankRef.trim()) throw new BusinessError("Bank reference is required");
  const db = await getDb();
  const w = await db.collection<WithdrawalDoc>("withdrawals").findOne({ _id: id, orgId: ctx.orgId });
  if (!w || w.status !== "approved") throw new BusinessError("Only approved withdrawals can be paid");
  const profile = (await getProfileVersion((await db.collection<PeriodDoc>("periods").findOne({ orgId: ctx.orgId, periodId: w.periodId }))!.profileVersion!, ctx.orgId))!;
  await post(ctx, { type: "partner_withdrawal", date: karachiDate(), withdrawalId: w._id, partnerId: w.partnerId, amountMinor: w.amountMinor }, profile);
  await db.collection<WithdrawalDoc>("withdrawals").updateOne({ _id: id }, { $set: { status: "paid", bankRef, paidAt: new Date() } });
  await audit(ctx, "withdrawal.pay", "withdrawal", id, { status: "approved" }, { status: "paid", bankRef });
}

registerApprovalHandler("withdrawal", {
  async onApproved(_ctx, a, session) {
    await (await getDb()).collection<WithdrawalDoc>("withdrawals").updateOne({ _id: a.refId }, { $set: { status: "approved" } }, { session });
  },
  async onRejected(_ctx, a, session) {
    await (await getDb()).collection<WithdrawalDoc>("withdrawals").updateOne({ _id: a.refId }, { $set: { status: "rejected" } }, { session });
  },
});

export { periodBounds };

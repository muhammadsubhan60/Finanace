import { TrancheInput } from "@delta/config-schema";
import { karachiDate, parsePKR } from "@delta/core";
import { getDb } from "../client";
import { audit, BusinessError, newId, requirePerm, type Ctx } from "../context";
import { post } from "../journal";
import { registerApprovalHandler, requestApproval } from "./approvals";
import { getCurrentProfile } from "./profile";

export interface TrancheDoc {
  _id: string;
  orgId: string;
  amountMinor: number;
  purpose: string;
  plannedDate: string;
  status: "planned" | "approved" | "released" | "rejected";
  releaseDate?: string;
  bankRef?: string;
  approvalId?: string;
  createdAt: Date;
  createdBy: string;
}

export async function capitalSummary(orgId: string) {
  const db = await getDb();
  const profile = await getCurrentProfile();
  const rows = await db.collection<TrancheDoc>("capital_tranches").find({ orgId }).sort({ plannedDate: 1 }).toArray();
  const released = rows.filter((r) => r.status === "released").reduce((s, r) => s + r.amountMinor, 0);
  const committed = rows.filter((r) => r.status !== "rejected").reduce((s, r) => s + r.amountMinor, 0);
  return { rows, envelopeMinor: profile.capital.envelopeMinor, releasedMinor: released, committedMinor: committed, warnAtPct: profile.capital.warnAtPct };
}

export async function proposeTranche(ctx: Ctx, raw: unknown) {
  requirePerm(ctx, "tranche:propose");
  const input = TrancheInput.parse(raw);
  const amountMinor = parsePKR(input.amount);
  const s = await capitalSummary(ctx.orgId);
  if (s.committedMinor + amountMinor > s.envelopeMinor) throw new BusinessError("This tranche would exceed the funding envelope.");
  const doc: TrancheDoc = { _id: newId(), orgId: ctx.orgId, amountMinor, purpose: input.purpose, plannedDate: input.plannedDate, status: "planned", createdAt: new Date(), createdBy: ctx.userId };
  const db = await getDb();
  await db.collection<TrancheDoc>("capital_tranches").insertOne(doc);
  await audit(ctx, "tranche.propose", "capital_tranche", doc._id, null, doc);
  const a = await requestApproval(ctx, { kind: "tranche", policyAction: "capital_tranche", refId: doc._id, title: `Capital tranche: ${input.purpose}`, amountMinor });
  await db.collection<TrancheDoc>("capital_tranches").updateOne({ _id: doc._id }, { $set: { approvalId: a._id } });
  return doc;
}

export async function releaseTranche(ctx: Ctx, trancheId: string, bankRef: string, releaseDate = karachiDate()) {
  requirePerm(ctx, "tranche:release");
  if (!bankRef.trim()) throw new BusinessError("Bank reference is required");
  const db = await getDb();
  const t = await db.collection<TrancheDoc>("capital_tranches").findOne({ _id: trancheId, orgId: ctx.orgId });
  if (!t || t.status !== "approved") throw new BusinessError("Only approved tranches can be released");
  const s = await capitalSummary(ctx.orgId);
  if (s.releasedMinor + t.amountMinor > s.envelopeMinor) throw new BusinessError("Release would exceed the funding envelope");
  const profile = await getCurrentProfile();
  await post(ctx, { type: "capital_tranche_released", date: releaseDate, trancheId, amountMinor: t.amountMinor, providerPartnerId: profile.capital.providerPartnerId, bankRef }, profile);
  await db.collection<TrancheDoc>("capital_tranches").updateOne({ _id: trancheId }, { $set: { status: "released", bankRef, releaseDate } });
  await audit(ctx, "tranche.release", "capital_tranche", trancheId, { status: "approved" }, { status: "released", bankRef });
}

registerApprovalHandler("tranche", {
  async onApproved(_ctx, a, session) {
    await (await getDb()).collection<TrancheDoc>("capital_tranches").updateOne({ _id: a.refId }, { $set: { status: "approved" } }, { session });
  },
  async onRejected(_ctx, a, session) {
    await (await getDb()).collection<TrancheDoc>("capital_tranches").updateOne({ _id: a.refId }, { $set: { status: "rejected" } }, { session });
  },
});

import { AgreementProfile } from "@delta/config-schema";
import { diffObjects, karachiDate } from "@delta/core";
import { getDb, ORG_ID } from "../client";
import { audit, BusinessError, requirePerm, type Ctx } from "../context";
import { registerApprovalHandler, requestApproval } from "./approvals";

export interface ProfileDoc extends AgreementProfile {
  _id: string;
  createdAt: Date;
  createdBy: string;
  activatedAt?: Date;
  changeNote?: string;
  approvalId?: string;
  discardedAt?: Date;
}

const col = async () => (await getDb()).collection<ProfileDoc>("agreement_profiles");
const strip = ({ _id, createdAt, createdBy, activatedAt, changeNote, approvalId, discardedAt, ...p }: ProfileDoc) => p as AgreementProfile;

/** Profile effective on `date` (YYYY-MM-DD). Falls back to the earliest activated version. */
export async function getProfileFor(date: string, orgId = ORG_ID): Promise<AgreementProfile & { version: number }> {
  const c = await col();
  const activated = { orgId, activatedAt: { $exists: true } };
  const doc = (await c.find({ ...activated, effectiveFrom: { $lte: date } }).sort({ version: -1 }).limit(1).next()) ?? (await c.find(activated).sort({ version: 1 }).limit(1).next());
  if (!doc) throw new BusinessError("No active Agreement Profile. Run the seed script.");
  return AgreementProfile.parse(strip(doc));
}
export const getCurrentProfile = () => getProfileFor(karachiDate());

export async function getProfileVersion(version: number, orgId = ORG_ID) {
  const d = await (await col()).findOne({ orgId, version });
  return d ? AgreementProfile.parse(strip(d)) : null;
}

export async function listProfiles(orgId = ORG_ID) {
  return (await col()).find({ orgId }).sort({ version: -1 }).toArray();
}

/** Create a draft from JSON (validated). Active versions are never edited. */
export async function createDraft(ctx: Ctx, json: unknown, changeNote: string) {
  requirePerm(ctx, "config:propose");
  const c = await col();
  const latest = await c.find({ orgId: ctx.orgId }).sort({ version: -1 }).limit(1).next();
  const parsed = AgreementProfile.safeParse({ ...(json as object), orgId: ctx.orgId, version: (latest?.version ?? 0) + 1, status: "draft" });
  if (!parsed.success) throw new BusinessError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const db = await getDb();
  const lastClosed = await db.collection("periods").find({ orgId: ctx.orgId, status: { $in: ["closing", "closed", "final"] } }).sort({ periodId: -1 }).limit(1).next();
  if (lastClosed && parsed.data.effectiveFrom.slice(0, 7) <= lastClosed.periodId) throw new BusinessError(`effectiveFrom must be after closed period ${lastClosed.periodId}; history is never recomputed.`);
  const doc: ProfileDoc = { ...parsed.data, _id: `profile-v${parsed.data.version}`, createdAt: new Date(), createdBy: ctx.userId, changeNote };
  await c.insertOne(doc);
  await audit(ctx, "profile.draft", "agreement_profile", doc._id, null, { version: doc.version, changeNote });
  return doc;
}

export async function submitDraft(ctx: Ctx, version: number) {
  requirePerm(ctx, "config:propose");
  const c = await col();
  const d = await c.findOne({ orgId: ctx.orgId, version });
  if (!d || d.status !== "draft" || d.discardedAt) throw new BusinessError("Only drafts can be submitted");
  const approval = await requestApproval(ctx, { kind: "config_change", policyAction: "config_change", refId: d._id, title: `Agreement Profile v${version}: ${d.changeNote ?? ""}` });
  await c.updateOne({ _id: d._id }, { $set: { status: "pending_approval", approvalId: approval._id } });
  await audit(ctx, "profile.submit", "agreement_profile", d._id, { status: "draft" }, { status: "pending_approval" });
}

export async function deleteDraft(ctx: Ctx, version: number) {
  requirePerm(ctx, "config:propose");
  const c = await col();
  const d = await c.findOne({ orgId: ctx.orgId, version, status: "draft", discardedAt: { $exists: false } });
  if (!d) throw new BusinessError("Only drafts can be discarded");
  // Drafts never took effect; discarding is recorded as status change, not deleted.
  await c.updateOne({ _id: d._id }, { $set: { discardedAt: new Date() } });
  await audit(ctx, "profile.discard", "agreement_profile", d._id, { status: "draft" }, { status: "discarded" });
}

export async function diffWithActive(version: number) {
  const c = await col();
  const d = await c.findOne({ orgId: ORG_ID, version });
  const active = await c.find({ orgId: ORG_ID, status: "active" }).sort({ version: -1 }).limit(1).next();
  if (!d || !active) return [];
  const omit = (p: ProfileDoc) => {
    const { version: _v, status: _s, ...rest } = strip(p);
    return rest;
  };
  return diffObjects(omit(active), omit(d));
}

registerApprovalHandler("config_change", {
  async onApproved(ctx, a, session) {
    const db = await getDb();
    const c = db.collection<ProfileDoc>("agreement_profiles");
    const d = await c.findOne({ _id: a.refId }, { session });
    if (!d) return;
    await c.updateMany({ orgId: d.orgId, status: "active" }, { $set: { status: "superseded" } }, { session });
    await c.updateOne({ _id: d._id }, { $set: { status: "active", activatedAt: new Date() } }, { session });
    await db.collection("unmapped_statuses").updateMany({ orgId: d.orgId, pendingVersion: d.version }, { $set: { resolved: true } }, { session });
    await audit(ctx, "profile.activate", "agreement_profile", d._id, { status: "pending_approval" }, { status: "active", effectiveFrom: d.effectiveFrom }, session);
  },
  async onRejected(ctx, a, session) {
    const db = await getDb();
    await db.collection<ProfileDoc>("agreement_profiles").updateOne({ _id: a.refId }, { $set: { status: "draft" } }, { session });
  },
});

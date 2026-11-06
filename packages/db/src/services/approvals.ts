import type { ClientSession } from "mongodb";
import { approvalsSatisfied, evaluatePolicy, type PolicyDecision } from "@delta/core";
import { getDb, withTransaction } from "../client";
import { audit, BusinessError, newId, type Ctx } from "../context";
import { getCurrentProfile } from "./profile";

export type ApprovalKind = "config_change" | "expense" | "tranche" | "withdrawal" | "withdrawal_override" | "correction" | "objection_ruling";

export interface ApprovalDoc {
  _id: string;
  orgId: string;
  kind: ApprovalKind;
  policyAction: string;
  refId: string;
  title: string;
  amountMinor?: number;
  requesterId: string;
  requesterName: string;
  status: "pending" | "approved" | "rejected";
  decision: PolicyDecision;
  decisions: { userId: string; userName: string; role: string; decision: "approve" | "reject"; comment: string; at: Date; ip: string }[];
  createdAt: Date;
  resolvedAt?: Date;
}

type Handler = { onApproved: (ctx: Ctx, a: ApprovalDoc, session: ClientSession) => Promise<void>; onRejected?: (ctx: Ctx, a: ApprovalDoc, session: ClientSession) => Promise<void> };
// Lazy registry (services register at import time; avoids circular-import TDZ issues).
function reg(): Map<ApprovalKind, Handler> {
  return ((globalThis as unknown as { __approvalHandlers?: Map<ApprovalKind, Handler> }).__approvalHandlers ??= new Map());
}
export function registerApprovalHandler(kind: ApprovalKind, h: Handler) {
  reg().set(kind, h);
}

export async function requestApproval(ctx: Ctx, args: { kind: ApprovalKind; policyAction: string; refId: string; title: string; amountMinor?: number; scope?: string }, session?: ClientSession): Promise<ApprovalDoc> {
  const profile = await getCurrentProfile();
  const decision = evaluatePolicy(profile, args.policyAction, args.amountMinor, args.scope);
  const doc: ApprovalDoc = {
    _id: newId(),
    orgId: ctx.orgId,
    kind: args.kind,
    policyAction: args.policyAction,
    refId: args.refId,
    title: args.title,
    amountMinor: args.amountMinor,
    requesterId: ctx.userId,
    requesterName: ctx.userName,
    status: "pending",
    decision,
    decisions: [],
    createdAt: new Date(),
  };
  const db = await getDb();
  await db.collection<ApprovalDoc>("approvals").insertOne(doc, { session });
  await audit(ctx, "approval.request", "approval", doc._id, null, { kind: doc.kind, refId: doc.refId, approvers: decision.approverRoles, mode: decision.mode }, session);
  return doc;
}

export async function decideApproval(ctx: Ctx, approvalId: string, decision: "approve" | "reject", comment: string) {
  return withTransaction(async (session, db) => {
    const a = await db.collection<ApprovalDoc>("approvals").findOne({ _id: approvalId, orgId: ctx.orgId }, { session });
    if (!a) throw new BusinessError("Approval not found");
    if (a.status !== "pending") throw new BusinessError(`Already ${a.status}`);
    if (!a.decision.approverRoles.includes(ctx.role)) throw new BusinessError(`Your role (${ctx.role}) is not an approver for this request`);
    if (a.decision.rule?.requires === "requester_and_separate_approver" && a.requesterId === ctx.userId) throw new BusinessError("Requester cannot approve their own request");
    if (a.decisions.some((d) => d.userId === ctx.userId)) throw new BusinessError("You have already decided on this request");
    if (decision === "reject" && !comment.trim()) throw new BusinessError("A comment is required to reject");
    const entry = { userId: ctx.userId, userName: ctx.userName, role: ctx.role, decision, comment, at: new Date(), ip: ctx.ip };
    const decisions = [...a.decisions, entry];
    const res = approvalsSatisfied(a.decision, decisions, a.requesterId);
    const status = res.rejected ? "rejected" : res.satisfied ? "approved" : "pending";
    await db.collection<ApprovalDoc>("approvals").updateOne({ _id: a._id }, { $set: { decisions, status, ...(status !== "pending" ? { resolvedAt: new Date() } : {}) } }, { session });
    await audit(ctx, `approval.${decision}`, "approval", a._id, { status: a.status }, { status, comment }, session);
    const updated = { ...a, decisions, status } as ApprovalDoc;
    const h = reg().get(a.kind);
    if (status === "approved") await h?.onApproved(ctx, updated, session);
    if (status === "rejected") await h?.onRejected?.(ctx, updated, session);
    return { status, missingRoles: res.missingRoles };
  });
}

export async function pendingApprovals(orgId: string) {
  const db = await getDb();
  return db.collection<ApprovalDoc>("approvals").find({ orgId, status: "pending" }).sort({ createdAt: -1 }).toArray();
}

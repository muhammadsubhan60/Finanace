import { ExpenseInput } from "@delta/config-schema";
import { assertCategoryAllowed, karachiDate, parsePKR } from "@delta/core";
import { getDb } from "../client";
import { audit, BusinessError, newId, requirePerm, type Ctx } from "../context";
import { post } from "../journal";
import { registerApprovalHandler, requestApproval } from "./approvals";
import { getProfileFor } from "./profile";

export interface ExpenseDoc {
  _id: string;
  orgId: string;
  categoryKey: string;
  amountMinor: number;
  date: string;
  payee: string;
  storeId?: string;
  projectId?: string;
  memo?: string;
  recurring: boolean;
  paidFrom: "bank" | "cash" | "accounts_payable" | "card_payable";
  receipts: { name: string; path: string; size: number }[];
  status: "draft" | "pending" | "approved" | "posted" | "rejected";
  source: "manual" | "ads_sync" | "courier_charge" | "import";
  requesterId: string;
  requesterName: string;
  approvalId?: string;
  journalEntryId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function createExpense(ctx: Ctx, raw: unknown, extra: { paidFrom?: ExpenseDoc["paidFrom"]; receipts?: ExpenseDoc["receipts"] } = {}) {
  requirePerm(ctx, "expense:create");
  const input = ExpenseInput.parse(raw);
  const profile = await getProfileFor(input.date);
  const cat = profile.expenseCategories.find((c) => c.key === input.categoryKey);
  assertCategoryAllowed(profile, input.categoryKey, cat?.label);
  const amountMinor = parsePKR(input.amount);
  if (amountMinor <= 0) throw new BusinessError("Amount must be positive");
  const db = await getDb();
  const doc: ExpenseDoc = {
    _id: newId(),
    orgId: ctx.orgId,
    categoryKey: input.categoryKey,
    amountMinor,
    date: input.date,
    payee: input.payee,
    storeId: input.storeId || undefined,
    projectId: input.projectId || undefined,
    memo: input.memo,
    recurring: input.recurring,
    paidFrom: extra.paidFrom ?? "bank",
    receipts: extra.receipts ?? [],
    status: "pending",
    source: "manual",
    requesterId: ctx.userId,
    requesterName: ctx.userName,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.collection<ExpenseDoc>("expenses").insertOne(doc);
  await audit(ctx, "expense.create", "expense", doc._id, null, doc);
  const approval = await requestApproval(ctx, {
    kind: "expense",
    policyAction: input.recurring ? "new_recurring_cost" : "spend",
    scope: input.recurring ? undefined : "single_purchase",
    refId: doc._id,
    title: `${cat?.label ?? input.categoryKey}: ${input.payee}`,
    amountMinor,
  });
  if (!approval.decision.requiresApproval) {
    await postExpense(ctx, doc._id);
  } else await db.collection<ExpenseDoc>("expenses").updateOne({ _id: doc._id }, { $set: { approvalId: approval._id } });
  return doc;
}

async function postExpense(ctx: Ctx, expenseId: string, session?: import("mongodb").ClientSession) {
  const db = await getDb();
  const e = await db.collection<ExpenseDoc>("expenses").findOne({ _id: expenseId }, { session });
  if (!e) throw new BusinessError("Expense not found");
  const profile = await getProfileFor(e.date);
  // A late approval of an expense dated in a closed period is posted in the current period instead.
  const period = await db.collection("periods").findOne({ orgId: e.orgId, periodId: e.date.slice(0, 7) }, { session });
  const date = period && period.status !== "open" ? karachiDate() : e.date;
  const entry = await post(ctx, { type: "expense_posted", date, expenseId: e._id, categoryKey: e.categoryKey, amountMinor: e.amountMinor, paidFrom: e.paidFrom, storeId: e.storeId, projectId: e.projectId }, profile, { session });
  await db.collection<ExpenseDoc>("expenses").updateOne({ _id: e._id }, { $set: { status: "posted", journalEntryId: entry?._id, updatedAt: new Date() } }, { session });
}

registerApprovalHandler("expense", {
  onApproved: (ctx, a, session) => postExpense(ctx, a.refId, session),
  async onRejected(ctx, a, session) {
    const db = await getDb();
    await db.collection<ExpenseDoc>("expenses").updateOne({ _id: a.refId }, { $set: { status: "rejected", updatedAt: new Date() } }, { session });
    await audit(ctx, "expense.reject", "expense", a.refId, null, { status: "rejected" }, session);
  },
});

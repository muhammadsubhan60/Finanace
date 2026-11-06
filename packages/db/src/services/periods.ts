import type { AgreementProfile } from "@delta/config-schema";
import { ObjectionInput } from "@delta/config-schema";
import {
  addDays, addMonths, computeOverDistribution, computePeriod, expenseAccount, karachiDate, monthsBetween, parsePKR, periodBounds, periodIdOf,
  validateEntry, type JournalEntryDraft, type PeriodInput, type PeriodResult,
} from "@delta/core";
import { getDb, ORG_ID, withTransaction } from "../client";
import { audit, BusinessError, newId, requirePerm, type Ctx } from "../context";
import { balances, crBal, dr, post, postEntry } from "../journal";
import { registerApprovalHandler, requestApproval } from "./approvals";
import { getProfileFor, getProfileVersion } from "./profile";

export type PeriodStatus = "open" | "closing" | "closed" | "final" | "reopened_for_correction";
export interface ReserveInputs {
  payrollDueMinor: number;
  taxesDueMinor: number;
  refundsExpectedMinor: number;
  courierReturnExposureMinor: number;
  fixedCostsNextBufferMinor: number;
  inventoryNeedsNextBufferMinor: number;
  extraReserveMinor?: number;
  extraReserveCalcRef?: string;
}
export interface PeriodDoc {
  _id: string;
  orgId: string;
  periodId: string;
  status: PeriodStatus;
  profileVersion?: number;
  bankBalanceMinor?: number;
  reserveInputs?: ReserveInputs;
  closedAt?: Date;
  closedBy?: string;
  finalDueAt?: Date;
  finalizedAt?: Date;
  snapshotId?: string;
  history: { at: Date; from: string; to: string; by: string }[];
}
export interface SnapshotDoc {
  _id: string;
  orgId: string;
  periodId: string;
  kind: "close" | "correction" | "estimate";
  input: PeriodInput;
  result: PeriodResult;
  inputsHash: string;
  engineVersion: string;
  profileVersion: number;
  createdAt: Date;
  createdBy: string;
}

const periods = async () => (await getDb()).collection<PeriodDoc>("periods");

export async function ensurePeriod(periodId: string, orgId = ORG_ID): Promise<PeriodDoc> {
  const c = await periods();
  await c.updateOne({ orgId, periodId }, { $setOnInsert: { _id: `${orgId}:${periodId}`, orgId, periodId, status: "open", history: [] } }, { upsert: true });
  return (await c.findOne({ orgId, periodId }))!;
}

async function transition(ctx: Ctx, p: PeriodDoc, to: PeriodStatus, set: Partial<PeriodDoc> = {}, session?: import("mongodb").ClientSession) {
  const c = await periods();
  await c.updateOne({ _id: p._id, status: p.status }, { $set: { status: to, ...set }, $push: { history: { at: new Date(), from: p.status, to, by: ctx.userId } } }, { session });
  await audit(ctx, "period.transition", "period", p.periodId, { status: p.status }, { status: to }, session);
}

/** Cash-side ledger figures as of a date. */
async function ledgerCash(orgId: string, upToDate: string) {
  const b = await balances(orgId, { date: { $lte: upToDate } });
  return {
    bankAndCashMinor: dr(b, "bank") + dr(b, "cash"),
    reinvestmentFundMinor: crBal(b, "reinvestment_fund"),
    knownLiabilitiesMinor: Math.max(0, crBal(b, "accounts_payable") + crBal(b, "card_payable") + crBal(b, "accrued_liabilities") + crBal(b, "taxes_payable")),
  };
}

async function partnerOpening(orgId: string, periodId: string, profile: AgreementProfile): Promise<PeriodInput["partners"]> {
  const db = await getDb();
  const [snaps, wd, netting] = await Promise.all([
    latestSnapshotsBefore(orgId, periodId),
    db.collection("withdrawals").aggregate<{ _id: { partnerId: string; periodId: string }; total: number }>([
    { $match: { orgId, status: "paid", periodId: { $lte: periodId } } },
    { $group: { _id: { partnerId: "$partnerId", periodId: "$periodId" }, total: { $sum: "$amountMinor" } } },
  ]).toArray(),
    db.collection("netting_receivables").aggregate<{ _id: string; total: number }>([{ $match: { orgId } }, { $group: { _id: "$partnerId", total: { $sum: "$amountMinor" } } }]).toArray(),
  ]);
  const out: PeriodInput["partners"] = {};
  for (const p of profile.partners) {
    let opening = 0;
    let nettingApplied = 0;
    for (const s of snaps) {
      const pr = s.result.partners.find((x) => x.partnerId === p.partnerId);
      if (pr) {
        opening += pr.allocationMinor - pr.nettingAppliedMinor;
        nettingApplied += pr.nettingAppliedMinor;
      }
    }
    opening -= wd.filter((w) => w._id.partnerId === p.partnerId && w._id.periodId < periodId).reduce((s, w) => s + w.total, 0);
    out[p.partnerId] = {
      openingUndrawnMinor: opening,
      withdrawnThisPeriodMinor: wd.filter((w) => w._id.partnerId === p.partnerId && w._id.periodId === periodId).reduce((s, w) => s + w.total, 0),
      nettingReceivableMinor: Math.max(0, (netting.find((n) => n._id === p.partnerId)?.total ?? 0) - nettingApplied),
    };
  }
  return out;
}

async function latestSnapshotsBefore(orgId: string, periodId: string): Promise<SnapshotDoc[]> {
  const db = await getDb();
  const ps = await db.collection<PeriodDoc>("periods").find({ orgId, periodId: { $lt: periodId }, status: { $in: ["closed", "final"] }, snapshotId: { $exists: true } }).toArray();
  const ids = ps.map((p) => p.snapshotId!);
  return db.collection<SnapshotDoc>("period_snapshots").find({ _id: { $in: ids } }).toArray();
}

/** Build the engine input for a period purely from ledger + period docs. */
export async function buildPeriodInput(orgId: string, periodId: string, profile: AgreementProfile, opts: { cashAsOf?: string } = {}): Promise<PeriodInput> {
  const db = await getDb();
  const { start, end } = periodBounds(periodId);
  // Period results exclude close postings and corrections made later for earlier periods.
  // Corrections for earlier periods are attributed to that period's correction statement, not to this one.
  // All reads are independent: run them together so the page waits one round trip, not five.
  const [pdoc, b, prevSnaps, cash, partners] = await Promise.all([
    db.collection<PeriodDoc>("periods").findOne({ orgId, periodId }),
    balances(orgId, { periodId, source: { $nin: ["period_close", "correction"] } }),
    latestSnapshotsBefore(orgId, periodId),
    ledgerCash(orgId, opts.cashAsOf ?? end),
    partnerOpening(orgId, periodId, profile),
  ]);
  const expensesByCategory: Record<string, number> = {};
  for (const c of profile.expenseCategories) {
    if (c.key === "cogs" || c.key === "reinvestment") continue;
    const v = dr(b, expenseAccount(c.key));
    if (v) expensesByCategory[c.key] = v;
  }
  const prev = prevSnaps.sort((a, b2) => b2.periodId.localeCompare(a.periodId))[0];
  const termEnd = addMonths(profile.term.start.slice(0, 7), profile.term.months);
  const r = pdoc?.reserveInputs;
  return {
    periodId,
    periodStart: start,
    postTermination: periodId >= termEnd,
    revenue: {
      grossSalesMinor: crBal(b, "sales"),
      discountsMinor: dr(b, "sales_returns_discounts"),
      refundsMinor: dr(b, "sales_refunds"),
      taxesCollectedMinor: dr(b, "sales_tax_collected"),
    },
    cogsMinor: dr(b, expenseAccount("cogs")),
    inventoryWriteDownMinor: dr(b, expenseAccount("inventory_writedown")),
    expensesByCategory,
    openingLossBalanceMinor: prev?.result.loss.closingMinor ?? 0,
    cash: {
      bankAndCashMinor: pdoc?.bankBalanceMinor ?? cash.bankAndCashMinor,
      reinvestmentFundBalanceMinor: cash.reinvestmentFundMinor,
      reserve: {
        knownLiabilitiesMinor: cash.knownLiabilitiesMinor,
        payrollDueMinor: r?.payrollDueMinor ?? 0,
        taxesDueMinor: r?.taxesDueMinor ?? 0,
        refundsExpectedMinor: r?.refundsExpectedMinor ?? 0,
        courierReturnExposureMinor: r?.courierReturnExposureMinor ?? 0,
        fixedCostsNextBufferMinor: r?.fixedCostsNextBufferMinor ?? 0,
        inventoryNeedsNextBufferMinor: r?.inventoryNeedsNextBufferMinor ?? 0,
        extraReserveMinor: r?.extraReserveMinor,
        extraReserveCalcRef: r?.extraReserveCalcRef,
      },
    },
    partners,
  };
}

/** Live estimate (not final) for dashboards. */
export async function estimatePeriod(orgId: string, periodId: string) {
  const profile = await getProfileFor(periodBounds(periodId).start, orgId);
  const input = await buildPeriodInput(orgId, periodId, profile, { cashAsOf: karachiDate() });
  return { input, result: computePeriod(input, profile), profile };
}

// ---------------- Close checklist ----------------
export interface CheckItem { key: string; label: string; ok: boolean; detail: string; blocking: boolean; href?: string }

export async function closeChecklist(orgId: string, periodId: string): Promise<CheckItem[]> {
  const db = await getDb();
  const { start, end, endUtcExclusive } = periodBounds(periodId);
  const profile = await getProfileFor(start, orgId);
  const cfg = profile.closeChecklist;
  const pdoc = await db.collection<PeriodDoc>("periods").findOne({ orgId, periodId });
  const items: CheckItem[] = [];
  const add = (key: string, label: string, ok: boolean, detail: string, href?: string, blockingOverride?: boolean) =>
    items.push({ key, label, ok, detail, blocking: blockingOverride ?? cfg[key] ?? false, href });

  const integrations = await db.collection("integrations").find({ orgId, enabled: true }).toArray();
  const stale = integrations.filter((i) => !i.lastSuccessAt || i.lastSuccessAt < endUtcExclusive);
  add("integrations_synced", "All integrations synced to month end", stale.length === 0, stale.length ? `${stale.length} not synced past ${end}: ${stale.map((s) => s.label).join(", ")}` : `${integrations.length} enabled, all current`, "/integrations");

  const unmapped = await db.collection("unmapped_statuses").countDocuments({ orgId, resolved: { $ne: true } });
  add("no_unmapped_statuses", "No unmapped courier statuses", unmapped === 0, `${unmapped} unmapped`, "/configuration/status-mappings");

  const unmatchedLines = await db.collection("cod_settlement_lines").countDocuments({ orgId, flag: { $ne: "ok" }, resolved: { $ne: true } });
  add("no_unmatched_settlement_lines", "No unmatched settlement lines", unmatchedLines === 0, `${unmatchedLines} open`, "/cod");

  const unalloc = await db.collection("ad_spend_daily").countDocuments({ orgId, date: { $gte: start, $lte: end }, allocation: "unallocated", deletedAt: { $exists: false } });
  add("no_unallocated_ad_spend", "No unallocated ad spend", unalloc === 0, `${unalloc} rows`, "/ads");

  const pending = await db.collection("expenses").countDocuments({ orgId, date: { $gte: start, $lte: end }, status: { $in: ["draft", "pending"] } });
  add("no_pending_expenses", "No draft/pending expenses in the period", pending === 0, `${pending} pending`, "/expenses");

  const stockCount = await db.collection("stock_counts").findOne({ orgId, periodId });
  add("stock_reconciled", "Stock reconciled (count entered)", !!stockCount, stockCount ? "Count recorded" : "No count recorded", "/stock");

  add("bank_balance_entered", "Bank balance entered", pdoc?.bankBalanceMinor != null, pdoc?.bankBalanceMinor != null ? "Entered" : "Missing", `/periods/${periodId}`);

  const unmatchedShip = await db.collection("shipments").countDocuments({ orgId, orderId: null, bookedAt: { $lt: endUtcExclusive } });
  add("unmatched_shipments", "Shipments matched to orders", unmatchedShip === 0, `${unmatchedShip} unmatched (COGS estimated)`, "/shipments/matching", profile.matching.unmatchedBlocksClose);
  return items;
}

export async function saveCloseInputs(ctx: Ctx, periodId: string, args: { bankBalance?: string; reserve: Partial<Record<keyof ReserveInputs, string>> }) {
  requirePerm(ctx, "period:close");
  const p = await ensurePeriod(periodId, ctx.orgId);
  if (p.status !== "open" && p.status !== "closing") throw new BusinessError(`Period is ${p.status}`);
  const r: Record<string, number | string | undefined> = {};
  for (const [k, v] of Object.entries(args.reserve)) {
    if (k === "extraReserveCalcRef") r[k] = v || undefined;
    else r[k] = v ? parsePKR(v) : 0;
  }
  const set: Partial<PeriodDoc> = { reserveInputs: r as unknown as ReserveInputs };
  if (args.bankBalance) set.bankBalanceMinor = parsePKR(args.bankBalance);
  await (await periods()).updateOne({ _id: p._id }, { $set: set });
  await audit(ctx, "period.inputs", "period", periodId, null, set);
}

export async function startClose(ctx: Ctx, periodId: string) {
  requirePerm(ctx, "period:close");
  const p = await ensurePeriod(periodId, ctx.orgId);
  if (p.status !== "open") throw new BusinessError(`Period is ${p.status}`);
  if (periodId >= periodIdOf(karachiDate())) throw new BusinessError("Only past months can be closed");
  const checks = await closeChecklist(ctx.orgId, periodId);
  const failed = checks.filter((c) => c.blocking && !c.ok);
  if (failed.length) throw new BusinessError(`Blocking checks failed: ${failed.map((f) => f.label).join("; ")}`);
  await transition(ctx, p, "closing");
}

export async function cancelClose(ctx: Ctx, periodId: string) {
  requirePerm(ctx, "period:close");
  const p = await ensurePeriod(periodId, ctx.orgId);
  if (p.status !== "closing") throw new BusinessError("Period is not closing");
  await transition(ctx, p, "open");
}

/** Compute with the profile effective at period start, store immutable snapshot, post close entries, start objection window. */
export async function closePeriod(ctx: Ctx, periodId: string) {
  requirePerm(ctx, "period:close");
  const p = await ensurePeriod(periodId, ctx.orgId);
  if (p.status !== "closing") throw new BusinessError("Start the close first (data freeze + checks)");
  const checks = await closeChecklist(ctx.orgId, periodId);
  const failed = checks.filter((c) => c.blocking && !c.ok);
  if (failed.length) throw new BusinessError(`Blocking checks failed: ${failed.map((f) => f.label).join("; ")}`);
  const profile = await getProfileFor(periodBounds(periodId).start, ctx.orgId);
  const rawInput = await buildPeriodInput(ctx.orgId, periodId, profile);
  // Normalize (drop undefined) so the stored snapshot recomputes to the identical hash.
  const input = JSON.parse(JSON.stringify(rawInput)) as PeriodInput;
  const result = computePeriod(input, profile);
  const snap: SnapshotDoc = { _id: newId(), orgId: ctx.orgId, periodId, kind: "close", input, result, inputsHash: result.inputsHash, engineVersion: result.engineVersion, profileVersion: profile.version, createdAt: new Date(), createdBy: ctx.userId };
  await withTransaction(async (session, db) => {
    await db.collection<SnapshotDoc>("period_snapshots").insertOne(snap, { session });
    await post(ctx, { type: "period_close", date: periodBounds(periodId).end, periodId, result }, profile, { session, allowClosedPeriod: "period_close" });
    const finalDueAt = new Date(Date.now() + profile.finalization.days * 86_400_000);
    await transition(ctx, p, "closed", { closedAt: new Date(), closedBy: ctx.userId, finalDueAt, snapshotId: snap._id, profileVersion: profile.version }, session);
  });
  return snap;
}

/** Worker job: closed → final after finalization.days. Objections pause only their own items. */
export async function autoFinalize(ctx: Ctx, now = new Date()) {
  const c = await periods();
  const due = await c.find({ orgId: ctx.orgId, status: "closed", finalDueAt: { $lte: now } }).toArray();
  for (const p of due) {
    const db = await getDb();
    const paused = await db.collection("objections").countDocuments({ orgId: ctx.orgId, periodId: p.periodId, status: "open" });
    await transition(ctx, p, "final", { finalizedAt: now });
    if (paused) await db.collection("objections").updateMany({ orgId: ctx.orgId, periodId: p.periodId, status: "open" }, { $set: { finalityPaused: true } });
  }
  return due.length;
}

export async function getSnapshot(orgId: string, periodId: string) {
  const db = await getDb();
  const p = await db.collection<PeriodDoc>("periods").findOne({ orgId, periodId });
  if (!p?.snapshotId) return null;
  const snap = await db.collection<SnapshotDoc>("period_snapshots").findOne({ _id: p.snapshotId });
  const corrections = await db.collection<SnapshotDoc>("period_snapshots").find({ orgId, periodId, kind: "correction" }).sort({ createdAt: -1 }).toArray();
  return { period: p, snapshot: snap, corrections };
}

/** Verify a stored snapshot reproduces with its own profile version (never a newer one). */
export async function verifySnapshot(snapshotId: string) {
  const db = await getDb();
  const s = await db.collection<SnapshotDoc>("period_snapshots").findOne({ _id: snapshotId });
  if (!s) return { ok: false };
  const profile = await getProfileVersion(s.profileVersion, s.orgId);
  if (!profile) return { ok: false };
  return { ok: computePeriod(s.input, profile).outputsHash === s.result.outputsHash };
}

// ---------------- Objections ----------------
export async function raiseObjection(ctx: Ctx, raw: unknown) {
  requirePerm(ctx, "objection:raise");
  const input = ObjectionInput.parse(raw);
  const db = await getDb();
  const p = await db.collection<PeriodDoc>("periods").findOne({ orgId: ctx.orgId, periodId: input.periodId });
  if (!p || p.status !== "closed") throw new BusinessError("Objections can be raised on closed (not yet final) periods");
  const profile = await getProfileFor(periodBounds(input.periodId).start, ctx.orgId);
  if (p.closedAt && Date.now() > p.closedAt.getTime() + profile.finalization.objectionWindowDays * 86_400_000) throw new BusinessError("The objection window has passed");
  const doc = { _id: newId(), orgId: ctx.orgId, ...input, amountMinor: input.amount ? parsePKR(input.amount) : null, status: "open", raisedBy: ctx.userId, raisedByName: ctx.userName, createdAt: new Date(), comments: [] as unknown[] };
  await db.collection("objections").insertOne(doc as never);
  await audit(ctx, "objection.raise", "objection", doc._id, null, doc);
  return doc;
}

export async function commentObjection(ctx: Ctx, id: string, text: string) {
  requirePerm(ctx, ctx.role === "accountant" ? "objection:raise" : "dashboard:view");
  const db = await getDb();
  await db.collection("objections").updateOne({ _id: id as never, orgId: ctx.orgId }, { $push: { comments: { by: ctx.userName, role: ctx.role, text, at: new Date() } } as never });
  await audit(ctx, "objection.comment", "objection", id, null, { text });
}

export async function resolveObjection(ctx: Ctx, id: string, resolution: "agreed_adjust" | "rejected" | "accountant_ruling", note: string) {
  requirePerm(ctx, "objection:resolve");
  const db = await getDb();
  await db.collection("objections").updateOne({ _id: id as never, orgId: ctx.orgId }, { $set: { status: "resolved", resolution, resolutionNote: note, resolvedBy: ctx.userName, resolvedAt: new Date() } });
  await audit(ctx, "objection.resolve", "objection", id, null, { resolution, note });
}

// ---------------- Corrections after Final ----------------
export async function requestCorrection(ctx: Ctx, args: { periodId: string; reason: string; memo: string; lines: JournalEntryDraft["lines"] }) {
  requirePerm(ctx, "journal:adjust");
  const db = await getDb();
  const p = await db.collection<PeriodDoc>("periods").findOne({ orgId: ctx.orgId, periodId: args.periodId });
  if (!p || (p.status !== "final" && p.status !== "closed")) throw new BusinessError("Corrections apply to closed or final periods");
  const profile = await getProfileFor(periodBounds(args.periodId).start, ctx.orgId);
  if (!profile.finalization.correctionReasons.includes(args.reason)) throw new BusinessError(`Reason must be one of: ${profile.finalization.correctionReasons.join(", ")}`);
  if (monthsBetween(periodBounds(args.periodId).start, karachiDate()) > profile.finalization.correctionWindowMonths) throw new BusinessError("Outside the correction window");
  const draft: JournalEntryDraft = { date: karachiDate(), source: "correction", memo: args.memo, lines: args.lines, correctionOf: { periodId: args.periodId, reason: args.reason } };
  validateEntry(draft);
  const doc = { _id: newId(), orgId: ctx.orgId, periodId: args.periodId, reason: args.reason, draft, status: "pending", createdAt: new Date(), createdBy: ctx.userId };
  await db.collection("corrections").insertOne(doc as never);
  await audit(ctx, "correction.request", "correction", doc._id, null, doc);
  await requestApproval(ctx, { kind: "correction", policyAction: "correction", refId: doc._id, title: `Correction to ${args.periodId} (${args.reason})` });
  return doc;
}

registerApprovalHandler("correction", {
  async onApproved(ctx, a, session) {
    const db = await getDb();
    const c = await db.collection("corrections").findOne({ _id: a.refId as never }, { session });
    if (!c) return;
    await postEntry(ctx, c.draft as JournalEntryDraft, { session });
    await db.collection("corrections").updateOne({ _id: c._id }, { $set: { status: "posted" } }, { session });
    // Recompute the old period's statement with corrections included, side by side; net any over-distribution.
    const periodId = c.periodId as string;
    const orig = await db.collection<SnapshotDoc>("period_snapshots").findOne({ orgId: ctx.orgId, periodId, kind: "close" }, { session });
    if (!orig) return;
    const profile = (await getProfileVersion(orig.profileVersion, ctx.orgId))!;
    const corr = await db.collection("journal_lines").find({ orgId: ctx.orgId, source: "correction" }, { session }).toArray();
    const entries = await db.collection("journal_entries").find({ orgId: ctx.orgId, source: "correction", "correctionOf.periodId": periodId }, { session }).toArray();
    const ids = new Set(entries.map((e) => e._id as unknown as string));
    const adj = corr.filter((l) => ids.has(l.entryId));
    const delta = (acct: string) => adj.filter((l) => l.accountId === acct).reduce((s, l) => s + l.debitMinor - l.creditMinor, 0);
    const input: PeriodInput = structuredClone(orig.input);
    input.revenue.grossSalesMinor += -delta("sales");
    input.cogsMinor += delta(expenseAccount("cogs"));
    for (const cat of profile.expenseCategories) {
      const d = delta(expenseAccount(cat.key));
      if (d && cat.key !== "cogs") input.expensesByCategory[cat.key] = (input.expensesByCategory[cat.key] ?? 0) + d;
    }
    const result = computePeriod(input, profile);
    await db.collection<SnapshotDoc>("period_snapshots").insertOne({ _id: newId(), orgId: ctx.orgId, periodId, kind: "correction", input, result, inputsHash: result.inputsHash, engineVersion: result.engineVersion, profileVersion: profile.version, createdAt: new Date(), createdBy: ctx.userId }, { session });
    for (const pr of orig.result.partners) {
      const corrected = result.partners.find((x) => x.partnerId === pr.partnerId)!;
      const withdrawn = await db.collection("withdrawals").aggregate<{ t: number }>([{ $match: { orgId: ctx.orgId, partnerId: pr.partnerId, periodId, status: "paid" } }, { $group: { _id: null, t: { $sum: "$amountMinor" } } }], { session }).next();
      const od = computeOverDistribution({ withdrawnMinor: withdrawn?.t ?? 0, correctedEntitlementMinor: corrected.allocationMinor + pr.openingUndrawnMinor, reason: c.reason }, profile);
      if (od.nettingReceivableMinor > 0)
        await db.collection("netting_receivables").insertOne({ _id: newId() as never, orgId: ctx.orgId, partnerId: pr.partnerId, periodId, amountMinor: od.nettingReceivableMinor, personalRepaymentFlag: od.personalRepaymentFlag, reason: c.reason, createdAt: new Date() }, { session });
    }
  },
  async onRejected(_ctx, a, session) {
    await (await getDb()).collection("corrections").updateOne({ _id: a.refId as never }, { $set: { status: "rejected" } }, { session });
  },
});

export function periodTimeline(p: PeriodDoc, profile: AgreementProfile) {
  const { end } = periodBounds(p.periodId);
  const next = addMonths(p.periodId, 1);
  return {
    closeDue: `${next}-${String(profile.reporting.closeDayOfMonth).padStart(2, "0")}`,
    payoutTarget: `${next}-${String(profile.reporting.payoutTargetDayOfMonth).padStart(2, "0")}`,
    periodEnd: end,
    objectionWindowEnds: p.closedAt ? addDays(karachiDate(p.closedAt), profile.finalization.objectionWindowDays) : null,
    finalDue: p.finalDueAt ? karachiDate(p.finalDueAt) : null,
  };
}

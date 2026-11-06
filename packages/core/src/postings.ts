import type { AgreementProfile } from "@delta/config-schema";
import type { JournalEntryDraft, JournalLineDraft } from "./ledger";
import { capitalAccount, expenseAccount, partnerDrawingsAccount, partnerProfitAccount, reinvestmentClaimAccount } from "./ledger";
import type { Minor } from "./money";
import type { PeriodResult } from "./engine/computePeriod";

/**
 * Posting templates: one table keyed by event type. Each template turns an event into balanced lines,
 * reading recognition rules from the profile. No posting logic lives outside this table.
 */
const dr = (accountId: string, minor: Minor, extra: Partial<JournalLineDraft> = {}): JournalLineDraft => ({ accountId, debitMinor: minor, creditMinor: 0, ...extra });
const cr = (accountId: string, minor: Minor, extra: Partial<JournalLineDraft> = {}): JournalLineDraft => ({ accountId, debitMinor: 0, creditMinor: minor, ...extra });
const nz = (lines: JournalLineDraft[]) => lines.filter((l) => l.debitMinor > 0 || l.creditMinor > 0);

export type PostingEvent =
  | { type: "capital_tranche_released"; date: string; trancheId: string; amountMinor: Minor; providerPartnerId: string; bankRef: string }
  | { type: "stock_purchased"; date: string; refId: string; amountMinor: Minor; paidFrom: "bank" | "accounts_payable" }
  | { type: "shipment_delivered"; date: string; shipmentId: string; codMinor: Minor; cogsMinor: Minor; storeId?: string; discountsMinor?: Minor }
  | { type: "shipment_rto"; date: string; shipmentId: string; codMinor: Minor; cogsMinor: Minor; wasRecognized: boolean; storeId?: string }
  | {
      type: "cod_settlement";
      date: string;
      settlementId: string;
      lines: { shipmentId: string; codMinor: Minor; cogsMinor: Minor; storeId?: string }[];
      freightMinor: Minor;
      codFeeMinor: Minor;
      returnFeeMinor: Minor;
      otherDeductionsMinor: Minor;
      netReceivedMinor: Minor;
    }
  | { type: "ad_spend_day"; date: string; adSpendId: string; amountMinor: Minor; storeId?: string }
  | { type: "card_bill_paid"; date: string; refId: string; amountMinor: Minor }
  | { type: "expense_posted"; date: string; expenseId: string; categoryKey: string; amountMinor: Minor; paidFrom: "bank" | "cash" | "accounts_payable" | "card_payable"; storeId?: string; projectId?: string }
  | { type: "partner_withdrawal"; date: string; withdrawalId: string; partnerId: string; amountMinor: Minor }
  | { type: "period_close"; date: string; periodId: string; result: PeriodResult }
  | { type: "bank_balance_adjustment"; date: string; refId: string; amountMinor: Minor; memo: string }
  | { type: "cogs_true_up"; date: string; shipmentId: string; deltaMinor: Minor; storeId?: string }
  | { type: "order_refund"; date: string; refundId: string; amountMinor: Minor; storeId?: string }
  | { type: "stock_adjustment"; date: string; refId: string; amountMinor: Minor; reason: "write_down" | "count_loss" | "count_gain" };

type Template<E extends PostingEvent["type"]> = (e: Extract<PostingEvent, { type: E }>, p: AgreementProfile) => Omit<JournalEntryDraft, "date"> | null;

export const POSTING_TEMPLATES: { [E in PostingEvent["type"]]: Template<E> } = {
  capital_tranche_released: (e) => ({
    source: "capital_tranche",
    memo: `Capital tranche released (${e.bankRef})`,
    idempotencyKey: `tranche:${e.trancheId}`,
    lines: [dr("bank", e.amountMinor, { refType: "tranche", refId: e.trancheId }), cr(capitalAccount(e.providerPartnerId), e.amountMinor, { partnerId: e.providerPartnerId, refType: "tranche", refId: e.trancheId })],
  }),

  stock_purchased: (e) => ({
    source: "stock_purchase",
    memo: "Stock purchased",
    idempotencyKey: `stock_in:${e.refId}`,
    lines: [dr("inventory", e.amountMinor, { refType: "stock_movement", refId: e.refId }), cr(e.paidFrom, e.amountMinor, { refType: "stock_movement", refId: e.refId })],
  }),

  // Revenue at delivery only when recognition = "delivered". Otherwise nothing is posted until payment/settlement.
  shipment_delivered: (e, p) => {
    if (p.revenueRecognition.event !== "delivered") return null;
    const ref = { refType: "shipment", refId: e.shipmentId, storeId: e.storeId };
    return {
      source: "shipment_delivered",
      memo: "Delivered COD shipment — revenue recognized",
      idempotencyKey: `delivered:${e.shipmentId}`,
      lines: nz([dr("courier_cod_in_transit", e.codMinor, ref), cr("sales", e.codMinor, ref), dr(expenseAccount("cogs"), e.cogsMinor, ref), cr("inventory", e.cogsMinor, ref)]),
    };
  },

  // Return to origin: stock comes back; reverse revenue if it had been recognized.
  shipment_rto: (e) => {
    const ref = { refType: "shipment", refId: e.shipmentId, storeId: e.storeId };
    const lines = e.wasRecognized
      ? [dr("sales_returns_discounts", e.codMinor, ref), cr("courier_cod_in_transit", e.codMinor, ref), dr("inventory", e.cogsMinor, ref), cr(expenseAccount("cogs"), e.cogsMinor, ref)]
      : [];
    const l = nz(lines);
    return l.length ? { source: "shipment_rto", memo: "Returned to origin", idempotencyKey: `rto:${e.shipmentId}`, lines: l } : null;
  },

  cod_settlement: (e, p) => {
    const recognizeNow = p.revenueRecognition.event !== "delivered";
    const lines: JournalLineDraft[] = [];
    const ref = { refType: "cod_settlement", refId: e.settlementId };
    let gross = 0;
    for (const l of e.lines) {
      gross += l.codMinor;
      const lref = { refType: "shipment", refId: l.shipmentId, storeId: l.storeId };
      if (recognizeNow) {
        lines.push(cr("sales", l.codMinor, lref), dr(expenseAccount("cogs"), l.cogsMinor, lref), cr("inventory", l.cogsMinor, lref));
      } else lines.push(cr("courier_cod_in_transit", l.codMinor, lref));
    }
    lines.push(
      dr("bank", e.netReceivedMinor, ref),
      dr(expenseAccount("fulfilment_delivery"), e.freightMinor, ref),
      dr(expenseAccount("payment_fees"), e.codFeeMinor, ref),
      dr(expenseAccount("return_charges"), e.returnFeeMinor, ref),
      dr(expenseAccount("other"), e.otherDeductionsMinor, ref),
    );
    const deductions = e.freightMinor + e.codFeeMinor + e.returnFeeMinor + e.otherDeductionsMinor;
    // Courier deductions can include charges for parcels outside this file (e.g. RTO freight). Any gap goes to fulfilment.
    const gap = gross - deductions - e.netReceivedMinor;
    if (gap > 0) lines.push(dr(expenseAccount("fulfilment_delivery"), gap, { ...ref, memo: "Unexplained settlement difference" }));
    // Negative gap: courier charges exceed COD on this remittance — owed to the courier (netted from a later payout).
    if (gap < 0) lines.push(cr("accrued_liabilities", -gap, { ...ref, memo: "Charges exceed COD — payable to courier" }));
    return { source: "cod_settlement", memo: `COD settlement (${e.lines.length} CNs)`, idempotencyKey: `settlement:${e.settlementId}`, lines: nz(lines) };
  },

  ad_spend_day: (e) => ({
    source: "ad_spend",
    memo: "Ad spend",
    idempotencyKey: `ads:${e.adSpendId}:${e.amountMinor}`,
    lines: nz([dr(expenseAccount("ads"), e.amountMinor, { refType: "ad_spend", refId: e.adSpendId, storeId: e.storeId }), cr("card_payable", e.amountMinor, { refType: "ad_spend", refId: e.adSpendId })]),
  }),

  card_bill_paid: (e) => ({
    source: "card_payment",
    memo: "Card bill paid",
    idempotencyKey: `card:${e.refId}`,
    lines: [dr("card_payable", e.amountMinor, { refType: "card_payment", refId: e.refId }), cr("bank", e.amountMinor, { refType: "card_payment", refId: e.refId })],
  }),

  expense_posted: (e) => {
    const ref = { refType: "expense", refId: e.expenseId, storeId: e.storeId, projectId: e.projectId };
    return { source: "expense", memo: `Expense: ${e.categoryKey}`, idempotencyKey: `expense:${e.expenseId}`, lines: [dr(expenseAccount(e.categoryKey), e.amountMinor, ref), cr(e.paidFrom, e.amountMinor, ref)] };
  },

  partner_withdrawal: (e) => ({
    source: "withdrawal",
    memo: "Partner withdrawal",
    idempotencyKey: `withdrawal:${e.withdrawalId}`,
    lines: [
      dr(partnerProfitAccount(e.partnerId), e.amountMinor, { partnerId: e.partnerId, refType: "withdrawal", refId: e.withdrawalId }),
      cr("bank", e.amountMinor, { refType: "withdrawal", refId: e.withdrawalId }),
    ],
  }),

  // Close: reinvestment expense → fund; shared profit from retained earnings → partner undrawn accounts.
  period_close: (e, p) => {
    const r = e.result;
    const ref = { refType: "period", refId: e.periodId };
    const lines: JournalLineDraft[] = [];
    if (r.reinvestment.minor > 0) {
      lines.push(dr(expenseAccount("reinvestment"), r.reinvestment.minor, ref), cr("reinvestment_fund", r.reinvestment.minor, ref));
      if (p.reinvestment.treatment === "credit_partners_pro_rata")
        for (const pr of r.partners) if (pr.reinvestmentClaimMinor > 0) lines.push(dr("reinvestment_claims_contra", pr.reinvestmentClaimMinor, ref), cr(reinvestmentClaimAccount(pr.partnerId), pr.reinvestmentClaimMinor, { ...ref, partnerId: pr.partnerId }));
    }
    for (const pr of r.partners) if (pr.allocationMinor > 0) lines.push(dr("retained_earnings", pr.allocationMinor, ref), cr(partnerProfitAccount(pr.partnerId), pr.allocationMinor, { ...ref, partnerId: pr.partnerId }));
    for (const pr of r.partners) if (pr.nettingAppliedMinor > 0) lines.push(dr(partnerProfitAccount(pr.partnerId), pr.nettingAppliedMinor, { ...ref, partnerId: pr.partnerId, memo: "Over-distribution netting" }), cr(`netting_receivable_${pr.partnerId}`, pr.nettingAppliedMinor, { ...ref, partnerId: pr.partnerId }));
    return lines.length ? { source: "period_close", memo: `Period ${e.periodId} close`, idempotencyKey: `close:${e.periodId}`, lines } : null;
  },

  // Estimated COGS replaced by exact COGS once a shipment is matched to an order (delta may be ±).
  cogs_true_up: (e) => {
    const ref = { refType: "shipment", refId: e.shipmentId, storeId: e.storeId };
    if (e.deltaMinor === 0) return null;
    const lines = e.deltaMinor > 0 ? [dr(expenseAccount("cogs"), e.deltaMinor, ref), cr("inventory", e.deltaMinor, ref)] : [dr("inventory", -e.deltaMinor, ref), cr(expenseAccount("cogs"), -e.deltaMinor, ref)];
    return { source: "cogs_true_up", memo: "COGS true-up after matching", idempotencyKey: `cogs_true_up:${e.shipmentId}:${e.deltaMinor}`, lines };
  },

  order_refund: (e) => ({
    source: "order_refund",
    memo: "Customer refund",
    idempotencyKey: `refund:${e.refundId}`,
    lines: [dr("sales_refunds", e.amountMinor, { refType: "refund", refId: e.refundId, storeId: e.storeId }), cr("bank", e.amountMinor, { refType: "refund", refId: e.refundId })],
  }),

  stock_adjustment: (e) => {
    const ref = { refType: "stock_movement", refId: e.refId };
    const acct = e.reason === "write_down" ? expenseAccount("inventory_writedown") : expenseAccount("cogs");
    const lines = e.reason === "count_gain" ? [dr("inventory", e.amountMinor, ref), cr(acct, e.amountMinor, ref)] : [dr(acct, e.amountMinor, ref), cr("inventory", e.amountMinor, ref)];
    return { source: "stock_adjustment", memo: `Stock ${e.reason.replace("_", " ")}`, idempotencyKey: `stock_adj:${e.refId}`, lines };
  },

  bank_balance_adjustment: (e) => {
    const ref = { refType: "bank_adjustment", refId: e.refId };
    const lines = e.amountMinor >= 0 ? [dr("bank", e.amountMinor, ref), cr("suspense", e.amountMinor, ref)] : [dr("suspense", -e.amountMinor, ref), cr("bank", -e.amountMinor, ref)];
    return { source: "bank_adjustment", memo: e.memo, idempotencyKey: `bankadj:${e.refId}`, lines };
  },
};

export function buildPosting(event: PostingEvent, profile: AgreementProfile): JournalEntryDraft | null {
  const t = POSTING_TEMPLATES[event.type] as Template<typeof event.type>;
  const draft = t(event as never, profile);
  return draft ? { date: event.date, ...draft } : null;
}

export { partnerDrawingsAccount };

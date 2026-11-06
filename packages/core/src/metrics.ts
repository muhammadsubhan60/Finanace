import type { Minor } from "./money";

/** Metric definitions: computed here and shown verbatim in UI tooltips ("how is this calculated"). */
export const METRIC_DEFINITIONS = {
  gross_sales: "Sum of COD amounts of shipments delivered in the range (courier-first), before discounts and refunds.",
  net_sales: "Revenue recognized in the ledger (per the profile's recognition event) minus returns, discounts and taxes collected.",
  orders: "Number of courier shipments booked in the range.",
  aov: "Gross sales ÷ delivered shipments.",
  delivery_rate: "Delivered ÷ (delivered + returned to origin) for shipments that reached a final outcome.",
  rto_rate: "Returned to origin ÷ (delivered + returned to origin).",
  avg_delivery_days: "Average days from booking to delivery for delivered shipments.",
  cod_in_transit: "COD value of shipments not yet delivered and not returned.",
  cod_delivered_unsettled: "COD value of delivered shipments with no courier settlement yet.",
  cod_settled: "COD value of shipments included in an imported or synced settlement.",
  ad_spend: "Daily ad spend allocated to the division (unallocated campaigns excluded).",
  roas: "Platform-attributed revenue ÷ ad spend. Informational only — Meta's attribution.",
  mer: "Net sales ÷ ad spend (marketing efficiency ratio).",
  cpa_delivered: "Ad spend ÷ delivered shipments.",
  contribution_margin: "Net sales − COGS − ads − delivery, return and payment fees.",
  net_profit_to_date: "Engine estimate on ledger data so far. Not final until the period closes and finalizes.",
  distributable_cash: "max(0, bank and cash − reinvestment fund − reserve). The reserve is shown line by line on the period statement.",
} as const;

export const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);
export const pctString = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(1)}%`);
export const safeDiv = (a: Minor, b: number): Minor => (b === 0 ? 0 : Math.round(a / b));

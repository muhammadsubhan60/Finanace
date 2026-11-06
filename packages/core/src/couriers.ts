import type { AgreementProfile, NormalizedStatus } from "@delta/config-schema";
import { TERMINAL_STATUSES } from "@delta/config-schema";
import { daysBetween } from "./dates";
import type { Minor } from "./money";

export function normalizeStatus(profile: AgreementProfile, provider: string, providerStatus: string): { status: NormalizedStatus; mapped: boolean } {
  const key = providerStatus.trim().toLowerCase();
  const s = profile.statusMappings[provider]?.[key];
  return s ? { status: s, mapped: true } : { status: "unknown", mapped: false };
}

export const isTerminal = (s: NormalizedStatus) => TERMINAL_STATUSES.includes(s);

// ---------- Matching (courier-first) ----------

export interface MatchShipment {
  cn: string;
  orderRef?: string | null;
  phone?: string | null;
  city?: string | null;
  codMinor: Minor;
  bookedDate: string; // YYYY-MM-DD
}
export interface MatchOrder {
  id: string;
  name: string; // "#1042"
  trackingNumbers: string[];
  phone?: string | null;
  city?: string | null;
  totalMinor: Minor;
  createdDate: string;
}
export interface MatchResult {
  orderId: string | null;
  strategy: string | null;
  confidence: number;
  candidates: { orderId: string; confidence: number }[];
}

export function normalizePhone(p?: string | null): string | null {
  if (!p) return null;
  let d = p.replace(/\D/g, "");
  if (d.startsWith("0092")) d = d.slice(4);
  else if (d.startsWith("92")) d = d.slice(2);
  else if (d.startsWith("0")) d = d.slice(1);
  return d.length >= 9 ? d.slice(-10) : null;
}
const normCity = (c?: string | null) => (c ? c.trim().toLowerCase().replace(/[^a-z]/g, "") : null);
const normRef = (r: string) => r.trim().replace(/^#/, "").toLowerCase();

export function matchShipment(sh: MatchShipment, orders: MatchOrder[], profile: AgreementProfile): MatchResult {
  for (const st of profile.matching.strategies) {
    if (st.type === "reference_field" && sh.orderRef) {
      const ref = normRef(sh.orderRef);
      // Guard: short refs like "1" must not link to an unrelated old order "#1".
      const hit = orders.filter((o) => normRef(o.name) === ref && Math.abs(daysBetween(o.createdDate, sh.bookedDate)) <= (st.maxDaysApart ?? 30));
      if (hit.length === 1) return { orderId: hit[0]!.id, strategy: st.type, confidence: 1, candidates: [] };
    }
    if (st.type === "shopify_tracking_number") {
      const hit = orders.filter((o) => o.trackingNumbers.some((t) => t.trim() === sh.cn.trim()));
      if (hit.length === 1) return { orderId: hit[0]!.id, strategy: st.type, confidence: 1, candidates: [] };
    }
    if (st.type === "fuzzy") {
      const scored = orders
        .filter((o) => Math.abs(daysBetween(o.createdDate, sh.bookedDate)) <= st.dateWindowDays)
        .map((o) => ({ orderId: o.id, confidence: fuzzyScore(sh, o, st.keys) }))
        .filter((c) => c.confidence > 0)
        .sort((a, b) => b.confidence - a.confidence);
      const [best, second] = scored;
      // Auto-link only when confident AND unambiguous.
      if (best && best.confidence >= st.minConfidence && (!second || second.confidence < best.confidence))
        return { orderId: best.orderId, strategy: st.type, confidence: best.confidence, candidates: scored.slice(0, 5) };
      if (scored.length) return { orderId: null, strategy: "manual_queue", confidence: best!.confidence, candidates: scored.slice(0, 5) };
    }
    if (st.type === "manual_queue") return { orderId: null, strategy: "manual_queue", confidence: 0, candidates: [] };
  }
  return { orderId: null, strategy: null, confidence: 0, candidates: [] };
}

function fuzzyScore(sh: MatchShipment, o: MatchOrder, keys: ("phone" | "cod_amount" | "city")[]): number {
  const weights = { phone: 0.6, cod_amount: 0.3, city: 0.1 } as const;
  let total = 0;
  let got = 0;
  for (const k of keys) {
    total += weights[k];
    if (k === "phone") {
      const a = normalizePhone(sh.phone);
      if (a && a === normalizePhone(o.phone)) got += weights.phone;
    } else if (k === "cod_amount") {
      if (sh.codMinor === o.totalMinor) got += weights.cod_amount;
    } else if (k === "city") {
      const a = normCity(sh.city);
      if (a && a === normCity(o.city)) got += weights.city;
    }
  }
  return Math.round((got / total) * 100) / 100;
}

// ---------- Settlement matching ----------

export interface SettlementLineIn {
  lineKey: string;
  cn: string;
  codMinor: Minor;
  freightMinor: Minor;
  codFeeMinor: Minor;
  returnFeeMinor: Minor;
}
export interface KnownShipment {
  id: string;
  cn: string;
  codAmountMinor: Minor;
  normalizedStatus: NormalizedStatus;
  settlementId?: string | null;
}
export type LineFlag = "ok" | "amount_differs" | "cn_unknown" | "already_settled" | "not_delivered" | "duplicate_in_file";

export function matchSettlementLines(lines: SettlementLineIn[], shipments: KnownShipment[]) {
  const byCn = new Map(shipments.map((s) => [s.cn.trim().toUpperCase(), s]));
  const seen = new Set<string>();
  return lines.map((l) => {
    const cn = l.cn.trim().toUpperCase();
    const sh = byCn.get(cn);
    let flag: LineFlag = "ok";
    if (seen.has(cn)) flag = "duplicate_in_file";
    else if (!sh) flag = "cn_unknown";
    else if (sh.settlementId) flag = "already_settled";
    else if (l.codMinor > 0 && sh.normalizedStatus !== "delivered") flag = "not_delivered";
    else if (l.codMinor === 0 && sh.normalizedStatus === "returned_to_origin") flag = "ok"; // return: charges only
    else if (sh.codAmountMinor !== l.codMinor) flag = "amount_differs";
    seen.add(cn);
    return { ...l, shipmentId: sh?.id ?? null, expectedCodMinor: sh?.codAmountMinor ?? null, flag };
  });
}

export function agingBucket(days: number, buckets: number[]): string {
  let lo = 0;
  for (const b of buckets) {
    if (days <= b) return `${lo}–${b}`;
    lo = b + 1;
  }
  return `${buckets[buckets.length - 1]}+`;
}

/** Units in a parcel from its COD under a single-price catalogue (min 1: prepaid/0-COD parcels still carry one unit). */
export const unitsOf = (codMinor: Minor, unitPriceMinor: Minor) => Math.max(1, Math.round(codMinor / unitPriceMinor));

/** COGS for a shipment: exact when matched to an order with known costs, else store fallback ratio, flagged estimated. */
export function shipmentCogs(args: { codMinor: Minor; exactCogsMinor?: Minor | null; storeId?: string | null }, profile: AgreementProfile): { cogsMinor: Minor; estimated: boolean } {
  if (args.exactCogsMinor != null) return { cogsMinor: args.exactCogsMinor, estimated: false };
  const fb = profile.matching.fallbackCogs;
  if (fb?.mode === "per_unit" && fb.unitPriceMinor && fb.unitCostMinor != null) return { cogsMinor: unitsOf(args.codMinor, fb.unitPriceMinor) * fb.unitCostMinor, estimated: true };
  const ratios = profile.matching.fallbackCogsRatioBps;
  const bps = (args.storeId ? ratios[args.storeId] : undefined) ?? ratios["*"] ?? 0;
  return { cogsMinor: Math.round((args.codMinor * bps) / 10_000), estimated: true };
}

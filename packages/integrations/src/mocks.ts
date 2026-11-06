import type { AdInsightRow, CourierAdapter, MetaAdsAdapter, ShipmentSnapshot, ShopifyAdapter, ShopifyOrderIn } from "./types";

/** Deterministic PRNG so fixtures are stable across runs. */
function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const STATUS_FLOW: Record<string, string[]> = {
  leopards: ["Consignment Booked", "Arrived at Station", "Dispatched", "Assigned to Courier", "Delivered"],
  trax: ["Booked", "Picked Up", "In Transit", "Out For Delivery", "Delivered"],
  tcs: ["Booked", "Arrival", "Departed", "Out For Delivery", "Delivered"],
};
const RTO: Record<string, string[]> = { leopards: ["Being Return", "Returned to Shipper"], trax: ["Return In Process", "Returned"], tcs: ["Return to Origin"] };

/** Mock courier: status progresses with time since booking; ~15% RTO. */
export class MockCourierAdapter implements CourierAdapter {
  constructor(public provider: "leopards" | "trax" | "tcs", private bookedAt: (cn: string) => Date | undefined = () => undefined) {}
  async testConnection() {
    return { ok: true as const, message: "Mock adapter" };
  }
  async fetchTracking(cn: string): Promise<ShipmentSnapshot> {
    const r = rng(cn);
    const booked = this.bookedAt(cn) ?? new Date(Date.now() - Math.floor(r() * 10) * 86_400_000);
    const days = Math.floor((Date.now() - booked.getTime()) / 86_400_000);
    const rto = r() < 0.15;
    const flow = rto ? [...STATUS_FLOW[this.provider]!.slice(0, 3), ...RTO[this.provider]!] : STATUS_FLOW[this.provider]!;
    const step = Math.min(flow.length - 1, Math.floor(days / 1.2));
    const events = flow.slice(0, step + 1).map((s, i) => ({ providerStatus: s, at: new Date(booked.getTime() + i * 1.2 * 86_400_000).toISOString() }));
    return { cn, providerStatus: flow[step]!, events };
  }
  async fetchTrackingBatch(cns: string[]) {
    return Promise.all(cns.map((c) => this.fetchTracking(c)));
  }
}

const CITIES = ["Lahore", "Karachi", "Islamabad", "Rawalpindi", "Faisalabad", "Multan", "Peshawar"];
const PRODUCTS = [
  { sku: "TSH-01", title: "Cotton T-Shirt", priceMinor: 199_900, unitCostMinor: 70_000 },
  { sku: "HOD-02", title: "Fleece Hoodie", priceMinor: 449_900, unitCostMinor: 180_000 },
  { sku: "CAP-03", title: "Baseball Cap", priceMinor: 99_900, unitCostMinor: 30_000 },
  { sku: "JNS-04", title: "Denim Jeans", priceMinor: 349_900, unitCostMinor: 140_000 },
];

export function mockOrders(storeId: string, from: Date, days: number, perDay = 6): ShopifyOrderIn[] {
  const r = rng(storeId);
  const out: ShopifyOrderIn[] = [];
  let n = storeId.length * 1000 + 1000;
  for (let d = 0; d < days; d++) {
    const count = Math.max(1, Math.round(perDay * (0.6 + r() * 0.8)));
    for (let k = 0; k < count; k++) {
      const created = new Date(from.getTime() + d * 86_400_000 + Math.floor(r() * 12) * 3_600_000);
      const items = [PRODUCTS[Math.floor(r() * PRODUCTS.length)]!].map((p) => ({ ...p, quantity: r() < 0.2 ? 2 : 1 }));
      const subtotal = items.reduce((s, i) => s + i.priceMinor * i.quantity, 0);
      const discount = r() < 0.2 ? Math.round(subtotal * 0.1 / 100) * 100 : 0;
      const shipping = 20_000;
      const phone = `03${Math.floor(r() * 5)}${String(Math.floor(r() * 1e8)).padStart(8, "0")}`;
      out.push({
        externalId: `${storeId}-${n}`,
        name: `#${n++}`,
        createdAt: created.toISOString(),
        updatedAt: created.toISOString(),
        cancelledAt: r() < 0.03 ? created.toISOString() : null,
        financialStatus: "pending",
        paymentMethod: r() < 0.9 ? "cod" : "prepaid",
        totalMinor: subtotal - discount + shipping,
        subtotalMinor: subtotal,
        discountsMinor: discount,
        taxesMinor: 0,
        shippingMinor: shipping,
        customer: { name: `Customer ${n}`, phone, city: CITIES[Math.floor(r() * CITIES.length)] },
        lineItems: items,
        trackingNumbers: [],
        refunds: [],
      });
    }
  }
  return out;
}

export class MockShopifyAdapter implements ShopifyAdapter {
  constructor(private storeId: string) {}
  async testConnection() {
    return { ok: true as const, message: "Mock store" };
  }
  async fetchOrdersUpdatedSince(sinceIso: string) {
    const from = new Date(Math.max(Date.parse(sinceIso), Date.now() - 45 * 86_400_000));
    const days = Math.max(0, Math.ceil((Date.now() - from.getTime()) / 86_400_000));
    return { orders: mockOrders(this.storeId, new Date(from.toISOString().slice(0, 10)), days), nextCursor: null };
  }
}

export class MockMetaAdapter implements MetaAdsAdapter {
  async testConnection() {
    return { ok: true as const, message: "Mock ad account" };
  }
  async fetchDailyInsights(adAccountId: string, from: string, to: string): Promise<AdInsightRow[]> {
    const out: AdInsightRow[] = [];
    for (let d = Date.parse(from); d <= Date.parse(to); d += 86_400_000) {
      const date = new Date(d).toISOString().slice(0, 10);
      for (const c of ["c-prospecting", "c-retargeting", "c-other-division"]) {
        const r = rng(adAccountId + date + c);
        const spend = Math.round((c === "c-prospecting" ? 8000 : c === "c-retargeting" ? 3000 : 2000) * (0.7 + r() * 0.6)) * 100;
        out.push({ date, campaignId: c, campaignName: c.replace("c-", "").replace("-", " "), spendMinor: spend, impressions: Math.round(spend / 30), clicks: Math.round(spend / 2500), purchases: Math.round(spend / 120000), revenueMinor: Math.round(spend * (2 + r() * 2)), currency: "PKR" });
      }
    }
    return out;
  }
}

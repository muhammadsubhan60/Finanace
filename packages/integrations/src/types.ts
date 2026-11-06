export type Result = { ok: true; message?: string } | { ok: false; error: string };

export interface ShipmentEventIn {
  providerStatus: string;
  at: string; // ISO
  location?: string;
  raw?: unknown;
}
export interface ShipmentSnapshot {
  cn: string;
  providerStatus: string;
  events: ShipmentEventIn[];
  codMinor?: number;
  orderRef?: string | null;
  consignee?: { name?: string; phone?: string; city?: string };
  bookedAt?: string;
  charges?: { freightMinor?: number; codFeeMinor?: number; returnFeeMinor?: number };
  raw?: unknown;
}
export interface SettlementIn {
  reference: string;
  date: string;
  lines: { cn: string; codMinor: number; freightMinor: number; codFeeMinor: number; returnFeeMinor: number }[];
  netReceivedMinor: number;
}

export interface CourierAdapter {
  provider: "leopards" | "trax" | "tcs";
  testConnection(): Promise<Result>;
  fetchTracking(cn: string): Promise<ShipmentSnapshot>;
  fetchTrackingBatch?(cns: string[]): Promise<ShipmentSnapshot[]>;
  /** [OPEN] only if provider can list booked packets by date range. */
  listBookings?(range: { from: string; to: string }): Promise<ShipmentSnapshot[]>;
  handleWebhook?(body: unknown, headers: Record<string, string>): Promise<ShipmentSnapshot[]>;
  fetchSettlements?(range: { from: string; to: string }): Promise<SettlementIn[]>;
}

export interface ShopifyOrderIn {
  externalId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string | null;
  financialStatus: string;
  paymentMethod: "cod" | "prepaid";
  totalMinor: number;
  subtotalMinor: number;
  discountsMinor: number;
  taxesMinor: number;
  shippingMinor: number;
  customer: { name?: string; phone?: string; city?: string };
  lineItems: { sku?: string; title: string; quantity: number; priceMinor: number; unitCostMinor?: number | null }[];
  trackingNumbers: string[];
  refunds: { externalId: string; createdAt: string; amountMinor: number }[];
  raw?: unknown;
}
export interface ShopifyAdapter {
  testConnection(): Promise<Result>;
  fetchOrdersUpdatedSince(sinceIso: string, cursor?: string | null): Promise<{ orders: ShopifyOrderIn[]; nextCursor: string | null }>;
  verifyWebhook?(rawBody: string, hmacHeader: string): boolean;
}

export interface AdInsightRow {
  date: string;
  campaignId: string;
  campaignName: string;
  spendMinor: number;
  impressions: number;
  clicks: number;
  purchases: number;
  revenueMinor: number;
  currency: string;
}
export interface MetaAdsAdapter {
  testConnection(): Promise<Result>;
  fetchDailyInsights(adAccountId: string, from: string, to: string): Promise<AdInsightRow[]>;
}

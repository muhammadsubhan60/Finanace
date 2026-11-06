import { createHmac, timingSafeEqual } from "node:crypto";
import type { ShopifyAdapter, ShopifyOrderIn } from "./types";
import { CircuitBreaker, httpJson, rupeesToMinor } from "./http";

/** Shopify Admin GraphQL (custom app per store). API version is pinned in integration config. */
export interface ShopifyCredentials {
  shopDomain: string; // mystore.myshopify.com
  accessToken: string;
  apiVersion: string; // e.g. "2026-10" — verify at deploy time
  webhookSecret?: string;
}

const ORDERS_QUERY = `query($q: String!, $after: String) {
  orders(first: 100, after: $after, query: $q, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt updatedAt cancelledAt displayFinancialStatus paymentGatewayNames
      totalPriceSet { shopMoney { amount } } subtotalPriceSet { shopMoney { amount } }
      totalDiscountsSet { shopMoney { amount } } totalTaxSet { shopMoney { amount } } totalShippingPriceSet { shopMoney { amount } }
      shippingAddress { name phone city }
      lineItems(first: 50) { nodes { sku title quantity originalUnitPriceSet { shopMoney { amount } } variant { inventoryItem { unitCost { amount } } } } }
      fulfillments { trackingInfo { number } }
      refunds { id createdAt totalRefundedSet { shopMoney { amount } } }
    }
  }
}`;

type M = { shopMoney: { amount: string } } | null;
const amt = (m: M) => rupeesToMinor(m?.shopMoney.amount ?? "0");

export class ShopifyGraphqlAdapter implements ShopifyAdapter {
  private breaker = new CircuitBreaker();
  constructor(private c: ShopifyCredentials) {}

  private gql<T>(query: string, variables: Record<string, unknown>) {
    return this.breaker.run(() =>
      httpJson<{ data: T; errors?: { message: string }[] }>(`https://${this.c.shopDomain}/admin/api/${this.c.apiVersion}/graphql.json`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Shopify-Access-Token": this.c.accessToken },
        body: JSON.stringify({ query, variables }),
      }).then((r) => {
        if (r.errors?.length) throw new Error(r.errors.map((e) => e.message).join("; "));
        return r.data;
      }),
    );
  }

  async testConnection() {
    try {
      const d = await this.gql<{ shop: { name: string } }>("{ shop { name } }", {});
      return { ok: true as const, message: d.shop.name };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }

  async fetchOrdersUpdatedSince(sinceIso: string, cursor?: string | null) {
    type N = {
      id: string; name: string; createdAt: string; updatedAt: string; cancelledAt: string | null; displayFinancialStatus: string; paymentGatewayNames: string[];
      totalPriceSet: M; subtotalPriceSet: M; totalDiscountsSet: M; totalTaxSet: M; totalShippingPriceSet: M;
      shippingAddress: { name?: string; phone?: string; city?: string } | null;
      lineItems: { nodes: { sku: string | null; title: string; quantity: number; originalUnitPriceSet: M; variant: { inventoryItem: { unitCost: { amount: string } | null } } | null }[] };
      fulfillments: { trackingInfo: { number: string }[] }[];
      refunds: { id: string; createdAt: string; totalRefundedSet: M }[];
    };
    const d = await this.gql<{ orders: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: N[] } }>(ORDERS_QUERY, { q: `updated_at:>='${sinceIso}'`, after: cursor ?? null });
    const orders: ShopifyOrderIn[] = d.orders.nodes.map((o) => ({
      externalId: o.id,
      name: o.name,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      cancelledAt: o.cancelledAt,
      financialStatus: o.displayFinancialStatus,
      paymentMethod: o.paymentGatewayNames.some((g) => /cash on delivery|cod/i.test(g)) ? "cod" : "prepaid",
      totalMinor: amt(o.totalPriceSet),
      subtotalMinor: amt(o.subtotalPriceSet),
      discountsMinor: amt(o.totalDiscountsSet),
      taxesMinor: amt(o.totalTaxSet),
      shippingMinor: amt(o.totalShippingPriceSet),
      customer: { name: o.shippingAddress?.name, phone: o.shippingAddress?.phone, city: o.shippingAddress?.city },
      lineItems: o.lineItems.nodes.map((l) => ({ sku: l.sku ?? undefined, title: l.title, quantity: l.quantity, priceMinor: amt(l.originalUnitPriceSet), unitCostMinor: l.variant?.inventoryItem.unitCost ? rupeesToMinor(l.variant.inventoryItem.unitCost.amount) : null })),
      trackingNumbers: o.fulfillments.flatMap((f) => f.trackingInfo.map((t) => t.number)),
      refunds: o.refunds.map((r) => ({ externalId: r.id, createdAt: r.createdAt, amountMinor: amt(r.totalRefundedSet) })),
    }));
    return { orders, nextCursor: d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null };
  }

  verifyWebhook(rawBody: string, hmacHeader: string) {
    if (!this.c.webhookSecret) return false;
    const digest = createHmac("sha256", this.c.webhookSecret).update(rawBody, "utf8").digest();
    const given = Buffer.from(hmacHeader, "base64");
    return given.length === digest.length && timingSafeEqual(given, digest);
  }
}

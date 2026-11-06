export * from "./types";
export * from "./http";
export * from "./mocks";
export * from "./crypto";
export { LeopardsAdapter, LEOPARDS_PUSH_CODES, type LeopardsCredentials } from "./couriers/leopards";
export { TcsAdapter, chunkRange, type TcsCredentials } from "./couriers/tcs";
export { ShopifyGraphqlAdapter, type ShopifyCredentials } from "./shopify";
export { MetaGraphAdapter, type MetaCredentials } from "./meta";

import type { CourierAdapter, MetaAdsAdapter, ShopifyAdapter } from "./types";
import { MockCourierAdapter, MockMetaAdapter, MockShopifyAdapter } from "./mocks";
import { LeopardsAdapter } from "./couriers/leopards";
import { TcsAdapter } from "./couriers/tcs";
import { ShopifyGraphqlAdapter } from "./shopify";
import { MetaGraphAdapter } from "./meta";

/** Factory: the rest of the app only gets adapters from here. `mode: "mock"` works without credentials. */
export function courierAdapter(provider: "leopards" | "trax" | "tcs", mode: "live" | "mock", creds?: Record<string, string>, bookedAt?: (cn: string) => Date | undefined): CourierAdapter {
  if (mode === "live" && provider === "leopards" && creds) return new LeopardsAdapter({ apiKey: creds.apiKey!, apiPassword: creds.apiPassword!, baseUrl: creds.baseUrl, webhookSecret: creds.webhookSecret });
  if (mode === "live" && provider === "tcs" && creds) return new TcsAdapter({ bearerToken: creds.bearerToken, clientId: creds.clientId, clientSecret: creds.clientSecret, username: creds.username!, password: creds.password!, customerNo: creds.customerNo, baseUrl: creds.baseUrl });
  // Trax: mock + CSV until credentials and docs exist (OPEN_QUESTIONS #2).
  return new MockCourierAdapter(provider, bookedAt);
}
export function shopifyAdapter(storeId: string, mode: "live" | "mock", creds?: Record<string, string>): ShopifyAdapter {
  if (mode === "live" && creds) return new ShopifyGraphqlAdapter({ shopDomain: creds.shopDomain!, accessToken: creds.accessToken!, apiVersion: creds.apiVersion ?? "2026-10", webhookSecret: creds.webhookSecret });
  return new MockShopifyAdapter(storeId);
}
export function metaAdapter(mode: "live" | "mock", creds?: Record<string, string>): MetaAdsAdapter {
  if (mode === "live" && creds) return new MetaGraphAdapter({ accessToken: creds.accessToken!, apiVersion: creds.apiVersion ?? "v24.0" });
  return new MockMetaAdapter();
}

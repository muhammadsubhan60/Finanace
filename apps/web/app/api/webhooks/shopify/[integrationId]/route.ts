import { decryptJson, ShopifyGraphqlAdapter } from "@delta/integrations";
import { enqueueJob, getDb, systemCtx } from "@delta/db";

/** Shopify webhooks: verify HMAC, store + enqueue, respond fast. The worker does the incremental sync. */
export async function POST(req: Request, { params }: { params: Promise<{ integrationId: string }> }) {
  const { integrationId } = await params;
  const raw = await req.text();
  const db = await getDb();
  const i = await db.collection("integrations").findOne({ _id: integrationId as never, type: "shopify" });
  if (!i?.credentialsEnc) return new Response("Unknown", { status: 404 });
  const c = decryptJson(i.credentialsEnc);
  const ok = new ShopifyGraphqlAdapter({ shopDomain: c.shopDomain!, accessToken: c.accessToken!, apiVersion: c.apiVersion ?? "2026-10", webhookSecret: c.webhookSecret }).verifyWebhook(raw, req.headers.get("x-shopify-hmac-sha256") ?? "");
  if (!ok) return new Response("Invalid signature", { status: 401 });
  await db.collection("webhook_events").insertOne({ integrationId, topic: req.headers.get("x-shopify-topic"), webhookId: req.headers.get("x-shopify-webhook-id"), receivedAt: new Date(), body: raw.slice(0, 200_000) });
  await enqueueJob(systemCtx("shopify-webhook"), "sync", { integrationId });
  return new Response("ok");
}

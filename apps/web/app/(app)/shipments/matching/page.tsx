import { getDb, ORG_ID } from "@delta/db";
import { Badge, Card, CardHeader, Empty, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { requireUser } from "@/lib/session";
import { day, pkr } from "@/lib/utils";
import { link, rematch } from "../actions";

export const metadata = { title: "Matching queue" };

export default async function Matching() {
  await requireUser("shipments:manage");
  const db = await getDb();
  const queue = await db.collection("shipments").find({ orgId: ORG_ID, orderId: null }).sort({ bookedAt: -1 }).limit(50).toArray();
  const candIds = [...new Set(queue.flatMap((s) => (s.matchCandidates ?? []).map((c: { orderId: string }) => c.orderId)))];
  const orders = new Map((await db.collection("orders").find({ _id: { $in: candIds as never[] } }).toArray()).map((o) => [String(o._id), o]));
  const total = await db.collection("shipments").countDocuments({ orgId: ORG_ID, orderId: null });

  return (
    <>
      <PageHeader
        title="Matching queue"
        description="Shipments that no strategy matched confidently. Unmatched shipments still count for COD, delivery and settlement; only COGS is estimated until linked."
        actions={<ActionForm action={async () => { "use server"; return rematch(null); }}><Submit variant="outline" size="sm">Re-run matching</Submit></ActionForm>}
      />
      {total === 0 ? <Card><Empty title="Everything is matched">New bookings are matched automatically by reference, tracking number, then phone + amount + city.</Empty></Card> : null}
      <div className="grid gap-3">
        {queue.map((s) => (
          <Card key={String(s._id)}>
            <CardHeader
              title={<span className="font-mono">{s.cn}</span>}
              description={`${day(s.bookedAt)} · ${s.consignee?.name ?? "—"} · ${s.consignee?.city ?? "—"} · COD ${pkr(s.codAmountMinor)}${s.orderRef ? ` · ref "${s.orderRef}"` : " · no reference"}`}
            />
            <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3 sm:p-5">
              {(s.matchCandidates ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No candidate orders in the date window. Check that the store is synced.</p> : null}
              {(s.matchCandidates ?? []).map((c: { orderId: string; confidence: number }) => {
                const o = orders.get(c.orderId);
                if (!o) return null;
                return (
                  <div key={c.orderId} className="rounded-md border p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-sm font-medium">{o.name}</span>
                      <Badge tone={c.confidence >= 0.9 ? "positive" : c.confidence >= 0.6 ? "warning" : "neutral"}>{Math.round(c.confidence * 100)}% match</Badge>
                    </div>
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px]">
                      <dt className="text-muted-foreground">Date</dt><dd>{day(o.createdAt)}</dd>
                      <dt className="text-muted-foreground">Customer</dt><dd>{o.customer?.name}, {o.customer?.city}</dd>
                      <dt className="text-muted-foreground">Total</dt><dd className={o.totalMinor === s.codAmountMinor ? "text-positive" : ""}>{pkr(o.totalMinor)}</dd>
                    </dl>
                    <ActionForm action={link} className="mt-2">
                      <input type="hidden" name="shipmentId" value={String(s._id)} />
                      <input type="hidden" name="orderId" value={c.orderId} />
                      <Submit size="xs" variant="outline">Link to {o.name}</Submit>
                    </ActionForm>
                  </div>
                );
              })}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

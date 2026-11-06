import Link from "next/link";
import { getDb, ORG_ID } from "@delta/db";
import { karachiStartOfDayUtc, addDays } from "@delta/core";
import { Card, Empty, PageHeader, Pagination, StatusBadge, Table, Td, Th, Badge } from "@/components/ui";
import { FilterBar, FInput, FSelect } from "@/components/filters";
import { has, requireUser } from "@/lib/session";
import { day, maskPhone, pkr, qs } from "@/lib/utils";

export const metadata = { title: "Orders" };
const PAGE = 50;

export default async function Orders({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const u = await requireUser("orders:view");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1));
  const db = await getDb();
  const q: Record<string, unknown> = { orgId: ORG_ID };
  if (sp.store) q.storeId = sp.store;
  if (sp.q) q.$or = [{ name: { $regex: escape(sp.q), $options: "i" } }, { "customer.phone": { $regex: escape(sp.q.replace(/\D/g, "").slice(-7) || "^$") } }];
  if (sp.from || sp.to) q.createdAt = { ...(sp.from ? { $gte: karachiStartOfDayUtc(sp.from) } : {}), ...(sp.to ? { $lt: karachiStartOfDayUtc(addDays(sp.to, 1)) } : {}) };
  if (sp.status) q.status = sp.status;
  const [rows, total, stores] = await Promise.all([
    db.collection("orders").find(q).sort({ createdAt: -1 }).skip((page - 1) * PAGE).limit(PAGE).toArray(),
    db.collection("orders").countDocuments(q),
    db.collection("stores").find({ orgId: ORG_ID }).toArray(),
  ]);
  const ids = rows.map((r) => String(r._id));
  const ships = await db.collection("shipments").find({ orgId: ORG_ID, orderId: { $in: ids } }, { projection: { orderId: 1, cn: 1, normalizedStatus: 1 } }).toArray();
  const byOrder = new Map(ships.map((s) => [s.orderId, s]));
  const storeName = new Map(stores.map((s) => [String(s._id), s.name]));
  const fullPii = has(u, "pii:full");
  return (
    <>
      <PageHeader title="Orders" description="Normalized Shopify orders across all stores. In courier-first mode they enrich shipments with product, cost and discount detail." />
      <FilterBar>
        <FInput name="q" label="Order # or phone" value={sp.q} placeholder="#1042" />
        <FSelect name="store" label="Store" value={sp.store} options={stores.map((s) => ({ value: String(s._id), label: s.name }))} />
        <FSelect name="status" label="Status" value={sp.status} options={[{ value: "open", label: "Open" }, { value: "cancelled", label: "Cancelled" }]} />
        <FInput name="from" label="From" type="date" value={sp.from} />
        <FInput name="to" label="To" type="date" value={sp.to} />
      </FilterBar>
      <Card>
        <Table>
          <thead>
            <tr><Th>Order</Th><Th>Date</Th><Th>Store</Th><Th>Customer</Th><Th>City</Th><Th>Payment</Th><Th align="right">Total</Th><Th>Shipment</Th></tr>
          </thead>
          <tbody>
            {rows.map((o) => {
              const s = byOrder.get(String(o._id));
              return (
                <tr key={String(o._id)} className="hover:bg-muted/40">
                  <Td mono>{o.name}</Td>
                  <Td>{day(o.createdAt)}</Td>
                  <Td>{storeName.get(o.storeId) ?? o.storeId}</Td>
                  <Td>{o.customer?.name ?? "—"}<div className="text-xs text-muted-foreground">{fullPii ? o.customer?.phone : maskPhone(o.customer?.phone)}</div></Td>
                  <Td>{o.customer?.city ?? "—"}</Td>
                  <Td>{o.status === "cancelled" ? <StatusBadge status="cancelled" /> : <Badge>{o.paymentMethod.toUpperCase()}</Badge>}</Td>
                  <Td align="right">{pkr(o.totalMinor)}</Td>
                  <Td>{s ? <Link href={`/shipments?q=${s.cn}`} className="font-mono text-[13px] text-primary hover:underline">{s.cn}</Link> : <span className="text-xs text-muted-foreground">Not shipped / unmatched</span>}{s ? <div><StatusBadge status={s.normalizedStatus} /></div> : null}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        {rows.length === 0 ? <Empty title="No orders match these filters" /> : null}
        <Pagination page={page} pageSize={PAGE} total={total} hrefFor={(p) => qs(sp, { page: String(p) })} />
      </Card>
    </>
  );
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

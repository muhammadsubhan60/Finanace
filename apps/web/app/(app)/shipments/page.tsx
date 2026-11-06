import Link from "next/link";
import { getDb, ORG_ID } from "@delta/db";
import { NORMALIZED_STATUSES } from "@delta/config-schema";
import { addDays, karachiStartOfDayUtc } from "@delta/core";
import { Badge, Card, CardBody, CardHeader, Empty, Field, Input, LinkButton, Notice, PageHeader, Pagination, Select, StatusBadge, Table, Td, Textarea, Th } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { FilterBar, FInput, FSelect } from "@/components/filters";
import { has, requireUser } from "@/lib/session";
import { day, maskPhone, pkr, qs } from "@/lib/utils";
import { addOne, cancelCns, pasteCns, uploadBookings } from "./actions";

export const metadata = { title: "Shipments" };
const PAGE = 50;

export default async function Shipments({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const u = await requireUser("shipments:view");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1));
  const db = await getDb();
  const q: Record<string, unknown> = { orgId: ORG_ID };
  if (sp.status) q.normalizedStatus = sp.status;
  if (sp.courier) q.courierId = sp.courier;
  if (sp.store) q.storeId = sp.store;
  if (sp.matched === "no") q.orderId = null;
  if (sp.q) q.$or = [{ cn: sp.q.trim().toUpperCase() }, { orderRef: { $regex: sp.q.replace(/[^\w#-]/g, ""), $options: "i" } }];
  if (sp.from || sp.to) q.bookedAt = { ...(sp.from ? { $gte: karachiStartOfDayUtc(sp.from) } : {}), ...(sp.to ? { $lt: karachiStartOfDayUtc(addDays(sp.to, 1)) } : {}) };
  const [rows, total, couriers, stores, unmapped] = await Promise.all([
    db.collection("shipments").find(q).sort({ bookedAt: -1 }).skip((page - 1) * PAGE).limit(PAGE).toArray(),
    db.collection("shipments").countDocuments(q),
    db.collection("couriers").find({ orgId: ORG_ID }).toArray(),
    db.collection("stores").find({ orgId: ORG_ID }).toArray(),
    db.collection("unmapped_statuses").countDocuments({ orgId: ORG_ID, resolved: { $ne: true } }),
  ]);
  const cName = new Map(couriers.map((c) => [String(c._id), c.label]));
  const manage = has(u, "shipments:manage");
  const pii = has(u, "pii:full");
  const courierOpts = couriers.map((c) => <option key={String(c._id)} value={String(c._id)}>{c.label}</option>);

  return (
    <>
      <PageHeader
        title="Shipments"
        description="Courier bookings are the source of truth for shipments, COD amounts and delivery status (courier-first)."
        actions={manage ? <LinkButton href="/shipments/matching" variant="outline" size="sm">Matching queue</LinkButton> : null}
      />
      <Notice>
        <strong>Tip:</strong> put the Shopify order number (e.g. <span className="font-mono">#1042</span>) in the booking&apos;s reference / order-id field in the courier portal. It removes almost all manual matching.
      </Notice>
      {unmapped ? <div className="mt-2"><Notice tone="warning">{unmapped} courier status strings are not mapped yet. <Link className="underline" href="/configuration/status-mappings">Map them</Link> — until then those shipments keep their last known status.</Notice></div> : null}

      {manage ? (
        <details className="group mt-4 rounded-lg border bg-card">
          <summary className="flex items-center justify-between px-4 py-3 text-sm font-semibold sm:px-5">Add shipments <span className="text-xs font-normal text-muted-foreground">CSV booking list · paste CNs · single CN</span></summary>
          <div className="grid gap-4 border-t p-4 sm:p-5 lg:grid-cols-3">
            <ActionForm action={uploadBookings} className="grid gap-3">
              <h3 className="text-sm font-medium">Import booking list (CSV)</h3>
              <Field label="Courier" htmlFor="b-courier"><Select id="b-courier" name="courierId">{courierOpts}</Select></Field>
              <Field label="File" htmlFor="b-file" hint="Downloaded from the courier portal. You confirm the column mapping next."><Input id="b-file" name="file" type="file" accept=".csv,text/csv" required className="py-1.5" /></Field>
              <Submit variant="outline">Upload and preview</Submit>
            </ActionForm>
            <ActionForm action={pasteCns} className="grid gap-3" resetOnSuccess>
              <h3 className="text-sm font-medium">Bulk paste CN numbers</h3>
              <Field label="Courier" htmlFor="p-courier"><Select id="p-courier" name="courierId">{courierOpts}</Select></Field>
              <Field label="CN numbers" htmlFor="p-cns" hint="One per line or comma separated"><Textarea id="p-cns" name="cns" rows={4} required /></Field>
              <Submit variant="outline">Start tracking</Submit>
            </ActionForm>
            <ActionForm action={cancelCns} className="grid gap-3 lg:col-span-3 lg:grid-cols-[1fr_1fr_auto] lg:items-end border-t pt-4" resetOnSuccess>
              <Field label="Mark as cancelled (never shipped)" htmlFor="c-cns" hint="Only booked / picked-up CNs are changed. Stops tracking and removes them from COD in transit."><Textarea id="c-cns" name="cns" rows={2} required /></Field>
              <Field label="Reason" htmlFor="c-reason"><Input id="c-reason" name="reason" defaultValue="Never shipped — booking wasted" required /></Field>
              <Submit variant="outline">Mark cancelled</Submit>
            </ActionForm>
            <ActionForm action={addOne} className="grid gap-3" resetOnSuccess>
              <h3 className="text-sm font-medium">Add a single CN</h3>
              <Field label="Courier" htmlFor="s-courier"><Select id="s-courier" name="courierId">{courierOpts}</Select></Field>
              <Field label="CN" htmlFor="s-cn"><Input id="s-cn" name="cn" required /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Order ref" htmlFor="s-ref"><Input id="s-ref" name="orderRef" placeholder="#1042" /></Field>
                <Field label="COD (PKR)" htmlFor="s-cod"><Input id="s-cod" name="cod" inputMode="decimal" /></Field>
              </div>
              <Submit variant="outline">Add</Submit>
            </ActionForm>
          </div>
        </details>
      ) : null}

      <div className="mt-4">
        <FilterBar>
          <FInput name="q" label="CN or order ref" value={sp.q} />
          <FSelect name="status" label="Status" value={sp.status} options={NORMALIZED_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ") }))} />
          <FSelect name="courier" label="Courier" value={sp.courier} options={couriers.map((c) => ({ value: String(c._id), label: c.label }))} />
          <FSelect name="store" label="Store" value={sp.store} options={stores.map((s) => ({ value: String(s._id), label: s.name }))} />
          <FSelect name="matched" label="Matched" value={sp.matched} options={[{ value: "no", label: "Unmatched only" }]} />
          <FInput name="from" label="Booked from" type="date" value={sp.from} />
          <FInput name="to" label="Booked to" type="date" value={sp.to} />
        </FilterBar>
      </div>
      <Card>
        <CardHeader title={`${total.toLocaleString()} shipments`} />
        <Table>
          <thead>
            <tr><Th>CN</Th><Th>Courier</Th><Th>Booked</Th><Th>Consignee</Th><Th>Status</Th><Th align="right">COD</Th><Th>Order</Th><Th>Settlement</Th></tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={String(s._id)} className="hover:bg-muted/40">
                <Td mono>{s.cn}</Td>
                <Td>{cName.get(s.courierId) ?? s.provider}</Td>
                <Td>{day(s.bookedAt)}</Td>
                <Td>{s.consignee?.name ?? "—"}<div className="text-xs text-muted-foreground">{s.consignee?.city ?? ""} {pii ? s.consignee?.phone : maskPhone(s.consignee?.phone)}</div></Td>
                <Td><StatusBadge status={s.normalizedStatus} /><div className="mt-0.5 text-xs text-muted-foreground">{s.providerStatus}</div></Td>
                <Td align="right">{pkr(s.codAmountMinor)}{s.amountMismatchMinor ? <div className="text-xs text-warning">Δ {pkr(s.amountMismatchMinor)} vs Shopify</div> : null}</Td>
                <Td>{s.orderId ? <span className="text-[13px]">{s.orderRef ?? "linked"} <Badge tone="neutral">{s.matchStrategy}</Badge></span> : <Link href="/shipments/matching" className="text-[13px] text-warning hover:underline">Unmatched{s.cogsEstimated ? " · COGS est." : ""}</Link>}</Td>
                <Td>{s.settlementId ? <Link href={`/cod/settlements/${s.settlementId}`} className="text-[13px] text-primary hover:underline">Settled</Link> : <span className="text-xs text-muted-foreground">—</span>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {rows.length === 0 ? <Empty title="No shipments">Import a booking list, paste CNs, or enable the courier API sync.</Empty> : null}
        <Pagination page={page} pageSize={PAGE} total={total} hrefFor={(p) => qs(sp, { page: String(p) })} />
      </Card>
    </>
  );
}

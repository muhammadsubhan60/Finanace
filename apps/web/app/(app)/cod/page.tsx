import Link from "next/link";
import { agingBucket } from "@delta/core";
import { getCurrentProfile, getDb, ORG_ID } from "@delta/db";
import { Card, CardBody, CardHeader, Empty, Field, Input, PageHeader, Select, StatusBadge, Table, Td, Th } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { has, requireUser } from "@/lib/session";
import { day, pkr } from "@/lib/utils";
import { resolveLine, tcsInvoice, uploadSettlement } from "./actions";

export const metadata = { title: "COD & Settlements" };

export default async function Cod({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const u = await requireUser("profit:view");
  const sp = await searchParams;
  const db = await getDb();
  const profile = await getCurrentProfile();
  const couriers = await db.collection("couriers").find({ orgId: ORG_ID }).toArray();
  const buckets = [...profile.agingBucketsDays.map((b, i, a) => `${i === 0 ? 0 : a[i - 1]! + 1}–${b}`), `${profile.agingBucketsDays.at(-1)}+`];

  const recon = await Promise.all(
    couriers.map(async (c) => {
      const ships = await db.collection("shipments").find({ orgId: ORG_ID, courierId: c._id }, { projection: { normalizedStatus: 1, codAmountMinor: 1, settlementId: 1, deliveredAt: 1 } }).toArray();
      const r = { inTransit: 0, unsettled: 0, settled: 0, rto: 0, aging: Object.fromEntries(buckets.map((b) => [b, 0])) as Record<string, number> };
      for (const s of ships) {
        if (s.normalizedStatus === "returned_to_origin") r.rto += s.codAmountMinor;
        else if (s.settlementId) r.settled += s.codAmountMinor;
        else if (s.normalizedStatus === "delivered") {
          r.unsettled += s.codAmountMinor;
          const d = s.deliveredAt ? Math.floor((Date.now() - s.deliveredAt.getTime()) / 86_400_000) : 0;
          const b = agingBucket(d, profile.agingBucketsDays);
          r.aging[b] = (r.aging[b] ?? 0) + s.codAmountMinor;
        } else if (!["cancelled", "lost_or_damaged"].includes(s.normalizedStatus)) r.inTransit += s.codAmountMinor;
      }
      const disputed = await db.collection("cod_settlement_lines").aggregate<{ t: number }>([{ $match: { orgId: ORG_ID, courierId: c._id, resolved: false } }, { $group: { _id: null, t: { $sum: "$codMinor" } } }]).next();
      return { c, ...r, disputed: disputed?.t ?? 0, n: ships.length };
    }),
  );
  const [settlements, exceptions, tcs] = await Promise.all([
    db.collection("cod_settlements").find({ orgId: ORG_ID, ...(sp.courier ? { courierId: sp.courier } : {}) }).sort({ date: -1 }).limit(30).toArray(),
    db.collection("cod_settlement_lines").find({ orgId: ORG_ID, resolved: false }).limit(100).toArray(),
    db.collection("integrations").findOne({ orgId: ORG_ID, provider: "tcs" }),
  ]);
  const cName = new Map(couriers.map((c) => [String(c._id), c.label]));
  const canImport = has(u, "import:upload");

  return (
    <>
      <PageHeader title="COD & Settlements" description="Courier money position, aging, and remittance reconciliation. Settlement files post exactly once; mismatches wait here." />
      <Card className="mb-4">
        <CardHeader title="Reconciliation by courier" description={`Aging of delivered-but-unsettled COD in days (buckets from the profile: ${profile.agingBucketsDays.join(", ")})`} />
        <Table>
          <thead>
            <tr><Th>Courier</Th><Th align="right">In transit</Th><Th align="right">Delivered, unsettled</Th>{buckets.map((b) => <Th key={b} align="right">{b}d</Th>)}<Th align="right">Settled</Th><Th align="right">Disputed</Th><Th align="right">RTO value</Th></tr>
          </thead>
          <tbody>
            {recon.map((r) => (
              <tr key={String(r.c._id)}>
                <Td><Link href={`/shipments?courier=${r.c._id}`} className="font-medium hover:underline">{r.c.label}</Link><div className="text-xs text-muted-foreground">{r.n} shipments</div></Td>
                <Td align="right"><Link className="hover:underline" href={`/shipments?courier=${r.c._id}&status=in_transit`}>{pkr(r.inTransit)}</Link></Td>
                <Td align="right"><Link className="hover:underline" href={`/shipments?courier=${r.c._id}&status=delivered`}>{pkr(r.unsettled)}</Link></Td>
                {buckets.map((b) => <Td key={b} align="right" className={b.endsWith("+") && r.aging[b] ? "text-negative" : ""}>{pkr(r.aging[b] ?? 0)}</Td>)}
                <Td align="right">{pkr(r.settled)}</Td>
                <Td align="right" className={r.disputed ? "text-negative" : ""}>{pkr(r.disputed)}</Td>
                <Td align="right">{pkr(r.rto)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        {canImport ? (
          <Card>
            <CardHeader title="Import settlement file" description="CSV from the courier's payment report. Same file twice is rejected." />
            <CardBody className="grid gap-5">
              <ActionForm action={uploadSettlement} className="grid gap-3">
                <Field label="Courier" htmlFor="courierId"><Select id="courierId" name="courierId">{couriers.map((c) => <option key={String(c._id)} value={String(c._id)}>{c.label}</option>)}</Select></Field>
                <Field label="File (.csv)" htmlFor="file"><Input id="file" name="file" type="file" accept=".csv,text/csv" required className="py-1.5" /></Field>
                <Submit>Upload and preview</Submit>
              </ActionForm>
              {tcs?.mode === "live" ? (
                <ActionForm action={tcsInvoice} className="grid gap-3 border-t pt-4">
                  <input type="hidden" name="integrationId" value={String(tcs._id)} />
                  <Field label="TCS payment invoice no." htmlFor="inv" hint="Pulls the invoice via the TCS Payment Invoice API"><Input id="inv" name="invoiceNo" required /></Field>
                  <Submit variant="outline">Fetch and post</Submit>
                </ActionForm>
              ) : null}
              <p className="text-xs text-muted-foreground">Leopards settlements are also pulled automatically by the worker from <span className="font-mono">getShippingCharges</span> (grouped by cheque/invoice number) once live credentials are set.</p>
            </CardBody>
          </Card>
        ) : null}
        <Card className="lg:col-span-2">
          <CardHeader title="Settlements" />
          <Table>
            <thead><tr><Th>Date</Th><Th>Courier</Th><Th>Reference</Th><Th align="right">Gross COD</Th><Th align="right">Deductions</Th><Th align="right">Net received</Th><Th>Status</Th><Th>Source</Th></tr></thead>
            <tbody>
              {settlements.map((s) => (
                <tr key={String(s._id)} className="hover:bg-muted/40">
                  <Td>{day(s.date)}</Td><Td>{cName.get(s.courierId)}</Td>
                  <Td mono><Link className="text-primary hover:underline" href={`/cod/settlements/${s._id}`}>{s.reference}</Link></Td>
                  <Td align="right">{pkr(s.grossCodMinor)}</Td><Td align="right">{pkr(s.deductionsMinor)}</Td><Td align="right">{pkr(s.netReceivedMinor)}</Td>
                  <Td><StatusBadge status={s.status} /></Td><Td>{s.source}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {settlements.length === 0 ? <Empty title="No settlements yet" /> : null}
        </Card>
      </div>

      <Card className="mt-4" id="exceptions">
        <CardHeader title={`Exceptions (${exceptions.length})`} description="Settlement lines not posted automatically. Resolve with a note after checking with the courier — an open exception blocks the period close." />
        <Table>
          <thead><tr><Th>CN</Th><Th>Courier</Th><Th align="right">COD in file</Th><Th align="right">Expected</Th><Th>Flag</Th><Th>Resolve</Th></tr></thead>
          <tbody>
            {exceptions.map((l) => (
              <tr key={String(l._id)}>
                <Td mono>{l.cn}</Td><Td>{cName.get(l.courierId)}</Td><Td align="right">{pkr(l.codMinor)}</Td><Td align="right">{pkr(l.expectedCodMinor)}</Td><Td><StatusBadge status={l.flag} /></Td>
                <Td>
                  {canImport ? (
                    <ActionForm action={resolveLine} className="flex gap-2">
                      <input type="hidden" name="lineId" value={String(l._id)} />
                      <Input name="note" placeholder="What was agreed with the courier" className="h-8 min-w-56 text-[13px]" required aria-label={`Resolution note for ${l.cn}`} />
                      <Submit size="xs" variant="outline">Resolve</Submit>
                    </ActionForm>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {exceptions.length === 0 ? <Empty title="No open exceptions" /> : null}
      </Card>
    </>
  );
}

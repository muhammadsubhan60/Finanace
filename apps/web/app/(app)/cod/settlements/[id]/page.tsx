import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb, ORG_ID } from "@delta/db";
import { Card, CardBody, CardHeader, Line, PageHeader, StatusBadge, Table, Td, Th } from "@/components/ui";
import { requireUser } from "@/lib/session";
import { day, pkr } from "@/lib/utils";

export default async function Settlement({ params }: { params: Promise<{ id: string }> }) {
  await requireUser("profit:view");
  const { id } = await params;
  const db = await getDb();
  const s = await db.collection("cod_settlements").findOne({ _id: id as never, orgId: ORG_ID });
  if (!s) notFound();
  const lines = await db.collection("cod_settlement_lines").find({ settlementId: id }).toArray();
  const entry = await db.collection("journal_entries").findOne({ orgId: ORG_ID, idempotencyKey: `settlement:${id}` });
  return (
    <>
      <PageHeader title={`Settlement ${s.reference}`} description={`${day(s.date)} · source ${s.source}`} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Summary" />
          <CardBody>
            <Line label="Gross COD" value={pkr(s.grossCodMinor)} />
            <Line label="Deductions" value={pkr(-s.deductionsMinor)} sub />
            <Line label="Net received" value={pkr(s.netReceivedMinor)} strong />
            <div className="mt-3"><StatusBadge status={s.status} /></div>
            {entry ? <Link href={`/journal?entry=${entry._id}`} className="mt-3 block text-sm text-primary hover:underline">Journal entry #{entry.seq}</Link> : null}
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title={`${lines.length} lines`} />
          <Table>
            <thead><tr><Th>CN</Th><Th align="right">COD</Th><Th align="right">Freight</Th><Th align="right">COD fee</Th><Th align="right">Return fee</Th><Th>Flag</Th><Th>Posted</Th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={String(l._id)}>
                  <Td mono><Link className="hover:underline" href={`/shipments?q=${l.cn}`}>{l.cn}</Link></Td>
                  <Td align="right">{pkr(l.codMinor)}</Td><Td align="right">{pkr(l.freightMinor)}</Td><Td align="right">{pkr(l.codFeeMinor)}</Td><Td align="right">{pkr(l.returnFeeMinor)}</Td>
                  <Td><StatusBadge status={l.flag} /></Td><Td>{l.posted ? "Yes" : "No"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}

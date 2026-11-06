import Link from "next/link";
import { getDb, ORG_ID } from "@delta/db";
import { Badge, Card, CardHeader, Empty, PageHeader, Pagination, Table, Td, Th } from "@/components/ui";
import { FilterBar, FInput, FSelect } from "@/components/filters";
import { requireUser } from "@/lib/session";
import { day, pkr, qs } from "@/lib/utils";

export const metadata = { title: "Journal" };
const PAGE = 100;

/** Drill-down target for every money figure: journal lines filtered by account / period / range / entry. */
export default async function Journal({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireUser("profit:view");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1));
  const db = await getDb();
  const accounts = await db.collection("accounts").find({ orgId: ORG_ID }).sort({ type: 1, _id: 1 }).toArray();
  const q: Record<string, unknown> = { orgId: ORG_ID };
  if (sp.account) q.accountId = sp.account;
  if (sp.period) q.periodId = sp.period;
  if (sp.entry) q.entryId = sp.entry;
  if (sp.source) q.source = sp.source;
  if (sp.from || sp.to) q.date = { ...(sp.from ? { $gte: sp.from } : {}), ...(sp.to ? { $lte: sp.to } : {}) };
  const [lines, total, totals] = await Promise.all([
    db.collection("journal_lines").find(q).sort({ date: -1, _id: 1 }).skip((page - 1) * PAGE).limit(PAGE).toArray(),
    db.collection("journal_lines").countDocuments(q),
    db.collection("journal_lines").aggregate<{ d: number; c: number }>([{ $match: q }, { $group: { _id: null, d: { $sum: "$debitMinor" }, c: { $sum: "$creditMinor" } } }]).next(),
  ]);
  const entries = new Map((await db.collection("journal_entries").find({ _id: { $in: [...new Set(lines.map((l) => l.entryId))] as never[] } }, { projection: { seq: 1, memo: 1, reversalOf: 1, correctionOf: 1, hash: 1 } }).toArray()).map((e) => [String(e._id), e]));
  const name = new Map(accounts.map((a) => [String(a._id), a.name]));
  return (
    <>
      <PageHeader title="Journal" description="Append-only double-entry ledger. Entries are never edited or deleted; corrections are reversal + new entries. Each entry is hash-chained to the previous one." />
      <FilterBar>
        <FSelect name="account" label="Account" value={sp.account} options={accounts.map((a) => ({ value: String(a._id), label: `${a.name}` }))} />
        <FInput name="period" label="Period" value={sp.period} placeholder="2026-11" />
        <FInput name="from" label="From" type="date" value={sp.from} />
        <FInput name="to" label="To" type="date" value={sp.to} />
      </FilterBar>
      <Card>
        <CardHeader title={`${total.toLocaleString()} lines`} description={totals ? `Debits ${pkr(totals.d)} · Credits ${pkr(totals.c)} · Net ${pkr(totals.d - totals.c)}` : undefined} />
        <Table>
          <thead><tr><Th>Date</Th><Th>Entry</Th><Th>Account</Th><Th>Source</Th><Th>Reference</Th><Th align="right">Debit</Th><Th align="right">Credit</Th></tr></thead>
          <tbody>
            {lines.map((l) => {
              const e = entries.get(l.entryId);
              return (
                <tr key={String(l._id)} className="hover:bg-muted/40">
                  <Td>{day(l.date)}</Td>
                  <Td><Link className="font-mono text-[13px] text-primary hover:underline" href={`/journal?entry=${l.entryId}`}>#{e?.seq}</Link>{e?.reversalOf ? <Badge tone="warning">reversal</Badge> : null}{e?.correctionOf ? <Badge tone="warning">correction {e.correctionOf.periodId}</Badge> : null}<div className="max-w-56 truncate text-xs text-muted-foreground">{e?.memo}</div></Td>
                  <Td>{name.get(l.accountId) ?? l.accountId}</Td>
                  <Td>{l.source}</Td>
                  <Td className="text-[13px]">{l.refType ? `${l.refType}` : ""}{l.refType === "shipment" ? null : null}</Td>
                  <Td align="right">{l.debitMinor ? pkr(l.debitMinor, true) : ""}</Td>
                  <Td align="right">{l.creditMinor ? pkr(l.creditMinor, true) : ""}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        {lines.length === 0 ? <Empty title="No journal lines for these filters" /> : null}
        <Pagination page={page} pageSize={PAGE} total={total} hrefFor={(p) => qs(sp, { page: String(p) })} />
      </Card>
    </>
  );
}

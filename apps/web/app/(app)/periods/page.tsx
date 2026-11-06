import Link from "next/link";
import { getDb, ORG_ID } from "@delta/db";
import { addMonths, karachiDate, periodIdOf } from "@delta/core";
import { Card, PageHeader, StatusBadge, Table, Td, Th } from "@/components/ui";
import { requireUser } from "@/lib/session";
import { day, pkr } from "@/lib/utils";

export const metadata = { title: "Periods" };

export default async function Periods() {
  await requireUser("profit:view");
  const db = await getDb();
  const docs = await db.collection("periods").find({ orgId: ORG_ID }).toArray();
  const byId = new Map(docs.map((d) => [d.periodId, d]));
  const snaps = new Map((await db.collection("period_snapshots").find({ orgId: ORG_ID, kind: "close" }).toArray()).map((s) => [s.periodId, s]));
  const current = periodIdOf(karachiDate());
  const first = [...docs.map((d) => d.periodId), addMonths(current, -2)].sort()[0]!;
  const ids: string[] = [];
  for (let p = current; p >= first; p = addMonths(p, -1)) ids.push(p);
  return (
    <>
      <PageHeader title="Periods" description="open → closing (data freeze + checks) → closed (report issued, objection window) → final (automatic after the configured days)." />
      <Card>
        <Table>
          <thead><tr><Th>Period</Th><Th>Status</Th><Th align="right">Net Profit</Th><Th align="right">Reinvestment</Th><Th align="right">Shared</Th><Th>Profile</Th><Th>Final on</Th></tr></thead>
          <tbody>
            {ids.map((id) => {
              const p = byId.get(id);
              const s = snaps.get(id);
              return (
                <tr key={id} className="hover:bg-muted/40">
                  <Td><Link href={`/periods/${id}`} className="font-medium text-primary hover:underline">{id}</Link>{id === current ? <span className="ml-2 text-xs text-muted-foreground">current</span> : null}</Td>
                  <Td><StatusBadge status={p?.status ?? "open"} /></Td>
                  <Td align="right">{s ? pkr(s.result.netProfitMinor) : "—"}</Td>
                  <Td align="right">{s ? pkr(s.result.reinvestment.minor) : "—"}</Td>
                  <Td align="right">{s ? pkr(s.result.sharedProfitMinor) : "—"}</Td>
                  <Td>{p?.profileVersion ? `v${p.profileVersion}` : "—"}</Td>
                  <Td>{p?.finalizedAt ? day(p.finalizedAt) : p?.finalDueAt ? `${day(p.finalDueAt)} (auto)` : "—"}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

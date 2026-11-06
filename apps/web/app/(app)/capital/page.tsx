import { capitalSummary, ORG_ID } from "@delta/db";
import { karachiDate } from "@delta/core";
import { Card, CardBody, CardHeader, Empty, Field, Input, Notice, PageHeader, StatusBadge, Table, Td, Th } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { has, requireUser } from "@/lib/session";
import { day, pkr } from "@/lib/utils";
import { propose, release } from "./actions";

export const metadata = { title: "Capital & Tranches" };

export default async function Capital() {
  const u = await requireUser("profit:view");
  const s = await capitalSummary(ORG_ID);
  const usedPct = s.envelopeMinor ? Math.round((s.committedMinor / s.envelopeMinor) * 100) : 0;
  return (
    <>
      <PageHeader title="Capital & Tranches" description="Tranches are proposed, approved by both partners, then released with a bank reference. Release beyond the envelope is blocked." />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Funding envelope" />
          <CardBody className="grid gap-3">
            <div className="flex justify-between text-sm"><span>Released</span><span className="tabular-nums font-medium">{pkr(s.releasedMinor)}</span></div>
            <div className="flex justify-between text-sm"><span>Committed (planned + approved + released)</span><span className="tabular-nums">{pkr(s.committedMinor)}</span></div>
            <div className="flex justify-between text-sm"><span>Envelope</span><span className="tabular-nums">{pkr(s.envelopeMinor)}</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={usedPct} aria-valuemin={0} aria-valuemax={100} aria-label="Envelope used">
              <div className={usedPct >= s.warnAtPct ? "h-full bg-warning" : "h-full bg-primary"} style={{ width: `${Math.min(100, usedPct)}%` }} />
            </div>
            {usedPct >= s.warnAtPct ? <Notice tone="warning">{usedPct}% of the envelope is committed.</Notice> : null}
            {has(u, "tranche:propose") ? (
              <ActionForm action={propose} className="mt-2 grid gap-3 border-t pt-4" resetOnSuccess>
                <Field label="Amount (PKR)" htmlFor="amt"><Input id="amt" name="amount" inputMode="decimal" required /></Field>
                <Field label="Purpose" htmlFor="purpose"><Input id="purpose" name="purpose" required /></Field>
                <Field label="Planned date" htmlFor="pd"><Input id="pd" name="plannedDate" type="date" defaultValue={karachiDate()} required /></Field>
                <Submit variant="outline">Propose tranche</Submit>
              </ActionForm>
            ) : null}
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Tranche schedule" />
          <Table>
            <thead><tr><Th>Planned</Th><Th>Purpose</Th><Th align="right">Amount</Th><Th>Status</Th><Th>Release</Th></tr></thead>
            <tbody>
              {s.rows.map((t) => (
                <tr key={t._id}>
                  <Td>{day(t.plannedDate)}</Td><Td>{t.purpose}</Td><Td align="right">{pkr(t.amountMinor)}</Td><Td><StatusBadge status={t.status} /></Td>
                  <Td>
                    {t.status === "approved" && has(u, "tranche:release") ? (
                      <ActionForm action={release} className="flex gap-1.5"><input type="hidden" name="id" value={t._id} /><Input name="bankRef" placeholder="Bank ref" required className="h-8 w-28 text-[13px]" aria-label="Bank reference" /><Submit size="xs" variant="outline">Release</Submit></ActionForm>
                    ) : t.status === "released" ? `${day(t.releaseDate)} · ${t.bankRef}` : "—"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {s.rows.length === 0 ? <Empty title="No tranches" /> : null}
        </Card>
      </div>
    </>
  );
}

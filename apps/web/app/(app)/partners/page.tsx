import { evaluateWithdrawal, getCurrentProfile, getDb, ORG_ID, partnerCards } from "@delta/db";
import { parsePKR } from "@delta/core";
import { Card, CardBody, CardHeader, Empty, Field, Input, Line, Notice, PageHeader, Select, StatusBadge, Table, Td, Th, Badge } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { FilterBar, FInput, FSelect } from "@/components/filters";
import { has, requireUser } from "@/lib/session";
import { dt, pkr } from "@/lib/utils";
import { pay, request } from "./actions";

export const metadata = { title: "Partners & Withdrawals" };

export default async function Partners({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const u = await requireUser("profit:view");
  const sp = await searchParams;
  const db = await getDb();
  const profile = await getCurrentProfile();
  const [cards, withdrawals, closed] = await Promise.all([
    partnerCards(ORG_ID),
    db.collection("withdrawals").find({ orgId: ORG_ID }).sort({ createdAt: -1 }).limit(50).toArray(),
    db.collection("periods").find({ orgId: ORG_ID, status: { $in: ["closed", "final"] } }).sort({ periodId: -1 }).toArray(),
  ]);
  const partnerId = sp.partner ?? u.partnerId ?? profile.partners[0]!.partnerId;
  const periodId = sp.period ?? closed[0]?.periodId;
  let evalResult: Awaited<ReturnType<typeof evaluateWithdrawal>> | null = null;
  let evalError: string | null = null;
  if (periodId) {
    try {
      evalResult = await evaluateWithdrawal(ORG_ID, periodId, partnerId, sp.amount ? parsePKR(sp.amount) : 0);
    } catch (e) {
      evalError = (e as Error).message;
    }
  }
  const label = new Map(profile.partners.map((p) => [p.partnerId, p.label]));
  return (
    <>
      <PageHeader title="Partners & Withdrawals" description="Undrawn balances belong to the partner. Withdrawals are checked against the cap, cash safeguards and available balance before approval." />
      <div className="grid gap-3 md:grid-cols-2">
        {cards.map((c) => (
          <Card key={c.partnerId}>
            <CardHeader title={c.label} description={`${c.sharePct}% share`} />
            <CardBody className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[["Allocated to date", c.allocatedToDateMinor], ["Withdrawn to date", c.withdrawnToDateMinor], ["Undrawn balance", c.undrawnMinor], ["Cap remaining", c.capRemainingMinor]].map(([l, v]) => (
                <div key={l as string}><div className="text-xs text-muted-foreground">{l}</div><div className="mt-0.5 text-lg font-semibold tabular-nums">{v == null ? "No cap" : pkr(v as number)}</div></div>
              ))}
              {c.nettingMinor ? <div className="col-span-full"><Notice tone="warning">Over-distribution netting receivable: {pkr(c.nettingMinor)} — netted against this partner&apos;s own future distributions.</Notice></div> : null}
            </CardBody>
          </Card>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader title="Withdrawal calculator" description="Shows the calculation the approver will see." />
          <CardBody>
            {closed.length === 0 ? <Notice>No closed period yet. Withdrawals are made against a closed period&apos;s allocation.</Notice> : (
              <>
                <FilterBar>
                  <FSelect name="partner" label="Partner" value={partnerId} options={profile.partners.map((p) => ({ value: p.partnerId, label: p.label }))} />
                  <FSelect name="period" label="Against period" value={periodId} options={closed.map((p) => ({ value: p.periodId, label: `${p.periodId} (${p.status})` }))} />
                  <FInput name="amount" label="Amount (PKR)" value={sp.amount} />
                </FilterBar>
                {evalError ? <Notice tone="negative">{evalError}</Notice> : null}
                {evalResult ? (
                  <div>
                    {evalResult.cashLines.map((l) => <Line key={l.label} label={l.label} value={pkr(l.minor)} sub={l.minor < 0} />)}
                    <Line strong label="Distributable cash" value={pkr(evalResult.distributableMinor)} />
                    <Line label={`${label.get(partnerId)} share of distributable cash`} value={pkr(evalResult.partner.cashShareMinor)} />
                    <Line label="Available balance (opening undrawn + allocation − netting)" value={pkr(evalResult.partner.availableMinor)} />
                    <Line label={evalResult.partner.capApplies ? `Cap remaining (cap ${pkr(evalResult.partner.capMinor)})` : "Cap"} value={evalResult.partner.capApplies ? pkr(evalResult.partner.capRemainingMinor) : "Not in cap months"} />
                    <Line sub label="Already approved/paid against this period" value={pkr(evalResult.partner.withdrawnThisPeriodMinor)} />
                    <Line strong label={`Withdrawable now (limited by ${evalResult.limitedBy})`} value={pkr(evalResult.withdrawableMinor)} />
                    {evalResult.breaches.length ? <div className="mt-2"><Notice tone="negative">Requested amount breaks: {evalResult.breaches.join(", ")}. It needs a recorded override reason approved by both partners.</Notice></div> : null}
                    {has(u, "withdrawal:request") ? (
                      <ActionForm action={request} className="mt-4 grid gap-3 border-t pt-4">
                        <input type="hidden" name="partnerId" value={partnerId} />
                        <input type="hidden" name="periodId" value={periodId} />
                        <Field label="Amount (PKR)" htmlFor="wamt"><Input id="wamt" name="amount" defaultValue={sp.amount} inputMode="decimal" required /></Field>
                        <Field label="Override reason" htmlFor="ovr" hint="Only if the amount breaks the cap or safeguards"><Input id="ovr" name="overrideReason" /></Field>
                        <Submit>Request withdrawal</Submit>
                      </ActionForm>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Withdrawals" />
          <Table>
            <thead><tr><Th>Requested</Th><Th>Partner</Th><Th>Period</Th><Th align="right">Amount</Th><Th>Status</Th><Th>Action</Th></tr></thead>
            <tbody>
              {withdrawals.map((w) => (
                <tr key={String(w._id)}>
                  <Td>{dt(w.createdAt)}</Td><Td>{label.get(w.partnerId)}</Td><Td>{w.periodId}</Td>
                  <Td align="right">{pkr(w.amountMinor)}{w.overrideReason ? <div><Badge tone="warning">override</Badge></div> : null}</Td>
                  <Td><StatusBadge status={w.status} /></Td>
                  <Td>
                    {w.status === "approved" && has(u, "withdrawal:pay") ? (
                      <ActionForm action={pay} className="flex gap-1.5"><input type="hidden" name="id" value={String(w._id)} /><Input name="bankRef" placeholder="Bank ref" required className="h-8 w-28 text-[13px]" aria-label="Bank reference" /><Submit size="xs" variant="outline">Mark paid</Submit></ActionForm>
                    ) : w.bankRef ?? "—"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {withdrawals.length === 0 ? <Empty title="No withdrawals yet" /> : null}
        </Card>
      </div>
    </>
  );
}

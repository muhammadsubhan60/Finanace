import Link from "next/link";
import { notFound } from "next/navigation";
import { closeChecklist, ensurePeriod, estimatePeriod, getDb, getProfileFor, getSnapshot, ORG_ID, periodTimeline, verifySnapshot } from "@delta/db";
import { karachiDate, periodBounds, periodIdOf, toPKRString } from "@delta/core";
import { Badge, Card, CardBody, CardHeader, Field, Input, LinkButton, Notice, PageHeader, Select, StatusBadge, Textarea } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Statement } from "@/components/statement";
import { has, requireUser } from "@/lib/session";
import { day, dt, pkr } from "@/lib/utils";
import { cancel, close, comment, correction, object, resolve, saveInputs, start } from "./actions";

export default async function PeriodPage({ params }: { params: Promise<{ periodId: string }> }) {
  const u = await requireUser("profit:view");
  const { periodId } = await params;
  if (!/^\d{4}-\d{2}$/.test(periodId)) notFound();
  const p = await ensurePeriod(periodId);
  const profile = await getProfileFor(periodBounds(periodId).start);
  const db = await getDb();
  const snap = await getSnapshot(ORG_ID, periodId);
  const live = !snap?.snapshot ? await estimatePeriod(ORG_ID, periodId) : null;
  const checks = p.status === "open" || p.status === "closing" ? await closeChecklist(ORG_ID, periodId) : [];
  const objections = await db.collection("objections").find({ orgId: ORG_ID, periodId }).sort({ createdAt: -1 }).toArray();
  const t = periodTimeline(p, profile);
  const verified = snap?.snapshot ? await verifySnapshot(snap.snapshot._id) : null;
  const canClose = has(u, "period:close");
  const past = periodId < periodIdOf(karachiDate());
  const daysToFinal = p.finalDueAt ? Math.ceil((p.finalDueAt.getTime() - Date.now()) / 86_400_000) : null;
  const r = snap?.snapshot?.result ?? live!.result;
  const ri = p.reserveInputs;
  const val = (m?: number) => (m ? toPKRString(m) : "");

  return (
    <>
      <PageHeader
        title={`Period ${periodId}`}
        description={`Computed with Agreement Profile v${snap?.snapshot?.profileVersion ?? profile.version} (the version effective at period start). Close due ${day(t.closeDue)} · payout target ${day(t.payoutTarget)}.`}
        actions={
          <>
            <StatusBadge status={p.status} />
            {snap?.snapshot ? <LinkButton href={`/periods/${periodId}/print`} variant="outline" size="sm">PDF / print</LinkButton> : null}
            {snap?.snapshot ? <LinkButton href={`/api/periods/${periodId}/csv`} variant="outline" size="sm">CSV</LinkButton> : null}
          </>
        }
      />
      {p.status === "closed" && daysToFinal != null ? (
        <div className="mb-4"><Notice tone="warning">Becomes <strong>Final automatically in {Math.max(0, daysToFinal)} days</strong> ({day(p.finalDueAt)}). Objection window ends {day(t.objectionWindowEnds)}. An objection pauses only the disputed item.</Notice></div>
      ) : null}
      {!snap?.snapshot ? <div className="mb-4"><Notice tone="warning">Live estimate — not final. Figures change as data arrives until the period is closed.</Notice></div> : null}

      {(p.status === "open" || p.status === "closing") && past ? (
        <div className="mb-4 grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Pre-close checklist" description="The system never closes with failed blocking checks. Blocking rules are configured in the profile." />
            <CardBody className="grid gap-2">
              {checks.map((c) => (
                <div key={c.key} className="flex items-start justify-between gap-3 rounded-md border p-2.5">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{c.label}</div>
                    <div className="text-xs text-muted-foreground">{c.detail}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {!c.blocking ? <Badge>warning only</Badge> : null}
                    {c.ok ? <Badge tone="positive">pass</Badge> : <Badge tone={c.blocking ? "negative" : "warning"}>{c.blocking ? "fail" : "check"}</Badge>}
                    {!c.ok && c.href ? <Link className="text-xs text-primary hover:underline" href={c.href}>Fix</Link> : null}
                  </div>
                </div>
              ))}
              {canClose ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {p.status === "open" ? <ActionForm action={start}><input type="hidden" name="periodId" value={periodId} /><Submit variant="outline">Start close (freeze data)</Submit></ActionForm> : null}
                  {p.status === "closing" ? (
                    <>
                      <ActionForm action={close} confirm={`Close ${periodId}? This issues the statement and starts the ${profile.finalization.objectionWindowDays}-day objection window.`}><input type="hidden" name="periodId" value={periodId} /><Submit>Compute and close</Submit></ActionForm>
                      <ActionForm action={cancel}><input type="hidden" name="periodId" value={periodId} /><Submit variant="ghost">Reopen</Submit></ActionForm>
                    </>
                  ) : null}
                </div>
              ) : null}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Close inputs" description={`Bank balance and reserve components (buffer: ${profile.cashSafeguards.bufferDays} days). Known liabilities come from the ledger.`} />
            <CardBody>
              <ActionForm action={saveInputs} className="grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="periodId" value={periodId} />
                <Field label="Bank balance at month end" htmlFor="bank" className="sm:col-span-2"><Input id="bank" name="bankBalance" inputMode="decimal" defaultValue={val(p.bankBalanceMinor)} disabled={!canClose} /></Field>
                {[["payrollDueMinor", "Payroll due"], ["taxesDueMinor", "Taxes due"], ["refundsExpectedMinor", "Refunds expected"], ["courierReturnExposureMinor", "Courier return exposure"], ["fixedCostsNextBufferMinor", `Fixed costs, next ${profile.cashSafeguards.bufferDays} days`], ["inventoryNeedsNextBufferMinor", `Inventory needs, next ${profile.cashSafeguards.bufferDays} days`], ["extraReserveMinor", "Extra reserve"]].map(([k, l]) => (
                  <Field key={k} label={l!} htmlFor={k!}><Input id={k} name={k} inputMode="decimal" defaultValue={val(ri?.[k as keyof typeof ri] as number | undefined)} disabled={!canClose} /></Field>
                ))}
                <Field label="Extra reserve written calc ref" htmlFor="calc" hint={profile.cashSafeguards.requireWrittenCalcForExtraReserve ? "Required for an extra reserve" : undefined}><Input id="calc" name="extraReserveCalcRef" defaultValue={ri?.extraReserveCalcRef ?? ""} disabled={!canClose} /></Field>
                {canClose ? <div className="sm:col-span-2"><Submit variant="outline">Save inputs</Submit></div> : null}
              </ActionForm>
            </CardBody>
          </Card>
        </div>
      ) : null}

      <Card className="mb-4">
        <CardHeader title={snap?.snapshot ? "Statement" : "Estimated statement"} description={snap?.snapshot ? `Issued ${dt(p.closedAt)} · engine ${snap.snapshot.engineVersion} · inputs ${snap.snapshot.inputsHash.slice(0, 16)}…` : undefined} action={verified ? <Badge tone={verified.ok ? "positive" : "negative"}>{verified.ok ? "Reproducible ✓" : "Does not reproduce"}</Badge> : null} />
        <CardBody>
          <Statement r={r} />
          {r.warnings.length ? <div className="mt-4 grid gap-1">{r.warnings.map((w) => <Notice key={w} tone="warning">{w}</Notice>)}</div> : null}
        </CardBody>
      </Card>

      {snap?.corrections.length ? (
        <Card className="mb-4">
          <CardHeader title="Corrected statement" description="After an approved correction. Struck-through figures are the original Final values; corrections were posted in the current period." />
          <CardBody><Statement r={snap.corrections[0]!.result} compare={snap.snapshot!.result} /></CardBody>
        </Card>
      ) : null}

      {p.status === "closed" || p.status === "final" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title={`Objections (${objections.length})`} />
            <CardBody className="grid gap-3">
              {objections.map((o) => (
                <div key={String(o._id)} className="rounded-md border p-3 text-sm">
                  <div className="flex justify-between gap-2"><span className="font-medium">{o.itemRef}</span><StatusBadge status={o.status === "open" ? "pending" : "resolved"} /></div>
                  <p className="mt-1">{o.reason}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{o.raisedByName} · {dt(o.createdAt)}{o.amountMinor ? ` · ${pkr(o.amountMinor)}` : ""}{o.finalityPaused ? " · finality paused" : ""}</p>
                  {(o.comments ?? []).map((c: { by: string; role: string; text: string; at: Date }, i: number) => <p key={i} className="mt-1 border-l-2 pl-2 text-[13px]"><span className="font-medium">{c.by}</span> ({c.role}): {c.text}</p>)}
                  {o.status === "open" ? (
                    <div className="mt-2 grid gap-2">
                      <ActionForm action={comment} className="flex gap-2"><input type="hidden" name="id" value={String(o._id)} /><input type="hidden" name="periodId" value={periodId} /><Input name="text" placeholder="Comment" className="h-8 text-[13px]" required aria-label="Comment" /><Submit size="xs" variant="outline">Add</Submit></ActionForm>
                      {has(u, "objection:resolve") ? (
                        <ActionForm action={resolve} className="flex flex-wrap gap-2"><input type="hidden" name="id" value={String(o._id)} /><input type="hidden" name="periodId" value={periodId} />
                          <Select name="resolution" className="h-8 w-48 text-[13px]" aria-label="Resolution"><option value="agreed_adjust">Agreed — adjust</option><option value="rejected">Rejected</option><option value="accountant_ruling">Accountant ruling</option></Select>
                          <Input name="note" placeholder="Resolution note" className="h-8 flex-1 text-[13px]" required aria-label="Resolution note" /><Submit size="xs" variant="outline">Resolve</Submit>
                        </ActionForm>
                      ) : null}
                    </div>
                  ) : <p className="mt-1 text-xs">Resolved ({o.resolution?.replace("_", " ")}): {o.resolutionNote}</p>}
                </div>
              ))}
              {p.status === "closed" && has(u, "objection:raise") ? (
                <ActionForm action={object} className="grid gap-2 border-t pt-3" resetOnSuccess>
                  <input type="hidden" name="periodId" value={periodId} />
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Item" htmlFor="item"><Input id="item" name="itemRef" placeholder="e.g. Ads, expense id, CN" required /></Field>
                    <Field label="Amount (optional)" htmlFor="oamt"><Input id="oamt" name="amount" inputMode="decimal" /></Field>
                  </div>
                  <Field label="Reason" htmlFor="reason"><Textarea id="reason" name="reason" rows={2} required className="font-sans text-sm" /></Field>
                  <Submit variant="outline" size="sm">Raise objection</Submit>
                </ActionForm>
              ) : null}
            </CardBody>
          </Card>
          {has(u, "journal:adjust") ? (
            <Card>
              <CardHeader title="Request a correction" description={`Permitted reasons: ${profile.finalization.correctionReasons.join(", ")}. Within ${profile.finalization.correctionWindowMonths} months, needs owner + MD. Posted as dated adjusting entries in the current period.`} />
              <CardBody>
                <ActionForm action={correction} className="grid gap-3">
                  <input type="hidden" name="periodId" value={periodId} />
                  <Field label="Reason" htmlFor="creason"><Select id="creason" name="reason">{profile.finalization.correctionReasons.map((x) => <option key={x} value={x}>{x.replace(/_/g, " ")}</option>)}</Select></Field>
                  <Field label="Memo" htmlFor="cmemo"><Input id="cmemo" name="memo" required /></Field>
                  <Field label="Lines" htmlFor="clines" hint="One per line: account, debit, credit — e.g. exp_ads, 5000, 0 then card_payable, 0, 5000"><Textarea id="clines" name="lines" rows={4} required /></Field>
                  <Submit variant="outline">Submit for approval</Submit>
                </ActionForm>
              </CardBody>
            </Card>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

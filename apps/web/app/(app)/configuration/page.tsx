import Link from "next/link";
import { diffWithActive, getCurrentProfile, listProfiles, ORG_ID, getDb } from "@delta/db";
import { addMonths, karachiDate, periodIdOf, toPKRString } from "@delta/core";
import { Badge, Card, CardBody, CardHeader, Field, Input, LinkButton, Notice, PageHeader, Select, StatusBadge, Table, Td, Textarea, Th } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { has, requireUser } from "@/lib/session";
import { dt } from "@/lib/utils";
import { discard, draftFromForm, draftFromJson, submit } from "./actions";

export const metadata = { title: "Configuration" };

export default async function Configuration() {
  const u = await requireUser("profit:view");
  const profile = await getCurrentProfile();
  const versions = await listProfiles(ORG_ID);
  const open = versions.filter((v) => (v.status === "draft" || v.status === "pending_approval") && !v.discardedAt);
  const diffs = await Promise.all(open.map(async (v) => ({ v, diff: await diffWithActive(v.version) })));
  const db = await getDb();
  const lastClosed = await db.collection("periods").find({ orgId: ORG_ID, status: { $in: ["closing", "closed", "final"] } }).sort({ periodId: -1 }).limit(1).next();
  const nextEff = `${lastClosed ? addMonths(lastClosed.periodId, 1) : addMonths(periodIdOf(karachiDate()), 1)}-01`;
  const canPropose = has(u, "config:propose");
  const { version: _v, status: _s, ...json } = profile;

  return (
    <>
      <PageHeader
        title="Configuration"
        description="The Agreement Profile drives every rule. Active versions are immutable; a change creates a draft that needs approval from both owner and MD and applies from its effective date. Closed periods always keep the version they were computed with."
        actions={<LinkButton href="/configuration/status-mappings" variant="outline" size="sm">Courier status mappings</LinkButton>}
      />

      {diffs.map(({ v, diff }) => (
        <Card key={v._id} className="mb-4 border-primary/40">
          <CardHeader title={`v${v.version} — ${v.changeNote ?? ""}`} description={`Effective from ${v.effectiveFrom} · created ${dt(v.createdAt)}`} action={<StatusBadge status={v.status} />} />
          <Table>
            <thead><tr><Th>Setting</Th><Th>Active (v{profile.version})</Th><Th>Proposed</Th></tr></thead>
            <tbody>
              {diff.length === 0 ? <tr><Td>No changes vs active</Td><Td /><Td /></tr> : null}
              {diff.map((d) => <tr key={d.path}><Td mono>{d.path}</Td><Td mono className="text-negative">{JSON.stringify(d.before)}</Td><Td mono className="text-positive">{JSON.stringify(d.after)}</Td></tr>)}
            </tbody>
          </Table>
          {v.status === "draft" && canPropose ? (
            <div className="flex gap-2 p-4 sm:px-5">
              <ActionForm action={submit}><input type="hidden" name="version" value={v.version} /><Submit size="sm">Submit for dual approval</Submit></ActionForm>
              <ActionForm action={discard}><input type="hidden" name="version" value={v.version} /><Submit size="sm" variant="ghost">Discard</Submit></ActionForm>
            </div>
          ) : v.status === "pending_approval" ? <div className="p-4 text-sm sm:px-5">Waiting for approvals — <Link className="text-primary hover:underline" href="/approvals">open approvals</Link></div> : null}
        </Card>
      ))}

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader title={`Active profile v${profile.version}`} description={`Effective from ${profile.effectiveFrom}. Edit here to create a new draft version.`} />
          <CardBody>
            {!canPropose ? <Notice>Read only for your role.</Notice> : null}
            <ActionForm action={draftFromForm} className="grid gap-5">
              <fieldset disabled={!canPropose} className="grid gap-5">
                <Section title="Reinvestment and distribution">
                  <Field label="Reinvestment %" htmlFor="rp"><Input id="rp" name="reinvestmentPct" defaultValue={profile.reinvestment.pct} inputMode="decimal" /></Field>
                  <Field label="Reinvestment treatment" htmlFor="rt" hint="Owner may switch; both options are implemented">
                    <Select id="rt" name="reinvestmentTreatment" defaultValue={profile.reinvestment.treatment}><option value="expense_no_credit">Expense, no partner credit</option><option value="credit_partners_pro_rata">Credit partners pro rata (claim on fund)</option></Select>
                  </Field>
                  {profile.partners.map((p) => <Field key={p.partnerId} label={`${p.label} share %`} htmlFor={`s-${p.partnerId}`}><Input id={`s-${p.partnerId}`} name={`share:${p.partnerId}`} defaultValue={p.sharePct} inputMode="decimal" /></Field>)}
                </Section>
                <Section title="Withdrawal cap and cash">
                  <label className="flex items-center gap-2 self-end pb-2.5 text-sm"><input type="checkbox" name="capEnabled" defaultChecked={profile.withdrawalCap.enabled} className="size-4" /> Cap enabled</label>
                  <Field label="Cap per partner per month (PKR)" htmlFor="ca"><Input id="ca" name="capAmount" defaultValue={toPKRString(profile.withdrawalCap.perPartnerMinor)} inputMode="decimal" /></Field>
                  <Field label="Cap months (from term start)" htmlFor="cm"><Input id="cm" name="capMonths" defaultValue={profile.withdrawalCap.months} inputMode="numeric" /></Field>
                  <Field label="Cash buffer days" htmlFor="bd"><Input id="bd" name="bufferDays" defaultValue={profile.cashSafeguards.bufferDays} inputMode="numeric" /></Field>
                </Section>
                <Section title="Revenue, periods and finality">
                  <Field label="Revenue recognized when" htmlFor="re"><Select id="re" name="recognitionEvent" defaultValue={profile.revenueRecognition.event}><option value="delivered">Delivered</option><option value="delivered_and_paid">Delivered and paid</option><option value="delivered_and_cod_settled">Delivered and COD settled</option></Select></Field>
                  <Field label="Close day of month" htmlFor="cd"><Input id="cd" name="closeDay" defaultValue={profile.reporting.closeDayOfMonth} inputMode="numeric" /></Field>
                  <Field label="Payout target day" htmlFor="pd"><Input id="pd" name="payoutDay" defaultValue={profile.reporting.payoutTargetDayOfMonth} inputMode="numeric" /></Field>
                  <Field label="Auto-final after (days)" htmlFor="fd"><Input id="fd" name="finalDays" defaultValue={profile.finalization.days} inputMode="numeric" /></Field>
                  <Field label="Objection window (days)" htmlFor="od"><Input id="od" name="objectionDays" defaultValue={profile.finalization.objectionWindowDays} inputMode="numeric" /></Field>
                  <Field label="Stock valuation" htmlFor="sv"><Select id="sv" name="valuation" defaultValue={profile.stock.valuation}><option value="weighted_average">Weighted average</option><option value="fifo">FIFO</option></Select></Field>
                  <Field label="COGS estimate (no order detail)" htmlFor="fbm"><Select id="fbm" name="fallbackMode" defaultValue={profile.matching.fallbackCogs.mode}><option value="ratio">% of COD</option><option value="per_unit">Per unit (single-price catalogue)</option></Select></Field>
                  <Field label="Unit price (PKR)" htmlFor="fbp" hint="Per-unit mode: units = COD ÷ price"><Input id="fbp" name="unitPrice" inputMode="decimal" defaultValue={profile.matching.fallbackCogs.unitPriceMinor ? toPKRString(profile.matching.fallbackCogs.unitPriceMinor) : ""} /></Field>
                  <Field label="Unit cost (PKR)" htmlFor="fbc"><Input id="fbc" name="unitCost" inputMode="decimal" defaultValue={profile.matching.fallbackCogs.unitCostMinor != null ? toPKRString(profile.matching.fallbackCogs.unitCostMinor) : ""} /></Field>
                  <Field label="COGS % of COD (ratio mode)" htmlFor="fbr"><Input id="fbr" name="fallbackPct" inputMode="decimal" defaultValue={(profile.matching.fallbackCogsRatioBps["*"] ?? 0) / 100} /></Field>
                  <label className="flex items-center gap-2 self-end pb-2.5 text-sm"><input type="checkbox" name="returnsRecoverable" defaultChecked={profile.stock.returnsRecoverable} className="size-4" /> Returned goods can be resold</label>
                  <label className="flex items-center gap-2 self-end pb-2.5 text-sm"><input type="checkbox" name="unmatchedBlocks" defaultChecked={profile.matching.unmatchedBlocksClose} className="size-4" /> Unmatched shipments block close</label>
                </Section>
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Expense categories</h3>
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-sm">
                      <thead><tr className="bg-muted/50 text-left text-xs text-muted-foreground"><th className="px-3 py-2">Category</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Enabled</th><th className="px-3 py-2">Emergency pause</th></tr></thead>
                      <tbody>
                        {profile.expenseCategories.map((c) => (
                          <tr key={c.key} className="border-t">
                            <td className="px-3 py-2">{c.label} <span className="font-mono text-xs text-muted-foreground">{c.key}</span></td>
                            <td className="px-3 py-2">{c.type}</td>
                            <td className="px-3 py-2">{c.type === "system" ? <Badge>engine</Badge> : <input type="checkbox" name={`cat:${c.key}`} defaultChecked={c.enabled} aria-label={`Enable ${c.label}`} className="size-4" />}</td>
                            <td className="px-3 py-2">{c.type === "system" ? null : <input type="checkbox" name={`pause:${c.key}`} defaultChecked={c.paused} aria-label={`Pause ${c.label}`} className="size-4" />}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">Overhead stays excluded from profit until a signed allocation exists. Add new categories via the JSON editor.</p>
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Approval limits</h3>
                  <p className="mb-2 text-xs text-muted-foreground">Blank or 0 = always requires approval (silence is not approval). Above the limit always requires approval.</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {profile.approvalPolicy.map((r) => (
                      <Field key={r.action + (r.scope ?? "")} label={`${r.action.replace(/_/g, " ")}${r.scope ? ` (${r.scope.replace(/_/g, " ")})` : ""} → ${r.approvers.join(" + ")}`} htmlFor={`l-${r.action}-${r.scope ?? ""}`}>
                        <Input id={`l-${r.action}-${r.scope ?? ""}`} name={`limit:${r.action}:${r.scope ?? ""}`} defaultValue={r.limitMinor == null ? "" : toPKRString(r.limitMinor)} inputMode="decimal" placeholder="No limit" />
                      </Field>
                    ))}
                  </div>
                </div>
                <div className="grid gap-3 border-t pt-4 sm:grid-cols-[200px_1fr_auto] sm:items-end">
                  <Field label="Effective from" htmlFor="ef" hint={`Must be after the last closed period`}><Input id="ef" name="effectiveFrom" type="date" defaultValue={nextEff} required /></Field>
                  <Field label="Change note" htmlFor="cn"><Input id="cn" name="changeNote" placeholder="Why this change" required /></Field>
                  <Submit>Create draft version</Submit>
                </div>
              </fieldset>
            </ActionForm>
          </CardBody>
        </Card>
        <div className="grid content-start gap-4">
          <Card>
            <CardHeader title="Version history" />
            <Table>
              <thead><tr><Th>Version</Th><Th>Effective</Th><Th>Status</Th></tr></thead>
              <tbody>{versions.filter((v) => !v.discardedAt).map((v) => <tr key={v._id}><Td>v{v.version}<div className="max-w-40 truncate text-xs text-muted-foreground">{v.changeNote}</div></Td><Td>{v.effectiveFrom}</Td><Td><StatusBadge status={v.status} /></Td></tr>)}</tbody>
            </Table>
          </Card>
          {canPropose ? (
            <Card>
              <CardHeader title="Advanced: full JSON" description="Every setting, validated with the same schema before saving." />
              <CardBody>
                <ActionForm action={draftFromJson} className="grid gap-3">
                  <Textarea name="json" rows={18} defaultValue={JSON.stringify({ ...json, effectiveFrom: nextEff }, null, 2)} aria-label="Profile JSON" spellCheck={false} />
                  <Input name="changeNote" placeholder="Change note" required aria-label="Change note" />
                  <Submit variant="outline">Create draft from JSON</Submit>
                </ActionForm>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </div>
  );
}

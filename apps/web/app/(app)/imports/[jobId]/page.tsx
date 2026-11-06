import { notFound } from "next/navigation";
import { BOOKING_TARGETS, getDb, ORG_ID, previewImport, SETTLEMENT_TARGETS } from "@delta/db";
import { Badge, Card, CardBody, CardHeader, Field, Input, Notice, PageHeader, Select, StatusBadge, Table, Td, Th } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { requireUser } from "@/lib/session";
import { pkr } from "@/lib/utils";
import { confirm, saveMapping } from "./actions";

export const metadata = { title: "Import preview" };

export default async function ImportPreview({ params }: { params: Promise<{ jobId: string }> }) {
  await requireUser("import:upload");
  const { jobId } = await params;
  let pv: Awaited<ReturnType<typeof previewImport>>;
  try {
    pv = await previewImport(ORG_ID, jobId);
  } catch {
    notFound();
  }
  const db = await getDb();
  const courier = await db.collection("couriers").findOne({ _id: pv.job.courierId as never });
  const targets = pv.kind === "booking" ? BOOKING_TARGETS : SETTLEMENT_TARGETS;
  const posted = pv.job.status === "posted";
  const counts = pv.lines.reduce<Record<string, number>>((a, l) => ((a[l.flag] = (a[l.flag] ?? 0) + 1), a), {});

  return (
    <>
      <PageHeader title={`${pv.kind === "booking" ? "Booking list" : "COD settlement"} import`} description={`${pv.job.fileName} · ${courier?.label ?? ""} · ${pv.job.rows.length} rows · file hash ${String(pv.job.fileHash).slice(0, 12)}…`} />
      {posted ? <div className="mb-4"><Notice tone="positive">Imported. Re-uploading the same file will be rejected, so nothing can post twice.</Notice></div> : null}

      <Card className="mb-4">
        <CardHeader title="1. Column mapping" description="Saved per courier and versioned, so the next file maps automatically." />
        <CardBody>
          <ActionForm action={saveMapping} className="grid gap-3">
            <input type="hidden" name="jobId" value={jobId} />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Object.keys(targets).map((t) => (
                <Field key={t} label={t.replace(/_/g, " ")} htmlFor={`m-${t}`}>
                  <Select id={`m-${t}`} name={`map:${t}`} defaultValue={pv.job.mapping[t] ?? ""} disabled={posted}>
                    <option value="">— not in file —</option>
                    {pv.job.headers.map((h: string) => <option key={h} value={h}>{h}</option>)}
                  </Select>
                </Field>
              ))}
            </div>
            {!posted ? <div><Submit variant="outline" size="sm">Apply mapping</Submit></div> : null}
          </ActionForm>
        </CardBody>
      </Card>

      {pv.kind === "settlement" ? (
        <Card className="mb-4">
          <CardHeader title="2. Match lines to shipments" description="Only lines matching a delivered, unsettled shipment are posted. Others are kept as exceptions for review." action={<div className="flex flex-wrap gap-1">{Object.entries(counts).map(([k, v]) => <span key={k}><StatusBadge status={k} /> <span className="text-xs tabular-nums">{v}</span></span>)}</div>} />
          <Table>
            <thead><tr><Th>CN</Th><Th align="right">COD (file)</Th><Th align="right">Expected</Th><Th align="right">Freight</Th><Th align="right">COD fee</Th><Th align="right">Return fee</Th><Th>Result</Th></tr></thead>
            <tbody>
              {pv.lines.slice(0, 300).map((l) => (
                <tr key={l.lineKey}>
                  <Td mono>{l.cn}</Td>
                  <Td align="right">{pkr(l.codMinor)}</Td>
                  <Td align="right">{pkr(l.expectedCodMinor)}</Td>
                  <Td align="right">{pkr(l.freightMinor)}</Td>
                  <Td align="right">{pkr(l.codFeeMinor)}</Td>
                  <Td align="right">{pkr(l.returnFeeMinor)}</Td>
                  <Td><StatusBadge status={l.flag} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {pv.lines.length > 300 ? <p className="px-5 py-2 text-xs text-muted-foreground">Showing first 300 of {pv.lines.length} lines.</p> : null}
        </Card>
      ) : (
        <Card className="mb-4">
          <CardHeader title="2. Preview" description={`${pv.rows.filter((r) => !r.errors.length).length} valid rows, ${pv.rows.filter((r) => r.errors.length).length} with errors`} />
          <Table>
            <thead><tr><Th>CN</Th><Th>Order ref</Th><Th align="right">COD</Th><Th>Consignee</Th><Th>City</Th><Th>Status</Th><Th>Errors</Th></tr></thead>
            <tbody>
              {pv.rows.slice(0, 300).map((r) => (
                <tr key={r.i}>
                  <Td mono>{r.cn}</Td><Td>{r.order_ref}</Td><Td align="right">{pkr(r.codMinor)}</Td><Td>{r.consignee_name}</Td><Td>{r.city}</Td><Td>{r.status}</Td>
                  <Td>{r.errors.length ? <Badge tone="negative">{r.errors.join(", ")}</Badge> : <Badge tone="positive">ok</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {!posted ? (
        <Card>
          <CardHeader title="3. Confirm" description={pv.kind === "settlement" ? "Posts the settlement to the ledger exactly once (keyed on courier + reference)." : "Creates or updates shipments and starts tracking."} />
          <CardBody>
            <ActionForm action={confirm} className="grid gap-3 sm:grid-cols-4 sm:items-end" confirm={pv.kind === "settlement" ? "Post this settlement to the ledger?" : undefined}>
              <input type="hidden" name="jobId" value={jobId} />
              {pv.kind === "settlement" ? (
                <>
                  <Field label="Remittance reference" htmlFor="ref"><Input id="ref" name="reference" defaultValue={pv.suggestedReference} required /></Field>
                  <Field label="Payment date" htmlFor="date"><Input id="date" name="date" type="date" defaultValue={/^\d{4}-\d{2}-\d{2}/.test(pv.suggestedDate ?? "") ? pv.suggestedDate!.slice(0, 10) : ""} required /></Field>
                  <Field label="Net received (PKR)" htmlFor="net" hint="From the bank statement; blank = computed from lines"><Input id="net" name="netReceived" inputMode="decimal" /></Field>
                </>
              ) : null}
              <Submit>{pv.kind === "settlement" ? "Post settlement" : "Import shipments"}</Submit>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}

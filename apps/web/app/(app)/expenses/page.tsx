import Link from "next/link";
import { getCurrentProfile, getDb, ORG_ID } from "@delta/db";
import { karachiDate } from "@delta/core";
import { Card, CardBody, CardHeader, Empty, Field, Input, Notice, PageHeader, Pagination, Select, StatusBadge, Table, Td, Th } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { FilterBar, FInput, FSelect } from "@/components/filters";
import { has, requireUser } from "@/lib/session";
import { day, pkr, qs } from "@/lib/utils";
import { addExpense } from "./actions";

export const metadata = { title: "Expenses" };
const PAGE = 50;

export default async function Expenses({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const u = await requireUser("profit:view");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1));
  const db = await getDb();
  const profile = await getCurrentProfile();
  const q: Record<string, unknown> = { orgId: ORG_ID };
  if (sp.status) q.status = sp.status;
  if (sp.category) q.categoryKey = sp.category;
  if (sp.from || sp.to) q.date = { ...(sp.from ? { $gte: sp.from } : {}), ...(sp.to ? { $lte: sp.to } : {}) };
  const [rows, total, stores] = await Promise.all([
    db.collection("expenses").find(q).sort({ date: -1, createdAt: -1 }).skip((page - 1) * PAGE).limit(PAGE).toArray(),
    db.collection("expenses").countDocuments(q),
    db.collection("stores").find({ orgId: ORG_ID }).toArray(),
  ]);
  const cats = profile.expenseCategories.filter((c) => c.enabled && c.type !== "system");
  const label = new Map(profile.expenseCategories.map((c) => [c.key, c.label]));

  return (
    <>
      <PageHeader title="Expenses" description="Manual expenses with receipts. Every expense is checked against the approval policy; silence is not approval." />
      <div className="grid gap-4 xl:grid-cols-[380px_1fr]">
        {has(u, "expense:create") ? (
          <Card className="self-start">
            <CardHeader title="New expense" />
            <CardBody>
              <ActionForm action={addExpense} className="grid gap-3" resetOnSuccess>
                <Field label="Category" htmlFor="cat">
                  <Select id="cat" name="categoryKey" required>
                    {cats.map((c) => <option key={c.key} value={c.key} disabled={c.paused}>{c.label}{c.paused ? " (paused)" : ""}</option>)}
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Amount (PKR)" htmlFor="amount"><Input id="amount" name="amount" inputMode="decimal" placeholder="15000" required /></Field>
                  <Field label="Date" htmlFor="date"><Input id="date" name="date" type="date" defaultValue={karachiDate()} required /></Field>
                </div>
                <Field label="Payee" htmlFor="payee"><Input id="payee" name="payee" required /></Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Store" htmlFor="store"><Select id="store" name="storeId"><option value="">Division-wide</option>{stores.map((s) => <option key={String(s._id)} value={String(s._id)}>{s.name}</option>)}</Select></Field>
                  <Field label="Paid from" htmlFor="paidFrom"><Select id="paidFrom" name="paidFrom"><option value="bank">Bank</option><option value="cash">Cash</option><option value="accounts_payable">Unpaid (payable)</option><option value="card_payable">Card</option></Select></Field>
                </div>
                <Field label="Memo" htmlFor="memo"><Input id="memo" name="memo" /></Field>
                <Field label="Receipts" htmlFor="receipts" hint="JPG, PNG, PDF · max 10 MB each"><Input id="receipts" name="receipts" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" className="py-1.5" /></Field>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="recurring" className="size-4" /> New recurring cost (needs both partners)</label>
                <Notice>A partner&apos;s personal income tax is never a venture expense and will be rejected.</Notice>
                <Submit>Submit expense</Submit>
              </ActionForm>
            </CardBody>
          </Card>
        ) : null}
        <div>
          <FilterBar>
            <FSelect name="status" label="Status" value={sp.status} options={["pending", "posted", "rejected"].map((s) => ({ value: s, label: s }))} />
            <FSelect name="category" label="Category" value={sp.category} options={profile.expenseCategories.map((c) => ({ value: c.key, label: c.label }))} />
            <FInput name="from" label="From" type="date" value={sp.from} />
            <FInput name="to" label="To" type="date" value={sp.to} />
          </FilterBar>
          <Card>
            <Table>
              <thead><tr><Th>Date</Th><Th>Category</Th><Th>Payee</Th><Th>Requested by</Th><Th align="right">Amount</Th><Th>Status</Th><Th>Ledger</Th></tr></thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={String(e._id)} className="hover:bg-muted/40">
                    <Td>{day(e.date)}</Td><Td>{label.get(e.categoryKey) ?? e.categoryKey}</Td>
                    <Td>{e.payee}{e.receipts?.length ? <div className="text-xs text-muted-foreground">{e.receipts.length} receipt(s)</div> : null}</Td>
                    <Td>{e.requesterName}</Td><Td align="right">{pkr(e.amountMinor)}</Td><Td><StatusBadge status={e.status} /></Td>
                    <Td>{e.journalEntryId ? <Link className="text-[13px] text-primary hover:underline" href={`/journal?entry=${e.journalEntryId}`}>Entry</Link> : e.approvalId ? <Link className="text-[13px] text-primary hover:underline" href="/approvals">Approval</Link> : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {rows.length === 0 ? <Empty title="No expenses" /> : null}
            <Pagination page={page} pageSize={PAGE} total={total} hrefFor={(p) => qs(sp, { page: String(p) })} />
          </Card>
        </div>
      </div>
    </>
  );
}

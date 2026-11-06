import { getDb, ORG_ID, balances, crBal } from "@delta/db";
import { karachiDate } from "@delta/core";
import { Card, CardBody, CardHeader, Empty, Field, Input, Line, Notice, PageHeader, Select, StatusBadge, Table, Td, Th } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { FilterBar, FInput, FSelect } from "@/components/filters";
import { has, requireUser } from "@/lib/session";
import { pkr } from "@/lib/utils";
import { assign, payCard } from "./actions";

export const metadata = { title: "Ads" };

export default async function Ads({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const u = await requireUser("profit:view");
  const sp = await searchParams;
  const today = karachiDate();
  const from = sp.from ?? `${today.slice(0, 7)}-01`;
  const to = sp.to ?? today;
  const db = await getDb();
  const [accounts, stores] = await Promise.all([db.collection("ad_accounts").find({ orgId: ORG_ID }).toArray(), db.collection("stores").find({ orgId: ORG_ID }).toArray()]);
  const match: Record<string, unknown> = { orgId: ORG_ID, date: { $gte: from, $lte: to } };
  if (sp.account) match.adAccountId = sp.account;
  const byCampaign = await db.collection("ad_spend_daily").aggregate<{ _id: { a: string; c: string }; name: string; spend: number; rev: number; purchases: number; allocation: string; storeId: string | null }>([
    { $match: match },
    { $group: { _id: { a: "$adAccountId", c: "$campaignId" }, name: { $last: "$campaignName" }, spend: { $sum: "$spendMinor" }, rev: { $sum: "$revenueMinor" }, purchases: { $sum: "$purchases" }, allocation: { $last: "$allocation" }, storeId: { $last: "$storeId" } } },
    { $sort: { spend: -1 } },
  ]).toArray();
  const unallocated = byCampaign.filter((c) => c.allocation === "unallocated");
  const b = await balances(ORG_ID, {});
  const cardPayable = crBal(b, "card_payable");
  const storeName = new Map(stores.map((s) => [String(s._id), s.name]));
  const canManage = has(u, "integrations:manage");

  return (
    <>
      <PageHeader title="Ads" description="Meta spend by campaign, recorded against the store that incurred it. PKR, paid by card: daily spend credits card payable; card bills debit it." />
      <FilterBar>
        <FInput name="from" label="From" type="date" value={from} />
        <FInput name="to" label="To" type="date" value={to} />
        <FSelect name="account" label="Ad account" value={sp.account} options={accounts.map((a) => ({ value: String(a._id), label: a.label }))} />
      </FilterBar>

      {unallocated.length ? (
        <Card className="mb-4">
          <CardHeader title={`Unallocated campaigns (${unallocated.length})`} description="Excluded from the division until assigned. Shared ad account: split by actual spend per campaign (agreement 5.4)." />
          <Table>
            <thead><tr><Th>Campaign</Th><Th align="right">Spend in range</Th><Th>Assign</Th></tr></thead>
            <tbody>
              {unallocated.map((c) => (
                <tr key={c._id.c}>
                  <Td>{c.name}<div className="font-mono text-xs text-muted-foreground">{c._id.c}</div></Td>
                  <Td align="right">{pkr(c.spend)}</Td>
                  <Td>
                    {canManage ? (
                      <ActionForm action={assign} className="flex flex-wrap gap-2">
                        <input type="hidden" name="adAccountId" value={c._id.a} />
                        <input type="hidden" name="campaignId" value={c._id.c} />
                        <Select name="target" className="h-8 w-56 text-[13px]" aria-label="Assign to">
                          {stores.map((s) => <option key={String(s._id)} value={`local-ecom:${s._id}`}>This division — {s.name}</option>)}
                          <option value="other:">Another Delta Labs division (exclude)</option>
                        </Select>
                        <Submit size="xs" variant="outline">Assign</Submit>
                      </ActionForm>
                    ) : <StatusBadge status="unallocated" />}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Spend by campaign" description="ROAS is Meta-attributed and informational only; profit uses delivered and settled revenue." />
          <Table>
            <thead><tr><Th>Campaign</Th><Th>Store</Th><Th>Allocation</Th><Th align="right">Spend</Th><Th align="right">Purchases (Meta)</Th><Th align="right">ROAS (Meta)</Th></tr></thead>
            <tbody>
              {byCampaign.map((c) => (
                <tr key={c._id.a + c._id.c}>
                  <Td>{c.name}</Td><Td>{c.storeId ? storeName.get(c.storeId) : "—"}</Td><Td><StatusBadge status={c.allocation === "division" ? "active" : c.allocation} /></Td>
                  <Td align="right">{pkr(c.spend)}</Td><Td align="right">{c.purchases}</Td><Td align="right">{c.spend ? (c.rev / c.spend).toFixed(2) + "×" : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {byCampaign.length === 0 ? <Empty title="No ad spend in this range" /> : null}
        </Card>
        <Card>
          <CardHeader title="Card payable" description="Ad spend and card payments reconcile separately." />
          <CardBody>
            <Line label="Outstanding on card" value={pkr(cardPayable)} strong />
            {has(u, "withdrawal:pay") ? (
              <ActionForm action={payCard} className="mt-4 grid gap-3" resetOnSuccess>
                <Field label="Card bill paid (PKR)" htmlFor="amt"><Input id="amt" name="amount" inputMode="decimal" required /></Field>
                <Field label="Date" htmlFor="d"><Input id="d" name="date" type="date" defaultValue={today} required /></Field>
                <Field label="Bank reference" htmlFor="ref"><Input id="ref" name="ref" required /></Field>
                <Submit variant="outline">Record payment</Submit>
              </ActionForm>
            ) : <div className="mt-3"><Notice>Only the finance reviewer or owner records card payments.</Notice></div>}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

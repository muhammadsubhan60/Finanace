import { getCurrentProfile, getDb, ORG_ID } from "@delta/db";
import { addMonths, karachiDate, periodIdOf } from "@delta/core";
import { Card, CardBody, CardHeader, Empty, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { has, requireUser } from "@/lib/session";
import { day, pkr } from "@/lib/utils";
import { count, purchase, recompute } from "./actions";

export const metadata = { title: "Stock" };

export default async function Stock() {
  const u = await requireUser("profit:view");
  const db = await getDb();
  const profile = await getCurrentProfile();
  const [items, moves] = await Promise.all([
    db.collection("stock_items").find({ orgId: ORG_ID }).sort({ sku: 1 }).toArray(),
    db.collection("stock_movements").find({ orgId: ORG_ID }).sort({ createdAt: -1 }).limit(30).toArray(),
  ]);
  const total = items.reduce((s, i) => s + (i.valueMinor ?? 0), 0);
  const manage = has(u, "stock:manage");
  const lastMonth = addMonths(periodIdOf(karachiDate()), -1);
  return (
    <>
      <PageHeader
        title="Stock"
        description={`Simple stock ledger. Valuation: ${profile.stock.valuation.replace("_", " ")} (configurable). Unsold stock is held at the lower of cost and recoverable value.`}
        actions={manage ? <ActionForm action={recompute} confirm="Re-estimate COGS for unmatched shipments using the current profile and post true-ups?"><Submit variant="outline" size="sm">Recompute estimated COGS</Submit></ActionForm> : null}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="On hand" description={`Total value ${pkr(total)}`} />
          <Table>
            <thead><tr><Th>SKU</Th><Th>Item</Th><Th align="right">On hand</Th><Th align="right">Avg cost</Th><Th align="right">Value</Th></tr></thead>
            <tbody>
              {items.map((i) => <tr key={String(i._id)}><Td mono>{i.sku}</Td><Td>{i.title}</Td><Td align="right">{i.onHand}</Td><Td align="right">{pkr(i.avgCostMinor)}</Td><Td align="right">{pkr(i.valueMinor)}</Td></tr>)}
            </tbody>
          </Table>
          {items.length === 0 ? <Empty title="No stock items" /> : null}
        </Card>
        {manage ? (
          <Card>
            <CardHeader title="Record purchase" />
            <CardBody>
              <ActionForm action={purchase} className="grid gap-3" resetOnSuccess>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="SKU" htmlFor="sku"><Input id="sku" name="sku" required /></Field>
                  <Field label="Quantity" htmlFor="qty"><Input id="qty" name="quantity" inputMode="numeric" required /></Field>
                </div>
                <Field label="Item name" htmlFor="title"><Input id="title" name="title" required /></Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Total cost (PKR)" htmlFor="cost"><Input id="cost" name="totalCost" inputMode="decimal" required /></Field>
                  <Field label="Date" htmlFor="date"><Input id="date" name="date" type="date" defaultValue={karachiDate()} required /></Field>
                </div>
                <Field label="Paid from" htmlFor="pf"><Select id="pf" name="paidFrom"><option value="bank">Bank</option><option value="accounts_payable">Supplier credit (payable)</option></Select></Field>
                <Submit variant="outline">Record purchase</Submit>
              </ActionForm>
            </CardBody>
          </Card>
        ) : null}
      </div>
      {manage && items.length ? (
        <Card className="mt-4">
          <CardHeader title="Stock count" description="Differences post as count loss/gain; enter a recoverable unit value below cost to write down. Satisfies the close checklist for the chosen period." />
          <CardBody>
            <ActionForm action={count} className="grid gap-3">
              <Field label="For period" htmlFor="cperiod" className="max-w-48"><Input id="cperiod" name="periodId" defaultValue={lastMonth} pattern="\d{4}-\d{2}" required /></Field>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {items.map((i) => (
                  <div key={String(i._id)} className="rounded-md border p-3">
                    <div className="text-sm font-medium">{i.sku} <span className="font-normal text-muted-foreground">book {i.onHand}</span></div>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <Input name={`count:${i.sku}`} defaultValue={i.onHand} inputMode="numeric" aria-label={`Counted ${i.sku}`} />
                      <Input name={`recov:${i.sku}`} placeholder="Recoverable/unit" inputMode="decimal" aria-label={`Recoverable value per unit ${i.sku}`} />
                    </div>
                  </div>
                ))}
              </div>
              <div><Submit variant="outline">Record count</Submit></div>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}
      <Card className="mt-4">
        <CardHeader title="Recent movements" />
        <Table>
          <thead><tr><Th>Date</Th><Th>SKU</Th><Th>Type</Th><Th align="right">Qty</Th><Th align="right">Value</Th></tr></thead>
          <tbody>{moves.map((m) => <tr key={String(m._id)}><Td>{day(m.date)}</Td><Td mono>{m.sku}</Td><Td>{m.type.replace("_", " ")}</Td><Td align="right">{m.quantity}</Td><Td align="right">{pkr(m.valueMinor)}</Td></tr>)}</tbody>
        </Table>
      </Card>
    </>
  );
}

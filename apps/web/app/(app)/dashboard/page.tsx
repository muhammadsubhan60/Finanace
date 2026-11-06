import Link from "next/link";
import { dashboard, getDb, ORG_ID } from "@delta/db";
import { addDays, karachiDate, METRIC_DEFINITIONS as D } from "@delta/core";
import { Badge, Card, CardBody, CardHeader, Line, Notice, PageHeader, Stat } from "@/components/ui";
import { FilterBar, FInput, FSelect } from "@/components/filters";
import { SalesAdsChart } from "@/components/charts";
import { requireUser } from "@/lib/session";
import { pct, pkr } from "@/lib/utils";

export const metadata = { title: "Dashboard" };

export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireUser("dashboard:view");
  const sp = await searchParams;
  const today = karachiDate();
  const from = sp.from ?? `${today.slice(0, 7)}-01`;
  const to = sp.to ?? today;
  const f = { from, to, storeId: sp.store || undefined, courierId: sp.courier || undefined, adAccountId: sp.ad || undefined };
  const db = await getDb();
  const [d, stores, couriers, adAccts, alerts] = await Promise.all([
    dashboard(ORG_ID, f),
    db.collection("stores").find({ orgId: ORG_ID }).toArray(),
    db.collection("couriers").find({ orgId: ORG_ID }).toArray(),
    db.collection("ad_accounts").find({ orgId: ORG_ID }).toArray(),
    db.collection("alerts").find({ orgId: ORG_ID, acknowledgedAt: null }).sort({ createdAt: -1 }).limit(6).toArray(),
  ]);
  const range = `from=${from}&to=${to}`;
  const salesByDay = new Map(d.series.map((s) => [s._id, s.value]));
  const adsByDay = new Map(d.ads.series.map((s) => [s._id, s.spend]));
  const days: string[] = [];
  for (let x = from; x <= to; x = addDays(x, 1)) days.push(x);
  const chart = days.map((date) => ({ date, sales: salesByDay.get(date) ?? 0, ads: adsByDay.get(date) ?? 0 }));

  return (
    <>
      <PageHeader title="Dashboard" description={`Live position for ${from} to ${to}. Net Profit to date is an engine estimate on ledger data so far, not a final figure.`} />
      <FilterBar>
        <FInput name="from" label="From" type="date" value={from} />
        <FInput name="to" label="To" type="date" value={to} />
        <FSelect name="store" label="Store" value={sp.store} options={stores.map((s) => ({ value: String(s._id), label: s.name }))} />
        <FSelect name="courier" label="Courier" value={sp.courier} options={couriers.map((c) => ({ value: String(c._id), label: c.label }))} />
        <FSelect name="ad" label="Ad account" value={sp.ad} options={adAccts.map((a) => ({ value: String(a._id), label: a.label }))} />
      </FilterBar>

      <section aria-label="Sales" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Gross sales (delivered)" value={pkr(d.sales.grossMinor)} sub={`${d.funnel.delivered} delivered shipments`} href={`/shipments?status=delivered&${range}`} definition={D.gross_sales} />
        <Stat label="Net sales (recognized)" value={pkr(d.sales.netMinor)} sub="Per profile recognition event" href={`/journal?account=sales&${range}`} definition={D.net_sales} />
        <Stat label="Orders" value={d.sales.orders.toLocaleString()} sub={`${d.sales.shipments} shipments booked`} href={`/orders?${range}`} definition={D.orders} />
        <Stat label="AOV" value={pkr(d.sales.aovMinor)} href={`/shipments?status=delivered&${range}`} definition={D.aov} />
      </section>

      <div className="mt-3 grid gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Delivered sales and ad spend" description="Solid area: delivered COD value by delivery date · Dashed line: allocated ad spend" />
          <CardBody>
            <SalesAdsChart data={chart} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Fulfilment funnel" description="Shipments booked in the range" />
          <CardBody className="grid gap-3">
            {[
              ["Booked", d.funnel.booked, ""],
              ["In transit", d.funnel.inTransit, "in_transit"],
              ["Delivered", d.funnel.delivered, "delivered"],
              ["Returned (RTO)", d.funnel.rto, "returned_to_origin"],
            ].map(([label, n, status]) => (
              <Link key={label as string} href={`/shipments?${status ? `status=${status}&` : ""}${range}`} className="group grid gap-1">
                <div className="flex justify-between text-sm">
                  <span className="group-hover:underline underline-offset-4">{label}</span>
                  <span className="tabular-nums font-medium">{(n as number).toLocaleString()}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className={label === "Returned (RTO)" ? "h-full bg-negative" : "h-full bg-primary"} style={{ width: `${d.funnel.booked ? Math.round(((n as number) / d.funnel.booked) * 100) : 0}%` }} />
                </div>
              </Link>
            ))}
            <div className="mt-1 grid grid-cols-3 gap-2 border-t pt-3 text-center">
              <Mini label="Delivery rate" value={pct(d.funnel.deliveryRate)} def={D.delivery_rate} />
              <Mini label="RTO rate" value={pct(d.funnel.rtoRate)} def={D.rto_rate} tone={d.funnel.rtoRate && d.funnel.rtoRate > 0.25 ? "negative" : undefined} />
              <Mini label="Avg days" value={d.funnel.avgDeliveryDays ? d.funnel.avgDeliveryDays.toFixed(1) : "—"} def={D.avg_delivery_days} />
            </div>
          </CardBody>
        </Card>
      </div>

      <section aria-label="COD and ads" className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="COD in transit" value={pkr(d.cod.inTransitMinor)} href="/cod?view=in_transit" definition={D.cod_in_transit} />
        <Stat label="Delivered, unsettled" value={pkr(d.cod.deliveredUnsettledMinor)} sub={Object.entries(d.cod.aging).map(([k, v]) => `${k}d ${pkr(v)}`).join(" · ") || "No aging"} href="/cod?view=unsettled" definition={D.cod_delivered_unsettled} tone={d.cod.deliveredUnsettledMinor > 0 ? "warning" : undefined} />
        <Stat label="Settled" value={pkr(d.cod.settledMinor)} href="/cod?view=settlements" definition={D.cod_settled} />
        <Stat label="Disputed lines" value={pkr(d.cod.disputedMinor)} href="/cod?view=exceptions" tone={d.cod.disputedMinor ? "negative" : undefined} definition="COD value on settlement lines flagged for review (unknown CN, already settled, not delivered, amount differs)." />
        <Stat label="Ad spend" value={pkr(d.ads.spendMinor)} href={`/ads?${range}`} definition={D.ad_spend} />
        <Stat label="MER" value={d.ads.mer == null ? "—" : `${d.ads.mer.toFixed(2)}×`} sub={`ROAS (Meta) ${d.ads.roas == null ? "—" : d.ads.roas.toFixed(2) + "×"}`} definition={`${D.mer} ${D.roas}`} />
        <Stat label="CPA (delivered)" value={pkr(d.ads.cpaDeliveredMinor)} definition={D.cpa_delivered} />
        <Stat label="Contribution margin" value={pkr(d.margin.contributionMinor)} tone={d.margin.contributionMinor < 0 ? "negative" : "positive"} href={`/journal?${range}`} definition={D.contribution_margin} />
      </section>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Card>
          <CardHeader title="Profit and cash" description={<span>Estimate for {d.profitToDate.periodId} <Badge tone="warning">not final</Badge></span>} action={<Link className="text-xs text-primary hover:underline" href={`/periods/${d.profitToDate.periodId}`}>Statement</Link>} />
          <CardBody>
            <Line label="Net Profit to date" value={pkr(d.profitToDate.netProfitMinor)} strong />
            <Line label="Bank and cash" value={pkr(d.cash.bankMinor)} href="/journal?account=bank" />
            <Line label="Reserve required" value={pkr(d.cash.reserveMinor)} sub />
            <Line label="Reinvestment fund" value={pkr(d.cash.reinvestmentFundMinor)} sub href="/journal?account=reinvestment_fund" />
            <Line label="Distributable cash" value={pkr(d.cash.distributableMinor)} strong />
            {d.profitToDate.warnings.length ? <div className="mt-3 grid gap-1">{d.profitToDate.warnings.map((w) => <Notice key={w} tone="warning">{w}</Notice>)}</div> : null}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Partners" description="Allocations come only from closed periods" action={<Link className="text-xs text-primary hover:underline" href="/partners">Accounts</Link>} />
          <CardBody className="grid gap-4">
            {d.partners.map((p) => (
              <div key={p.partnerId}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{p.label}</span>
                  <span className="text-xs text-muted-foreground">{p.sharePct}%</span>
                </div>
                <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
                  <dt className="text-muted-foreground">Allocated to date</dt><dd className="text-right tabular-nums">{pkr(p.allocatedToDateMinor)}</dd>
                  <dt className="text-muted-foreground">Withdrawn this month</dt><dd className="text-right tabular-nums">{pkr(p.withdrawnThisMonthMinor)}</dd>
                  <dt className="text-muted-foreground">Cap remaining</dt><dd className="text-right tabular-nums">{p.capRemainingMinor == null ? "No cap" : pkr(p.capRemainingMinor)}</dd>
                  <dt className="text-muted-foreground">Undrawn balance</dt><dd className="text-right font-medium tabular-nums">{pkr(p.undrawnMinor)}</dd>
                </dl>
              </div>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Alerts" action={<Link className="text-xs text-primary hover:underline" href="/alerts">All alerts</Link>} />
          <CardBody className="grid gap-2">
            {alerts.length === 0 ? <p className="text-sm text-muted-foreground">Nothing needs attention.</p> : null}
            {alerts.map((a) => (
              <Link key={String(a._id)} href={a.href ?? "/alerts"} className="flex items-start gap-2 rounded-md p-2 hover:bg-muted">
                <Badge tone={a.severity === "critical" ? "negative" : a.severity === "warning" ? "warning" : "primary"}>{a.severity}</Badge>
                <span className="min-w-0 text-[13px]">
                  <span className="block font-medium">{a.title}</span>
                  <span className="block truncate text-muted-foreground">{a.detail}</span>
                </span>
              </Link>
            ))}
            {d.unmatched ? <Link href="/shipments/matching" className="text-[13px] text-primary hover:underline">{d.unmatched} shipments waiting for order matching</Link> : null}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function Mini({ label, value, def, tone }: { label: string; value: string; def: string; tone?: "negative" }) {
  return (
    <div title={def}>
      <div className={tone === "negative" ? "text-base font-semibold tabular-nums text-negative" : "text-base font-semibold tabular-nums"}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

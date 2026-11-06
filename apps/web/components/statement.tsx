import type { PeriodResult } from "@delta/core";
import { Line } from "./ui";
import { pkr } from "@/lib/utils";

/** Full statement: sales → profit waterfall, losses, reinvestment, allocations, cash line by line. */
export function Statement({ r, compare }: { r: PeriodResult; compare?: PeriodResult }) {
  const C = ({ v }: { v: (x: PeriodResult) => number }) =>
    compare ? (
      <span className="inline-flex gap-4">
        <span className="text-muted-foreground line-through decoration-muted-foreground/40">{pkr(v(compare))}</span>
        <span>{pkr(v(r))}</span>
      </span>
    ) : (
      <>{pkr(v(r))}</>
    );
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <section aria-label="Profit">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Profit</h3>
        <Line label="Gross sales (recognized)" value={<C v={(x) => x.netSales.grossMinor} />} href={`/journal?account=sales&period=${r.periodId}`} />
        {r.netSales.deductions.map((d) => <Line key={d.key} indent sub label={`Less ${d.key.replace("_", " ")}`} value={pkr(-d.minor)} />)}
        <Line strong label="Net sales" value={<C v={(x) => x.netSales.netMinor} />} />
        <Line label="Cost of goods sold" value={<C v={(x) => -x.cogsMinor} />} href={`/journal?account=exp_cogs&period=${r.periodId}`} />
        {r.opex.map((o) => <Line key={o.key} label={o.label} value={pkr(-o.minor)} href={`/journal?account=exp_${o.key}&period=${r.periodId}`} />)}
        <Line strong label="Profit before prior losses" value={<C v={(x) => x.profitBeforeLossesMinor} />} />
        <Line sub label={`Loss carried forward: opening ${pkr(r.loss.openingMinor)}, added ${pkr(r.loss.addedMinor)}`} value={pkr(-r.loss.appliedMinor)} />
        <Line strong label="Net Profit" value={<C v={(x) => x.netProfitMinor} />} />
        <Line label={`Reinvestment ${r.reinvestment.pct}% (${r.reinvestment.treatment.replace(/_/g, " ")})`} value={<C v={(x) => -x.reinvestment.minor} />} />
        <Line strong label="Shared Profit" value={<C v={(x) => x.sharedProfitMinor} />} />
        <Line sub label="Loss balance carried to next period" value={pkr(r.loss.closingMinor)} />
      </section>
      <section aria-label="Cash safeguards">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cash safeguards</h3>
        <Line label="Bank and cash" value={pkr(r.cash.bankAndCashMinor)} />
        <Line label="Less reinvestment fund (not distributable)" value={pkr(-r.cash.reinvestmentFundMinor)} />
        {r.cash.lines.map((l) => <Line key={l.key} indent label={`Less ${l.label.toLowerCase()}`} value={pkr(-l.minor)} />)}
        <Line sub label="Total reserve" value={pkr(r.cash.reserveMinor)} />
        <Line strong label="Distributable cash" value={pkr(r.cash.distributableMinor)} />
        <h3 className="mb-1 mt-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Partners</h3>
        <div className="grid gap-3">
          {r.partners.map((p) => (
            <div key={p.partnerId} className="rounded-md border p-3">
              <div className="mb-1 flex justify-between text-sm font-medium"><span>{p.label}</span><span className="text-muted-foreground">{p.sharePct}%</span></div>
              <Line label="Allocation" value={pkr(p.allocationMinor)} />
              {p.reinvestmentClaimMinor ? <Line sub label="Claim on reinvestment fund" value={pkr(p.reinvestmentClaimMinor)} /> : null}
              <Line sub label="Opening undrawn" value={pkr(p.openingUndrawnMinor)} />
              {p.nettingAppliedMinor ? <Line sub label="Over-distribution netting" value={pkr(-p.nettingAppliedMinor)} /> : null}
              <Line label="Share of distributable cash" value={pkr(p.cashShareMinor)} />
              <Line label={p.capApplies ? `Cap (${pkr(p.capMinor)})` : "Cap"} value={p.capApplies ? pkr(p.capRemainingMinor) : "Not in cap months"} />
              <Line strong label={`Withdrawable (limited by ${p.withdrawableLimitedBy})`} value={pkr(p.withdrawableMinor)} />
              <Line sub label="Withdrawn against this period" value={pkr(p.withdrawnThisPeriodMinor)} />
              <Line label="Undrawn balance after" value={pkr(p.closingUndrawnMinor)} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

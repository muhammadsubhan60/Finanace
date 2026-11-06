import { getSnapshot, ORG_ID } from "@delta/db";
import { toCsv, toPKRString } from "@delta/core";
import { getUser, has } from "@/lib/session";

export async function GET(_: Request, { params }: { params: Promise<{ periodId: string }> }) {
  const u = await getUser();
  if (!u || !has(u, "profit:view")) return new Response("Forbidden", { status: 403 });
  const { periodId } = await params;
  const s = await getSnapshot(ORG_ID, periodId);
  if (!s?.snapshot) return new Response("Not found", { status: 404 });
  const r = s.snapshot.result;
  const R = (n: number) => toPKRString(n);
  const rows: (string | number)[][] = [
    ["section", "line", "amount_pkr"],
    ["profit", "gross_sales", R(r.netSales.grossMinor)],
    ...r.netSales.deductions.map((d) => ["profit", `less_${d.key}`, R(-d.minor)]),
    ["profit", "net_sales", R(r.netSales.netMinor)],
    ["profit", "cogs", R(-r.cogsMinor)],
    ...r.opex.map((o) => ["profit", `opex_${o.key}`, R(-o.minor)]),
    ["profit", "profit_before_losses", R(r.profitBeforeLossesMinor)],
    ["profit", "prior_losses_applied", R(-r.loss.appliedMinor)],
    ["profit", "net_profit", R(r.netProfitMinor)],
    ["profit", "reinvestment", R(-r.reinvestment.minor)],
    ["profit", "shared_profit", R(r.sharedProfitMinor)],
    ["cash", "bank_and_cash", R(r.cash.bankAndCashMinor)],
    ["cash", "reinvestment_fund", R(-r.cash.reinvestmentFundMinor)],
    ...r.cash.lines.map((l) => ["cash", `reserve_${l.key}`, R(-l.minor)]),
    ["cash", "distributable", R(r.cash.distributableMinor)],
    ...r.partners.flatMap((p) => [
      ["partner", `${p.partnerId}_allocation`, R(p.allocationMinor)],
      ["partner", `${p.partnerId}_withdrawable`, R(p.withdrawableMinor)],
      ["partner", `${p.partnerId}_undrawn_after`, R(p.closingUndrawnMinor)],
    ]),
    [],
    ["footer", `profile v${s.snapshot.profileVersion}; engine ${s.snapshot.engineVersion}; generated ${new Date().toISOString()}; inputs hash ${s.snapshot.inputsHash}`, ""],
  ];
  return new Response(toCsv(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="statement-${periodId}.csv"` } });
}

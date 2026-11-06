import type { AgreementProfile } from "@delta/config-schema";
import { allocateByPct, applyPct, assertMinor, sum, type Minor } from "../money";
import { stableHash } from "../hash";
import { monthsBetween } from "../dates";

export const ENGINE_VERSION = "1.0.0";

/** Ledger-derived totals for one period. All money in paisa. */
export interface PeriodInput {
  periodId: string; // YYYY-MM
  periodStart: string; // YYYY-MM-DD
  /** True when the period starts after the agreement term ended (post-termination). */
  postTermination?: boolean;
  revenue: {
    grossSalesMinor: Minor;
    discountsMinor: Minor;
    refundsMinor: Minor;
    taxesCollectedMinor: Minor;
  };
  cogsMinor: Minor;
  inventoryWriteDownMinor: Minor;
  /** Expense totals keyed by category key. Unknown / disabled / non-deductible keys are ignored and warned. */
  expensesByCategory: Record<string, Minor>;
  /** Opening loss carried forward (≥ 0). */
  openingLossBalanceMinor: Minor;
  cash: {
    bankAndCashMinor: Minor;
    reinvestmentFundBalanceMinor: Minor;
    reserve: {
      knownLiabilitiesMinor: Minor;
      payrollDueMinor: Minor;
      taxesDueMinor: Minor;
      refundsExpectedMinor: Minor;
      courierReturnExposureMinor: Minor;
      fixedCostsNextBufferMinor: Minor;
      inventoryNeedsNextBufferMinor: Minor;
      extraReserveMinor?: Minor;
      extraReserveCalcRef?: string;
    };
  };
  partners: Record<
    string,
    {
      openingUndrawnMinor: Minor;
      withdrawnThisPeriodMinor: Minor;
      /** Netting receivable from earlier over-distribution (reduces what can be drawn). */
      nettingReceivableMinor: Minor;
    }
  >;
}

export interface PartnerResult {
  partnerId: string;
  label: string;
  sharePct: number;
  allocationMinor: Minor;
  reinvestmentClaimMinor: Minor;
  openingUndrawnMinor: Minor;
  availableMinor: Minor; // opening undrawn + allocation − netting
  nettingAppliedMinor: Minor;
  nettingRemainingMinor: Minor;
  capApplies: boolean;
  capMinor: Minor | null;
  capRemainingMinor: Minor | null;
  cashShareMinor: Minor;
  withdrawableMinor: Minor;
  withdrawableLimitedBy: "balance" | "cap" | "cash";
  withdrawnThisPeriodMinor: Minor;
  closingUndrawnMinor: Minor;
}

export interface PeriodResult {
  periodId: string;
  profileVersion: number;
  engineVersion: string;
  inputsHash: string;
  outputsHash: string;
  netSales: { grossMinor: Minor; deductions: { key: string; minor: Minor }[]; netMinor: Minor };
  cogsMinor: Minor;
  opex: { key: string; label: string; minor: Minor }[];
  opexTotalMinor: Minor;
  profitBeforeLossesMinor: Minor;
  loss: { openingMinor: Minor; addedMinor: Minor; appliedMinor: Minor; closingMinor: Minor };
  netProfitMinor: Minor;
  reinvestment: { pct: number; treatment: string; minor: Minor };
  sharedProfitMinor: Minor;
  cash: { lines: { key: string; label: string; minor: Minor }[]; reserveMinor: Minor; bankAndCashMinor: Minor; reinvestmentFundMinor: Minor; distributableMinor: Minor };
  partners: PartnerResult[];
  warnings: string[];
}

const RESERVE_LINES: { key: string; include: string; label: string; field: keyof PeriodInput["cash"]["reserve"] }[] = [
  { key: "known_liabilities", include: "known_liabilities", label: "Known liabilities", field: "knownLiabilitiesMinor" },
  { key: "payroll", include: "payroll", label: "Payroll due", field: "payrollDueMinor" },
  { key: "taxes", include: "taxes", label: "Taxes due", field: "taxesDueMinor" },
  { key: "refunds", include: "refunds", label: "Refunds expected", field: "refundsExpectedMinor" },
  { key: "courier_return_exposure", include: "courier_return_exposure", label: "Courier return exposure", field: "courierReturnExposureMinor" },
  { key: "fixed_costs", include: "fixed_costs_next_n_days", label: "Fixed costs, next buffer days", field: "fixedCostsNextBufferMinor" },
  { key: "inventory_needs", include: "inventory_needs_next_n_days", label: "Inventory needs, next buffer days", field: "inventoryNeedsNextBufferMinor" },
];

export function computePeriod(input: PeriodInput, profile: AgreementProfile): PeriodResult {
  const warnings: string[] = [];
  const nonNeg = (v: Minor, label: string) => {
    assertMinor(v, label);
    if (v < 0) throw new Error(`${label} must be ≥ 0`);
  };
  nonNeg(input.openingLossBalanceMinor, "openingLossBalance");

  // 1. Net sales
  const r = input.revenue;
  const deductionMap = { discounts: r.discountsMinor, refunds: r.refundsMinor, taxes_collected: r.taxesCollectedMinor } as const;
  const deductions = profile.revenueRecognition.netOf.map((k) => ({ key: k, minor: deductionMap[k] }));
  const netSalesMinor = r.grossSalesMinor - sum(deductions.map((d) => d.minor));

  // 2. COGS (+ write-downs of unsold stock to recoverable value)
  const cogsMinor = sum([input.cogsMinor, input.inventoryWriteDownMinor]);

  // 3. Operating expenses: each category deducted once, only if enabled + deductible.
  const catByKey = new Map(profile.expenseCategories.map((c) => [c.key, c]));
  const opex: PeriodResult["opex"] = [];
  for (const [key, minor] of Object.entries(input.expensesByCategory).sort(([a], [b]) => a.localeCompare(b))) {
    assertMinor(minor, `expense ${key}`);
    if (minor === 0) continue;
    const cat = catByKey.get(key);
    if (!cat) {
      warnings.push(`Expense category "${key}" is not in the profile; excluded.`);
      continue;
    }
    if (cat.type === "cogs" || cat.type === "system") continue; // COGS handled in step 2; reinvestment is engine-managed
    if (!cat.enabled || !cat.deductible) {
      warnings.push(`Category "${cat.label}" is ${cat.enabled ? "non-deductible" : "disabled"}; ${minor} paisa excluded.`);
      continue;
    }
    if (key === "overhead" && profile.overheadAllocation.mode === "none_until_signed") {
      warnings.push("Overhead excluded: no signed allocation exists.");
      continue;
    }
    opex.push({ key, label: cat.label, minor });
  }
  const opexTotalMinor = sum(opex.map((o) => o.minor));

  // 4.
  const profitBeforeLossesMinor = netSalesMinor - cogsMinor - opexTotalMinor;

  // 5. Loss carry-forward
  const lcf = profile.lossCarryForward;
  const opening = lcf.enabled ? input.openingLossBalanceMinor : 0;
  let added = 0;
  let applied = 0;
  let netProfitMinor: Minor;
  if (profitBeforeLossesMinor < 0) {
    netProfitMinor = 0;
    const excluded = lcf.excludePostTermination && input.postTermination;
    added = lcf.enabled && !excluded ? -profitBeforeLossesMinor : 0;
    if (excluded) warnings.push("Post-termination loss is not carried forward.");
  } else {
    applied = Math.min(opening, profitBeforeLossesMinor);
    netProfitMinor = profitBeforeLossesMinor - applied;
  }
  const loss = { openingMinor: opening, addedMinor: added, appliedMinor: applied, closingMinor: opening + added - applied };

  // 6. Reinvestment
  const reinvestmentMinor = applyPct(netProfitMinor, profile.reinvestment.pct);

  // 7. Shared profit and allocation
  const sharedProfitMinor = netProfitMinor - reinvestmentMinor;
  const partners = profile.partners;
  const allocations = allocateByPct(sharedProfitMinor, partners.map((p) => p.sharePct));
  const claims =
    profile.reinvestment.treatment === "credit_partners_pro_rata"
      ? allocateByPct(reinvestmentMinor, partners.map((p) => p.sharePct))
      : partners.map(() => 0);

  // 8. Cash safeguards
  const inc = new Set(profile.cashSafeguards.include);
  const res = input.cash.reserve;
  const lines = RESERVE_LINES.filter((l) => inc.has(l.include)).map((l) => {
    const v = (res[l.field] as number | undefined) ?? 0;
    nonNeg(v, l.key);
    return { key: l.key, label: l.label, minor: v };
  });
  if (res.extraReserveMinor) {
    if (profile.cashSafeguards.requireWrittenCalcForExtraReserve && !res.extraReserveCalcRef)
      warnings.push("Extra reserve ignored: a written calculation reference is required.");
    else lines.push({ key: "extra_reserve", label: `Extra reserve (${res.extraReserveCalcRef ?? "no ref"})`, minor: res.extraReserveMinor });
  }
  const reserveMinor = sum(lines.map((l) => l.minor));
  const distributableMinor = Math.max(0, input.cash.bankAndCashMinor - input.cash.reinvestmentFundBalanceMinor - reserveMinor);
  const cashShares = allocateByPct(distributableMinor, partners.map((p) => p.sharePct));

  // 9–11. Per partner: cap, withdrawable, undrawn, netting
  const capCfg = profile.withdrawalCap;
  const monthsIn = monthsBetween(profile.term.start, input.periodStart); // 0 for the first month
  const capApplies = capCfg.enabled && monthsIn < capCfg.months;
  const partnerResults: PartnerResult[] = partners.map((p, i) => {
    const pin = input.partners[p.partnerId] ?? { openingUndrawnMinor: 0, withdrawnThisPeriodMinor: 0, nettingReceivableMinor: 0 };
    nonNeg(pin.withdrawnThisPeriodMinor, "withdrawn");
    nonNeg(pin.nettingReceivableMinor, "netting");
    const allocation = allocations[i]!;
    const gross = pin.openingUndrawnMinor + allocation;
    const nettingApplied = Math.min(pin.nettingReceivableMinor, Math.max(0, gross));
    const available = gross - nettingApplied;
    const capMinor = capApplies && (capCfg.applyToAllPartners || p.isCapitalProvider === false) ? capCfg.perPartnerMinor : null;
    const capRemaining = capMinor === null ? null : Math.max(0, capMinor - pin.withdrawnThisPeriodMinor);
    const cashShare = cashShares[i]!;
    const balanceLeft = Math.max(0, available - pin.withdrawnThisPeriodMinor);
    const cashLeft = Math.max(0, cashShare - pin.withdrawnThisPeriodMinor);
    const candidates: [number, PartnerResult["withdrawableLimitedBy"]][] = [
      [balanceLeft, "balance"],
      ...(capRemaining === null ? [] : ([[capRemaining, "cap"]] as [number, "cap"][])),
      [cashLeft, "cash"],
    ];
    const [withdrawable, limitedBy] = candidates.reduce((a, b) => (b[0] < a[0] ? b : a));
    if (pin.withdrawnThisPeriodMinor > available) warnings.push(`${p.label} has withdrawn more than the available balance.`);
    return {
      partnerId: p.partnerId,
      label: p.label,
      sharePct: p.sharePct,
      allocationMinor: allocation,
      reinvestmentClaimMinor: claims[i]!,
      openingUndrawnMinor: pin.openingUndrawnMinor,
      availableMinor: available,
      nettingAppliedMinor: nettingApplied,
      nettingRemainingMinor: pin.nettingReceivableMinor - nettingApplied,
      capApplies: capMinor !== null,
      capMinor,
      capRemainingMinor: capRemaining,
      cashShareMinor: cashShare,
      withdrawableMinor: withdrawable,
      withdrawableLimitedBy: limitedBy,
      withdrawnThisPeriodMinor: pin.withdrawnThisPeriodMinor,
      closingUndrawnMinor: available - pin.withdrawnThisPeriodMinor,
    };
  });

  if (input.cash.bankAndCashMinor - input.cash.reinvestmentFundBalanceMinor < reserveMinor) warnings.push("Cash is below the required reserve.");

  const body = {
    periodId: input.periodId,
    profileVersion: profile.version,
    engineVersion: ENGINE_VERSION,
    inputsHash: stableHash({ input, profileVersion: profile.version, engineVersion: ENGINE_VERSION }),
    netSales: { grossMinor: r.grossSalesMinor, deductions, netMinor: netSalesMinor },
    cogsMinor,
    opex,
    opexTotalMinor,
    profitBeforeLossesMinor,
    loss,
    netProfitMinor,
    reinvestment: { pct: profile.reinvestment.pct, treatment: profile.reinvestment.treatment, minor: reinvestmentMinor },
    sharedProfitMinor,
    cash: { lines, reserveMinor, bankAndCashMinor: input.cash.bankAndCashMinor, reinvestmentFundMinor: input.cash.reinvestmentFundBalanceMinor, distributableMinor },
    partners: partnerResults,
    warnings,
  };
  return { ...body, outputsHash: stableHash(body) };
}

/**
 * Step 11: after a correction, compute what a partner was over-paid relative to the corrected Final entitlement.
 * The result is netted against that partner's own future distributions; personal repayment only for listed reasons.
 */
export function computeOverDistribution(
  args: { withdrawnMinor: Minor; correctedEntitlementMinor: Minor; reason: string },
  profile: AgreementProfile,
): { nettingReceivableMinor: Minor; personalRepaymentFlag: boolean } {
  const over = Math.max(0, args.withdrawnMinor - args.correctedEntitlementMinor);
  return { nettingReceivableMinor: over, personalRepaymentFlag: over > 0 && profile.overDistribution.personalRepaymentOnlyFor.includes(args.reason) };
}

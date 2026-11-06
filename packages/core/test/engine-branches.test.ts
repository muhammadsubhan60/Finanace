import { describe, expect, it } from "vitest";
import { AgreementProfile, SEED_PROFILE } from "@delta/config-schema";
import { computePeriod, type PeriodInput } from "../src/engine/computePeriod";

/** Branch-level tests for the engine (M2 gate: 100% branch coverage of packages/core/src/engine). */
const PKR = (n: number) => n * 100;
const base = AgreementProfile.parse(SEED_PROFILE);
const prof = (patch: Partial<AgreementProfile>) => AgreementProfile.parse({ ...SEED_PROFILE, ...patch });
const reserve = { knownLiabilitiesMinor: 0, payrollDueMinor: 0, taxesDueMinor: 0, refundsExpectedMinor: 0, courierReturnExposureMinor: 0, fixedCostsNextBufferMinor: 0, inventoryNeedsNextBufferMinor: 0 };
const input = (over: Partial<PeriodInput> = {}): PeriodInput => ({
  periodId: "2026-12",
  periodStart: "2026-12-01",
  revenue: { grossSalesMinor: PKR(100_000), discountsMinor: 0, refundsMinor: 0, taxesCollectedMinor: 0 },
  cogsMinor: 0,
  inventoryWriteDownMinor: 0,
  expensesByCategory: {},
  openingLossBalanceMinor: 0,
  cash: { bankAndCashMinor: PKR(10_000_000), reinvestmentFundBalanceMinor: 0, reserve },
  partners: {},
  ...over,
});

describe("engine branches", () => {
  it("rejects negative non-negative inputs", () => {
    expect(() => computePeriod(input({ openingLossBalanceMinor: -1 }), base)).toThrow(/must be ≥ 0/);
  });

  it("skips zero-amount categories without warnings", () => {
    const r = computePeriod(input({ expensesByCategory: { ads: 0, zzz_unknown: 0 } }), base);
    expect(r.opex).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("excludes enabled but non-deductible categories with a warning", () => {
    const p = prof({ expenseCategories: [...SEED_PROFILE.expenseCategories, { key: "fines", label: "Fines", type: "operating", deductible: false, source: ["manual"], parent: null, enabled: true, paused: false }] });
    const r = computePeriod(input({ expensesByCategory: { fines: PKR(500) } }), p);
    expect(r.opexTotalMinor).toBe(0);
    expect(r.warnings.join()).toMatch(/non-deductible/);
  });

  it("overhead: enabled but unsigned is excluded; signed is deducted", () => {
    const cats = SEED_PROFILE.expenseCategories.map((c) => (c.key === "overhead" ? { ...c, enabled: true } : c));
    const unsigned = computePeriod(input({ expensesByCategory: { overhead: PKR(1_000) } }), prof({ expenseCategories: cats }));
    expect(unsigned.opexTotalMinor).toBe(0);
    expect(unsigned.warnings.join()).toMatch(/no signed allocation/);
    const signed = computePeriod(input({ expensesByCategory: { overhead: PKR(1_000) } }), prof({ expenseCategories: cats, overheadAllocation: { mode: "signed", entries: [{ label: "Office", monthlyMinor: PKR(1_000), signedDocRef: "doc-1" }] } }));
    expect(signed.opexTotalMinor).toBe(PKR(1_000));
  });

  it("loss carry-forward disabled ignores the opening balance", () => {
    const r = computePeriod(input({ openingLossBalanceMinor: PKR(50_000) }), prof({ lossCarryForward: { ...SEED_PROFILE.lossCarryForward, enabled: false } }));
    expect(r.netProfitMinor).toBe(PKR(100_000));
    expect(r.loss.openingMinor).toBe(0);
  });

  it("missing reserve fields count as zero; extra reserve without a ref is allowed when not required", () => {
    const partialReserve = { knownLiabilitiesMinor: PKR(10) } as PeriodInput["cash"]["reserve"];
    const r = computePeriod(input({ cash: { bankAndCashMinor: PKR(1_000), reinvestmentFundBalanceMinor: 0, reserve: { ...partialReserve, extraReserveMinor: PKR(5) } } }), prof({ cashSafeguards: { ...SEED_PROFILE.cashSafeguards, requireWrittenCalcForExtraReserve: false } }));
    expect(r.cash.reserveMinor).toBe(PKR(15));
    expect(r.cash.lines.find((l) => l.key === "extra_reserve")?.label).toMatch(/no ref/);
  });

  it("cap applies only to non-capital-provider partners when applyToAllPartners is false", () => {
    const r = computePeriod(input({ revenue: { grossSalesMinor: PKR(500_000), discountsMinor: 0, refundsMinor: 0, taxesCollectedMinor: 0 } }), prof({ withdrawalCap: { ...SEED_PROFILE.withdrawalCap, applyToAllPartners: false } }));
    const [investor, md] = r.partners;
    expect(investor!.capApplies).toBe(false);
    expect(investor!.withdrawableMinor).toBe(PKR(175_000));
    expect(md!.capApplies).toBe(true);
    expect(md!.withdrawableMinor).toBe(PKR(50_000));
  });

  it("warns when a partner has withdrawn more than available, and when cash is below reserve", () => {
    const r = computePeriod(
      input({ partners: { hanan: { openingUndrawnMinor: 0, withdrawnThisPeriodMinor: PKR(60_000), nettingReceivableMinor: 0 } }, cash: { bankAndCashMinor: PKR(1_000), reinvestmentFundBalanceMinor: 0, reserve: { ...reserve, payrollDueMinor: PKR(5_000) } } }),
      base,
    );
    expect(r.warnings.join()).toMatch(/withdrawn more than the available/);
    expect(r.warnings.join()).toMatch(/below the required reserve/);
    expect(r.partners[1]!.withdrawableMinor).toBe(0);
  });
});

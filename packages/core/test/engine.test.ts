import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { AgreementProfile, SEED_PROFILE } from "@delta/config-schema";
import { computePeriod, computeOverDistribution, type PeriodInput } from "../src/engine/computePeriod";
import { allocateByPct, parsePKR } from "../src/money";

const PKR = (n: number) => n * 100;
const profile = AgreementProfile.parse(SEED_PROFILE);

/** Input where Net Profit = `np` exactly (sales only), with ample cash and no reserve. */
function inputFor(np: number, over: Partial<PeriodInput> = {}): PeriodInput {
  return {
    periodId: "2026-12",
    periodStart: "2026-12-01",
    revenue: { grossSalesMinor: np, discountsMinor: 0, refundsMinor: 0, taxesCollectedMinor: 0 },
    cogsMinor: 0,
    inventoryWriteDownMinor: 0,
    expensesByCategory: {},
    openingLossBalanceMinor: 0,
    cash: {
      bankAndCashMinor: PKR(100_000_000),
      reinvestmentFundBalanceMinor: 0,
      reserve: { knownLiabilitiesMinor: 0, payrollDueMinor: 0, taxesDueMinor: 0, refundsExpectedMinor: 0, courierReturnExposureMinor: 0, fixedCostsNextBufferMinor: 0, inventoryNeedsNextBufferMinor: 0 },
    },
    partners: {},
    ...over,
  };
}

describe("8.3 acceptance vectors (pct=30, 50/50, cap 50,000 × 6 months)", () => {
  const table = [
    [0, 0, 0, 0, 0, 0],
    [100_000, 30_000, 70_000, 35_000, 35_000, 0],
    [200_000, 60_000, 140_000, 70_000, 50_000, 20_000],
    [500_000, 150_000, 350_000, 175_000, 50_000, 125_000],
  ] as const;
  it.each(table)("Net Profit %i", (np, reinv, shared, each, draw, undrawn) => {
    const r = computePeriod(inputFor(PKR(np)), profile);
    expect(r.netProfitMinor).toBe(PKR(np));
    expect(r.reinvestment.minor).toBe(PKR(reinv));
    expect(r.sharedProfitMinor).toBe(PKR(shared));
    for (const p of r.partners) {
      expect(p.allocationMinor).toBe(PKR(each));
      expect(p.withdrawableMinor).toBe(PKR(draw));
      expect(p.availableMinor - p.withdrawableMinor).toBe(PKR(undrawn));
    }
    // Drawing the maximum leaves exactly the undrawn balance.
    const drawn = computePeriod(inputFor(PKR(np), { partners: Object.fromEntries(r.partners.map((p) => [p.partnerId, { openingUndrawnMinor: 0, withdrawnThisPeriodMinor: p.withdrawableMinor, nettingReceivableMinor: 0 }])) }), profile);
    for (const p of drawn.partners) expect(p.closingUndrawnMinor).toBe(PKR(undrawn));
  });

  it("142,858 is the smallest whole-rupee Net Profit at which each partner can draw 50,000", () => {
    const at = computePeriod(inputFor(PKR(142_858)), profile);
    expect(at.partners.every((p) => p.withdrawableMinor === PKR(50_000))).toBe(true);
    expect(at.partners[0]!.allocationMinor).toBe(5_000_030); // 50,000.30
    const below = computePeriod(inputFor(PKR(142_857)), profile);
    expect(below.partners.every((p) => p.withdrawableMinor < PKR(50_000))).toBe(true);
  });

  it("loss carry-forward: −80,000 then +200,000 → NP 120,000 → 36,000 / 84,000 / 42,000 each", () => {
    const m1 = computePeriod(inputFor(0, { cogsMinor: PKR(80_000) }), profile);
    expect(m1.netProfitMinor).toBe(0);
    expect(m1.loss.closingMinor).toBe(PKR(80_000));
    const m2 = computePeriod(inputFor(PKR(200_000), { periodId: "2027-01", periodStart: "2027-01-01", openingLossBalanceMinor: m1.loss.closingMinor }), profile);
    expect(m2.profitBeforeLossesMinor).toBe(PKR(200_000));
    expect(m2.netProfitMinor).toBe(PKR(120_000));
    expect(m2.reinvestment.minor).toBe(PKR(36_000));
    expect(m2.sharedProfitMinor).toBe(PKR(84_000));
    expect(m2.partners.map((p) => p.allocationMinor)).toEqual([PKR(42_000), PKR(42_000)]);
    expect(m2.loss.closingMinor).toBe(0);
  });

  it("3 partners at 33.34/33.33/33.33 never lose or create paisa", () => {
    const p3 = AgreementProfile.parse({
      ...SEED_PROFILE,
      partners: [
        { partnerId: "a", label: "A", sharePct: 33.34, isCapitalProvider: true },
        { partnerId: "b", label: "B", sharePct: 33.33, isCapitalProvider: false },
        { partnerId: "c", label: "C", sharePct: 33.33, isCapitalProvider: false },
      ],
      capital: { ...SEED_PROFILE.capital, providerPartnerId: "a" },
    });
    for (const np of [1, 2, 99, 100_001, 12_345_67]) {
      const r = computePeriod(inputFor(np), p3);
      expect(r.partners.reduce((s, p) => s + p.allocationMinor, 0)).toBe(r.sharedProfitMinor);
    }
  });

  it("profile switch: a v1 period stays reproducible after v2 is active", () => {
    const input = inputFor(PKR(200_000));
    const v1 = computePeriod(input, profile);
    const v2 = AgreementProfile.parse({ ...SEED_PROFILE, version: 2, reinvestment: { ...SEED_PROFILE.reinvestment, pct: 40, treatment: "credit_partners_pro_rata" } });
    const withV2 = computePeriod(input, v2);
    expect(withV2.reinvestment.minor).toBe(PKR(80_000));
    expect(withV2.partners[0]!.reinvestmentClaimMinor).toBe(PKR(40_000));
    const again = computePeriod(input, profile);
    expect(again.outputsHash).toBe(v1.outputsHash);
    expect(again.profileVersion).toBe(1);
  });

  it("after month 6 the cap no longer applies; reinvestment and safeguards still do", () => {
    // Term starts 2026-11 (month 0). Month 6 = 2027-05.
    const inCap = computePeriod(inputFor(PKR(500_000), { periodId: "2027-04", periodStart: "2027-04-01" }), profile);
    expect(inCap.partners[0]!.capApplies).toBe(true);
    const r = computePeriod(inputFor(PKR(500_000), { periodId: "2027-05", periodStart: "2027-05-01" }), profile);
    expect(r.partners[0]!.capApplies).toBe(false);
    expect(r.reinvestment.minor).toBe(PKR(150_000));
    expect(r.partners[0]!.withdrawableMinor).toBe(PKR(175_000));
    const tight = computePeriod(inputFor(PKR(500_000), { periodId: "2027-05", periodStart: "2027-05-01", cash: { ...inputFor(0).cash, bankAndCashMinor: PKR(100_000), reinvestmentFundBalanceMinor: PKR(20_000) } }), profile);
    expect(tight.cash.distributableMinor).toBe(PKR(80_000));
    expect(tight.partners[0]!.withdrawableMinor).toBe(PKR(40_000));
    expect(tight.partners[0]!.withdrawableLimitedBy).toBe("cash");
  });

  it("idempotence: same snapshot → identical output and hash", () => {
    const a = computePeriod(inputFor(PKR(321_987)), profile);
    const b = computePeriod(inputFor(PKR(321_987)), profile);
    expect(b).toEqual(a);
    expect(b.inputsHash).toBe(a.inputsHash);
  });
});

describe("engine details", () => {
  it("deducts each enabled category once; excludes overhead until signed and system categories", () => {
    const r = computePeriod(inputFor(PKR(100_000), { expensesByCategory: { ads: PKR(10_000), overhead: PKR(5_000), reinvestment: PKR(999), payroll: PKR(20_000), unknown_cat: 1 } }), profile);
    expect(r.opexTotalMinor).toBe(PKR(30_000));
    expect(r.netProfitMinor).toBe(PKR(70_000));
    expect(r.warnings.join(" ")).toMatch(/unknown_cat/);
  });

  it("net sales are net of configured deductions only", () => {
    const r = computePeriod(inputFor(0, { revenue: { grossSalesMinor: PKR(1000), discountsMinor: PKR(100), refundsMinor: PKR(50), taxesCollectedMinor: PKR(10) } }), profile);
    expect(r.netSales.netMinor).toBe(PKR(840));
    const p2 = AgreementProfile.parse({ ...SEED_PROFILE, revenueRecognition: { ...SEED_PROFILE.revenueRecognition, netOf: ["discounts"] } });
    expect(computePeriod(inputFor(0, { revenue: { grossSalesMinor: PKR(1000), discountsMinor: PKR(100), refundsMinor: PKR(50), taxesCollectedMinor: PKR(10) } }), p2).netSales.netMinor).toBe(PKR(900));
  });

  it("reserve lines follow the profile include list; extra reserve needs a written calc", () => {
    const base = inputFor(PKR(100_000));
    const r = computePeriod({ ...base, cash: { ...base.cash, bankAndCashMinor: PKR(200_000), reserve: { ...base.cash.reserve, payrollDueMinor: PKR(50_000), extraReserveMinor: PKR(10_000) } } }, profile);
    expect(r.cash.reserveMinor).toBe(PKR(50_000));
    expect(r.warnings.join(" ")).toMatch(/written calculation/);
    const r2 = computePeriod({ ...base, cash: { ...base.cash, bankAndCashMinor: PKR(200_000), reserve: { ...base.cash.reserve, extraReserveMinor: PKR(10_000), extraReserveCalcRef: "memo-1" } } }, profile);
    expect(r2.cash.reserveMinor).toBe(PKR(10_000));
  });

  it("post-termination losses are not carried forward", () => {
    const r = computePeriod(inputFor(0, { cogsMinor: PKR(1000), postTermination: true }), profile);
    expect(r.loss.closingMinor).toBe(0);
  });

  it("netting receivable reduces what a partner can draw, not the other partner", () => {
    const r = computePeriod(inputFor(PKR(100_000), { partners: { hanan: { openingUndrawnMinor: 0, withdrawnThisPeriodMinor: 0, nettingReceivableMinor: PKR(10_000) } } }), profile);
    const [m, h] = r.partners;
    expect(m!.withdrawableMinor).toBe(PKR(35_000));
    expect(h!.withdrawableMinor).toBe(PKR(25_000));
    expect(h!.nettingRemainingMinor).toBe(0);
    expect(computeOverDistribution({ withdrawnMinor: 100, correctedEntitlementMinor: 60, reason: "fraud" }, profile)).toEqual({ nettingReceivableMinor: 40, personalRepaymentFlag: true });
    expect(computeOverDistribution({ withdrawnMinor: 100, correctedEntitlementMinor: 60, reason: "arithmetical_error" }, profile).personalRepaymentFlag).toBe(false);
  });

  it("parsePKR handles separators and paisa", () => {
    expect(parsePKR("1,500.5")).toBe(150_050);
    expect(parsePKR("Rs 20")).toBe(2000);
    expect(() => parsePKR("1.234")).toThrow();
  });
});

describe("property tests", () => {
  const shares = fc.integer({ min: 2, max: 5 }).chain((n) =>
    fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: n, maxLength: n }).map((w) => {
      const total = w.reduce((a, b) => a + b, 0);
      const bps = w.map((x) => Math.floor((x / total) * 10000));
      bps[0]! += 10000 - bps.reduce((a, b) => a + b, 0);
      return bps.map((b) => b / 100);
    }),
  );

  it("rounding never leaks paisa", () => {
    fc.assert(fc.property(fc.integer({ min: -1e12, max: 1e12 }), shares, (total, pcts) => allocateByPct(total, pcts).reduce((a, b) => a + b, 0) === total));
  });

  it("totals reconcile and allocations are never negative", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e11 }), fc.integer({ min: 0, max: 1e11 }), fc.integer({ min: 0, max: 1e11 }), fc.integer({ min: 0, max: 1e11 }), (sales, cogs, ads, loss) => {
        const r = computePeriod(inputFor(sales, { cogsMinor: cogs, expensesByCategory: { ads }, openingLossBalanceMinor: loss }), profile);
        expect(r.netProfitMinor).toBeGreaterThanOrEqual(0);
        expect(r.reinvestment.minor + r.sharedProfitMinor).toBe(r.netProfitMinor);
        expect(r.partners.reduce((s, p) => s + p.allocationMinor, 0)).toBe(r.sharedProfitMinor);
        expect(r.partners.every((p) => p.allocationMinor >= 0 && p.withdrawableMinor >= 0)).toBe(true);
        expect(r.loss.closingMinor).toBe(r.loss.openingMinor + r.loss.addedMinor - r.loss.appliedMinor);
        expect(r.netProfitMinor + r.loss.appliedMinor).toBe(Math.max(0, r.profitBeforeLossesMinor));
      }),
    );
  });
});

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { AgreementProfile, SEED_PROFILE } from "@delta/config-schema";
import { buildPosting, buildReversal, entryHash, validateEntry, verifyChain, LedgerError } from "../src";
import { matchSettlementLines, matchShipment, normalizePhone, normalizeStatus, agingBucket, shipmentCogs } from "../src/couriers";
import { parseCsv, guessMapping, applyMapping } from "../src/csv";
import { evaluatePolicy, approvalsSatisfied, assertCategoryAllowed, diffObjects } from "../src/policy";

const profile = AgreementProfile.parse(SEED_PROFILE);

describe("ledger", () => {
  it("rejects unbalanced entries and mixed lines", () => {
    expect(() => validateEntry({ date: "2026-11-10", source: "x", memo: "", lines: [{ accountId: "bank", debitMinor: 100, creditMinor: 0 }, { accountId: "sales", debitMinor: 0, creditMinor: 99 }] })).toThrow(LedgerError);
    expect(() => validateEntry({ date: "2026-11-10", source: "x", memo: "", lines: [{ accountId: "bank", debitMinor: 100, creditMinor: 100 }, { accountId: "sales", debitMinor: 0, creditMinor: 0 }] })).toThrow(LedgerError);
  });

  it("reversal swaps sides and balances", () => {
    const e = { _id: "e1", date: "2026-11-10", source: "x", memo: "m", lines: [{ accountId: "bank", debitMinor: 100, creditMinor: 0 }, { accountId: "sales", debitMinor: 0, creditMinor: 100 }] };
    const r = buildReversal(e, "2026-12-01", "fix");
    validateEntry(r);
    expect(r.lines[0]).toMatchObject({ accountId: "bank", debitMinor: 0, creditMinor: 100 });
    expect(r.reversalOf).toBe("e1");
  });

  it("hash chain detects tampering", () => {
    const base = { date: "2026-11-10", source: "x", memo: "m", lines: [{ accountId: "bank", debitMinor: 1, creditMinor: 0 }, { accountId: "sales", debitMinor: 0, creditMinor: 1 }] };
    const e1 = { ...base, seq: 1, prevHash: "GENESIS", hash: "" };
    e1.hash = entryHash("GENESIS", e1);
    const e2 = { ...base, seq: 2, prevHash: e1.hash, hash: "" };
    e2.hash = entryHash(e1.hash, e2);
    expect(verifyChain([e1, e2]).ok).toBe(true);
    const tampered = { ...e1, memo: "changed" };
    expect(verifyChain([tampered, e2])).toEqual({ ok: false, brokenAtSeq: 1 });
  });

  it("every posting template produces balanced entries (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ cod: fc.integer({ min: 0, max: 1e8 }), cogs: fc.integer({ min: 0, max: 1e8 }) }), { minLength: 1, maxLength: 10 }), fc.integer({ min: 0, max: 1e6 }), fc.integer({ min: 0, max: 1e6 }), (lines, freight, fee) => {
        const gross = lines.reduce((s, l) => s + l.cod, 0);
        const net = Math.max(0, gross - freight - fee);
        for (const event of ["delivered", "delivered_and_cod_settled"] as const) {
          const p = AgreementProfile.parse({ ...SEED_PROFILE, revenueRecognition: { ...SEED_PROFILE.revenueRecognition, event } });
          const e = buildPosting({ type: "cod_settlement", date: "2026-11-20", settlementId: "s1", lines: lines.map((l, i) => ({ shipmentId: `sh${i}`, codMinor: l.cod, cogsMinor: l.cogs })), freightMinor: freight, codFeeMinor: fee, returnFeeMinor: 0, otherDeductionsMinor: 0, netReceivedMinor: net }, p);
          if (e && e.lines.length >= 2) validateEntry(e);
        }
      }),
    );
  });

  it("delivered posting only when recognition = delivered", () => {
    const ev = { type: "shipment_delivered" as const, date: "2026-11-12", shipmentId: "s", codMinor: 5000, cogsMinor: 2000 };
    expect(buildPosting(ev, profile)).toBeNull();
    const p = AgreementProfile.parse({ ...SEED_PROFILE, revenueRecognition: { ...SEED_PROFILE.revenueRecognition, event: "delivered" } });
    const e = buildPosting(ev, p)!;
    validateEntry(e);
    expect(e.lines.find((l) => l.accountId === "sales")?.creditMinor).toBe(5000);
  });
});

describe("couriers", () => {
  it("maps statuses from config, unknown is flagged", () => {
    expect(normalizeStatus(profile, "leopards", "  Delivered ")).toEqual({ status: "delivered", mapped: true });
    expect(normalizeStatus(profile, "leopards", "Weird New Status")).toEqual({ status: "unknown", mapped: false });
  });

  const orders = [
    { id: "o1", name: "#1042", trackingNumbers: [], phone: "0300-1234567", city: "Lahore", totalMinor: 350000, createdDate: "2026-11-10" },
    { id: "o2", name: "#1043", trackingNumbers: ["LE999"], phone: "03111111111", city: "Karachi", totalMinor: 200000, createdDate: "2026-11-10" },
  ];
  it("reference → tracking → fuzzy → queue", () => {
    expect(matchShipment({ cn: "X", orderRef: "1042", codMinor: 1, bookedDate: "2026-11-10" }, orders, profile)).toMatchObject({ orderId: "o1", strategy: "reference_field" });
    expect(matchShipment({ cn: "LE999", codMinor: 1, bookedDate: "2026-11-10" }, orders, profile)).toMatchObject({ orderId: "o2", strategy: "shopify_tracking_number" });
    expect(matchShipment({ cn: "Z", phone: "+92 300 1234567", city: "lahore", codMinor: 350000, bookedDate: "2026-11-11" }, orders, profile)).toMatchObject({ orderId: "o1", strategy: "fuzzy", confidence: 1 });
    const weak = matchShipment({ cn: "Z", phone: "+92 300 1234567", city: "Multan", codMinor: 1, bookedDate: "2026-11-11" }, orders, profile);
    expect(weak.orderId).toBeNull();
    expect(weak.strategy).toBe("manual_queue");
    expect(weak.candidates[0]!.orderId).toBe("o1");
    expect(normalizePhone("923001234567")).toBe("3001234567");
    // a reference that matches by name but is months apart is not trusted
    expect(matchShipment({ cn: "X", orderRef: "1042", codMinor: 1, bookedDate: "2027-03-01" }, orders, profile).strategy).not.toBe("reference_field");
  });

  it("settlement lines flag mismatches", () => {
    const shipments = [
      { id: "a", cn: "CN1", codAmountMinor: 1000, normalizedStatus: "delivered" as const },
      { id: "b", cn: "CN2", codAmountMinor: 1000, normalizedStatus: "delivered" as const, settlementId: "old" },
      { id: "c", cn: "CN3", codAmountMinor: 1000, normalizedStatus: "in_transit" as const },
    ];
    const mk = (cn: string, cod: number) => ({ lineKey: cn, cn, codMinor: cod, freightMinor: 0, codFeeMinor: 0, returnFeeMinor: 0 });
    const r = matchSettlementLines([mk("CN1", 1000), mk("CN2", 1000), mk("CN3", 1000), mk("CN4", 1), mk("cn1", 1000)], shipments);
    expect(r.map((x) => x.flag)).toEqual(["ok", "already_settled", "not_delivered", "cn_unknown", "duplicate_in_file"]);
    expect(matchSettlementLines([mk("CN1", 900)], shipments)[0]!.flag).toBe("amount_differs");
    const rto = [{ id: "r", cn: "RT1", codAmountMinor: 119_900, normalizedStatus: "returned_to_origin" as const }];
    expect(matchSettlementLines([mk("RT1", 0)], rto)[0]!.flag).toBe("ok");
  });

  it("per-unit COGS estimate for single-price catalogues", () => {
    const p = AgreementProfile.parse({ ...SEED_PROFILE, matching: { ...SEED_PROFILE.matching, fallbackCogs: { mode: "per_unit", unitPriceMinor: 120_000, unitCostMinor: 35_000 } } });
    expect([119_900, 220_000, 0, 100_000].map((c) => shipmentCogs({ codMinor: c }, p).cogsMinor)).toEqual([35_000, 70_000, 35_000, 35_000]);
    expect(shipmentCogs({ codMinor: 119_900 }, profile).cogsMinor).toBe(47_960); // default ratio 40%
  });

  it("aging buckets", () => {
    expect([0, 7, 8, 30, 31].map((d) => agingBucket(d, [7, 14, 30]))).toEqual(["0–7", "0–7", "8–14", "15–30", "30+"]);
  });
});

describe("csv + policy", () => {
  it("parses quoted CSV and guesses mappings", () => {
    const { headers, rows } = parseCsv('CN Number,"COD Amount",Remarks\r\nLE1,"1,500","says ""hi"""\n');
    expect(rows[0]).toEqual({ "CN Number": "LE1", "COD Amount": "1,500", Remarks: 'says "hi"' });
    const m = guessMapping(headers, { cn: ["cn", "tracking"], cod: ["cod amount", "cod"] });
    expect(applyMapping(rows, m)[0]).toEqual({ cn: "LE1", cod: "1,500" });
  });

  it("silence is not approval; separation of duties", () => {
    const d = evaluatePolicy(profile, "spend", 100, "single_purchase");
    expect(d.requiresApproval).toBe(true);
    expect(evaluatePolicy(profile, "something_unconfigured").requiresApproval).toBe(true);
    expect(approvalsSatisfied(d, [{ userId: "u1", role: "owner", decision: "approve" }], "u1").satisfied).toBe(false);
    expect(approvalsSatisfied(d, [{ userId: "u1", role: "owner", decision: "approve" }], "u2").satisfied).toBe(true);
    const cfg = evaluatePolicy(profile, "config_change");
    expect(approvalsSatisfied(cfg, [{ userId: "u1", role: "owner", decision: "approve" }], "x")).toMatchObject({ satisfied: false, missingRoles: ["md"] });
    expect(approvalsSatisfied(cfg, [{ userId: "u1", role: "owner", decision: "approve" }, { userId: "u2", role: "md", decision: "approve" }], "x").satisfied).toBe(true);
  });

  it("personal income tax is never a category", () => {
    expect(() => assertCategoryAllowed(profile, "personal_income_tax")).toThrow(/personal income tax/);
    expect(() => assertCategoryAllowed(profile, "overhead")).toThrow(/disabled/);
    expect(() => assertCategoryAllowed(profile, "reinvestment")).toThrow(/engine/);
    expect(() => AgreementProfile.parse({ ...SEED_PROFILE, expenseCategories: [...SEED_PROFILE.expenseCategories, { key: "personal_income_tax", label: "PIT", type: "tax" }] })).toThrow();
  });

  it("diff lists changed paths", () => {
    expect(diffObjects({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } })).toEqual([{ path: "a.c", before: 2, after: 3 }]);
  });
});

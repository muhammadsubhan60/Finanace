import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const minor = z.number().int().nonnegative();

export const NORMALIZED_STATUSES = [
  "booked",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivery_attempted",
  "delivered",
  "return_initiated",
  "returned_to_origin",
  "cancelled",
  "lost_or_damaged",
  "unknown",
] as const;
export const NormalizedStatus = z.enum(NORMALIZED_STATUSES);
export type NormalizedStatus = z.infer<typeof NormalizedStatus>;
export const TERMINAL_STATUSES: NormalizedStatus[] = ["delivered", "returned_to_origin", "cancelled", "lost_or_damaged"];

export const Partner = z.object({
  partnerId: z.string().regex(/^[a-z0-9_]+$/),
  userId: z.string().optional(),
  label: z.string().min(1),
  sharePct: z.number().positive().max(100),
  isCapitalProvider: z.boolean().default(false),
});

export const ExpenseCategory = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/),
  label: z.string().min(1),
  type: z.enum(["cogs", "operating", "tax", "provision", "system"]),
  deductible: z.boolean().default(true),
  source: z.array(z.string()).default(["manual"]),
  parent: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
  /** Emergency pause flag (clause 6.6). New spend in a paused category is rejected. */
  paused: z.boolean().default(false),
});
export type ExpenseCategory = z.infer<typeof ExpenseCategory>;

export const ApprovalRule = z.object({
  action: z.string(),
  scope: z.string().optional(),
  /** null/undefined = no limit configured → always requires approval (silence is not approval). */
  limitMinor: minor.nullable().optional(),
  approvers: z.array(z.string()).min(1),
  mode: z.enum(["any", "all"]).default("any"),
  requires: z.enum(["requester_and_separate_approver", "approvers_only"]).optional(),
  requiresSignedDocument: z.boolean().optional(),
});
export type ApprovalRule = z.infer<typeof ApprovalRule>;

export const MatchingStrategy = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reference_field"), field: z.string().default("order_ref"), maxDaysApart: z.number().int().positive().default(30) }),
  z.object({ type: z.literal("shopify_tracking_number") }),
  z.object({
    type: z.literal("fuzzy"),
    keys: z.array(z.enum(["phone", "cod_amount", "city"])).min(1),
    dateWindowDays: z.number().int().positive(),
    minConfidence: z.number().min(0).max(1),
  }),
  z.object({ type: z.literal("manual_queue") }),
]);
export type MatchingStrategy = z.infer<typeof MatchingStrategy>;

export const AgreementProfile = z
  .object({
    orgId: z.string(),
    divisionId: z.string(),
    version: z.number().int().positive(),
    effectiveFrom: isoDate,
    status: z.enum(["draft", "pending_approval", "active", "superseded"]),
    partners: z.array(Partner).min(1),
    term: z.object({
      start: isoDate,
      months: z.number().int().positive(),
      pilotReviewDay: z.number().int().positive(),
      ordinaryNoticeDays: z.number().int().nonnegative(),
    }),
    revenueRecognition: z.object({
      event: z.enum(["delivered", "delivered_and_paid", "delivered_and_cod_settled"]),
      excludeStatuses: z.array(z.string()),
      netOf: z.array(z.enum(["discounts", "refunds", "taxes_collected"])),
    }),
    reinvestment: z.object({
      pct: z.number().min(0).max(100),
      basis: z.literal("net_profit"),
      treatment: z.enum(["expense_no_credit", "credit_partners_pro_rata"]),
      fundLedger: z.boolean(),
    }),
    distribution: z.object({ basis: z.literal("shared_profit"), rounding: z.literal("largest_remainder") }),
    withdrawalCap: z.object({
      enabled: z.boolean(),
      perPartnerMinor: minor,
      months: z.number().int().nonnegative(),
      applyToAllPartners: z.boolean(),
    }),
    cashSafeguards: z.object({
      bufferDays: z.number().int().nonnegative(),
      include: z.array(z.string()),
      requireWrittenCalcForExtraReserve: z.boolean(),
    }),
    lossCarryForward: z.object({
      enabled: z.boolean(),
      scope: z.enum(["within_term", "unlimited"]),
      excludePostTermination: z.boolean(),
    }),
    finalization: z.object({
      mode: z.literal("auto_after_days"),
      days: z.number().int().positive(),
      objectionWindowDays: z.number().int().positive(),
      correctionWindowMonths: z.number().int().positive(),
      correctionReasons: z.array(z.string()).min(1),
    }),
    reporting: z.object({
      closeDayOfMonth: z.number().int().min(1).max(28),
      payoutTargetDayOfMonth: z.number().int().min(1).max(28),
    }),
    overDistribution: z.object({
      method: z.literal("net_against_own_future_distributions"),
      personalRepaymentOnlyFor: z.array(z.string()),
    }),
    capital: z.object({
      envelopeMinor: minor,
      providerPartnerId: z.string(),
      tranchesRequireApproval: z.boolean(),
      warnAtPct: z.number().min(0).max(100).default(90),
      returnRules: z.object({
        firstMonthsLocked: z.number().int().nonnegative(),
        quarterlySurplusReview: z.boolean(),
        requireLiabilitiesCovered: z.boolean(),
        requireBufferFunded: z.boolean(),
      }),
    }),
    expenseCategories: z.array(ExpenseCategory),
    /** Engine flag: personal income tax is never a venture expense. */
    rejectPersonalIncomeTax: z.boolean().default(true),
    approvalPolicy: z.array(ApprovalRule),
    overheadAllocation: z.object({
      mode: z.enum(["none_until_signed", "signed"]),
      entries: z.array(z.object({ label: z.string(), monthlyMinor: minor, signedDocRef: z.string().optional() })),
    }),
    currency: z.object({ base: z.literal("PKR"), multiCurrency: z.literal(false) }),
    /** courierProvider → providerStatus (lower-cased) → normalized status */
    statusMappings: z.record(z.string(), z.record(z.string(), NormalizedStatus)),
    matching: z.object({
      mode: z.enum(["courier_first", "shopify_first"]),
      strategies: z.array(MatchingStrategy).min(1),
      unmatchedBlocksClose: z.boolean().default(false),
      /** Fallback COGS ratio (basis points of COD) per storeId for unmatched shipments; "*" = default. */
      fallbackCogsRatioBps: z.record(z.string(), z.number().int().min(0).max(10000)).default({ "*": 4000 }),
      /**
       * How to estimate COGS for shipments without order line detail.
       * ratio: COD × fallbackCogsRatioBps. per_unit: units = round(COD / unitPrice) (min 1) × unitCost.
       */
      fallbackCogs: z
        .object({ mode: z.enum(["ratio", "per_unit"]), unitPriceMinor: z.number().int().positive().optional(), unitCostMinor: z.number().int().nonnegative().optional() })
        .default({ mode: "ratio" }),
    }),
    stock: z.object({
      valuation: z.enum(["weighted_average", "fifo"]),
      /** false = returned goods cannot be resold (e.g. personalised products) and are written off on RTO. */
      returnsRecoverable: z.boolean().default(true),
    }),
    agingBucketsDays: z.array(z.number().int().positive()).default([7, 14, 30]),
    closeChecklist: z
      .record(z.string(), z.boolean())
      .default({
        integrations_synced: true,
        no_unmapped_statuses: true,
        no_unmatched_settlement_lines: true,
        no_unallocated_ad_spend: true,
        no_pending_expenses: true,
        stock_reconciled: false,
        bank_balance_entered: true,
      }),
  })
  .superRefine((p, ctx) => {
    const total = p.partners.reduce((s, x) => s + Math.round(x.sharePct * 100), 0);
    if (total !== 10000) ctx.addIssue({ code: "custom", path: ["partners"], message: `Partner shares must total 100% (got ${total / 100}%)` });
    if (!p.partners.some((x) => x.partnerId === p.capital.providerPartnerId))
      ctx.addIssue({ code: "custom", path: ["capital", "providerPartnerId"], message: "Capital provider must be a partner" });
    if (p.rejectPersonalIncomeTax && p.expenseCategories.some((c) => /personal.?income.?tax/i.test(c.key + " " + c.label)))
      ctx.addIssue({ code: "custom", path: ["expenseCategories"], message: "Personal income tax of a partner is not a venture expense" });
  });
export type AgreementProfile = z.infer<typeof AgreementProfile>;

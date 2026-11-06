import { z } from "zod";
export * from "./profile";
export * from "./seed";

/** Shared input schemas (used by both server actions and client forms). */
export const moneyInput = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "Enter an amount in PKR, e.g. 1500 or 1500.50");

export const ExpenseInput = z.object({
  categoryKey: z.string().min(1),
  amount: moneyInput,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payee: z.string().trim().min(1).max(200),
  storeId: z.string().optional(),
  projectId: z.string().optional(),
  memo: z.string().max(1000).optional(),
  recurring: z.boolean().default(false),
});

export const TrancheInput = z.object({
  amount: moneyInput,
  purpose: z.string().trim().min(3).max(500),
  plannedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const WithdrawalInput = z.object({
  partnerId: z.string(),
  amount: moneyInput,
  periodId: z.string().regex(/^\d{4}-\d{2}$/),
  overrideReason: z.string().max(1000).optional(),
});

export const ObjectionInput = z.object({
  periodId: z.string().regex(/^\d{4}-\d{2}$/),
  itemRef: z.string().min(1).max(200),
  reason: z.string().trim().min(5).max(2000),
  amount: moneyInput.optional(),
});

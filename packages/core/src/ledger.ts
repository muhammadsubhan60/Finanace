import { assertMinor, type Minor } from "./money";
import { stableHash } from "./hash";

export interface JournalLineDraft {
  accountId: string;
  debitMinor: Minor;
  creditMinor: Minor;
  partnerId?: string;
  storeId?: string;
  projectId?: string;
  refType?: string;
  refId?: string;
  memo?: string;
}

export interface JournalEntryDraft {
  date: string; // YYYY-MM-DD (Asia/Karachi)
  source: string; // posting template / workflow key
  memo: string;
  lines: JournalLineDraft[];
  reversalOf?: string;
  correctionOf?: { periodId: string; entryId?: string; reason: string };
  /** Natural idempotency key, e.g. "settlement:<id>". Unique in the journal. */
  idempotencyKey?: string;
}

export class LedgerError extends Error {}

export function validateEntry(e: JournalEntryDraft): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new LedgerError("Entry date must be YYYY-MM-DD");
  if (e.lines.length < 2) throw new LedgerError("An entry needs at least two lines");
  let dr = 0;
  let cr = 0;
  for (const l of e.lines) {
    assertMinor(l.debitMinor, "debit");
    assertMinor(l.creditMinor, "credit");
    if (l.debitMinor < 0 || l.creditMinor < 0) throw new LedgerError("Debit/credit must be ≥ 0");
    if ((l.debitMinor > 0) === (l.creditMinor > 0)) throw new LedgerError("Each line must be either a debit or a credit");
    if (!l.accountId) throw new LedgerError("Line without account");
    dr += l.debitMinor;
    cr += l.creditMinor;
  }
  if (dr !== cr) throw new LedgerError(`Entry does not balance: debits ${dr} ≠ credits ${cr}`);
}

/** Reversal = same lines with debit/credit swapped, linked to the original. */
export function buildReversal(original: JournalEntryDraft & { _id: string }, date: string, memo: string): JournalEntryDraft {
  return {
    date,
    source: "reversal",
    memo,
    reversalOf: original._id,
    idempotencyKey: `reversal:${original._id}`,
    lines: original.lines.map((l) => ({ ...l, debitMinor: l.creditMinor, creditMinor: l.debitMinor })),
  };
}

/** Hash chain: each entry hashes its content plus the previous entry's hash. */
export function entryHash(prevHash: string, e: Omit<JournalEntryDraft, never> & { seq: number }): string {
  return stableHash({ prevHash, seq: e.seq, date: e.date, source: e.source, memo: e.memo, lines: e.lines, reversalOf: e.reversalOf ?? null, idempotencyKey: e.idempotencyKey ?? null });
}

export function verifyChain(entries: (JournalEntryDraft & { seq: number; prevHash: string; hash: string })[]): { ok: boolean; brokenAtSeq?: number } {
  let prev = "GENESIS";
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    if (e.prevHash !== prev || entryHash(prev, e) !== e.hash) return { ok: false, brokenAtSeq: e.seq };
    prev = e.hash;
  }
  return { ok: true };
}

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense" | "memo";

/** Natural-sign balance: assets/expenses are debit-normal, others credit-normal. */
export function naturalBalance(type: AccountType, debit: Minor, credit: Minor): Minor {
  return type === "asset" || type === "expense" ? debit - credit : credit - debit;
}

export const partnerProfitAccount = (partnerId: string) => `partner_profit_${partnerId}`;
export const partnerDrawingsAccount = (partnerId: string) => `partner_drawings_${partnerId}`;
export const reinvestmentClaimAccount = (partnerId: string) => `reinvestment_claim_${partnerId}`;
export const capitalAccount = (partnerId: string) => `capital_${partnerId}`;
export const expenseAccount = (categoryKey: string) => `exp_${categoryKey}`;

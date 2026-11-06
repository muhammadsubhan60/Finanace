import type { ClientSession, Db } from "mongodb";
import { buildPosting, buildReversal, entryHash, periodIdOf, validateEntry, type JournalEntryDraft, type PostingEvent } from "@delta/core";
import type { AgreementProfile } from "@delta/config-schema";
import { getDb, withTransaction } from "./client";
import { audit, BusinessError, newId, type Ctx } from "./context";

export interface JournalEntryDoc extends JournalEntryDraft {
  _id: string;
  orgId: string;
  periodId: string;
  seq: number;
  prevHash: string;
  hash: string;
  createdAt: Date;
  createdBy: string;
}

const LOCKED = new Set(["closed", "final"]);

/**
 * The ONLY way to write to the ledger. Insert-only: there is no update or delete function anywhere.
 * Rejects unbalanced entries, entries dated in closed/final periods (unless correction workflow),
 * and is idempotent on `idempotencyKey`.
 */
export async function postEntry(ctx: Ctx, rawDraft: JournalEntryDraft, opts: { session?: ClientSession; allowClosedPeriod?: "period_close" | "correction" } = {}): Promise<JournalEntryDoc | null> {
  // Drop undefined fields so the stored document hashes exactly like the draft.
  const draft = JSON.parse(JSON.stringify(rawDraft)) as JournalEntryDraft;
  validateEntry(draft);
  const run = async (session: ClientSession, db: Db) => {
    const periodId = periodIdOf(draft.date);
    const period = await db.collection("periods").findOne({ orgId: ctx.orgId, periodId }, { session });
    if (period) {
      const status = period.status as string;
      const closingAllowed = opts.allowClosedPeriod === "period_close" && status === "closing";
      if ((LOCKED.has(status) || status === "closing") && !closingAllowed && opts.allowClosedPeriod !== "correction")
        throw new BusinessError(`Period ${periodId} is ${status}. Use the correction workflow; entries are dated in the current period.`);
    }
    if (draft.idempotencyKey) {
      const dup = await db.collection<JournalEntryDoc>("journal_entries").findOne({ orgId: ctx.orgId, idempotencyKey: draft.idempotencyKey }, { session });
      if (dup) return null; // already posted — exactly-once
    }
    const counter = await db.collection<{ _id: string; seq: number; lastHash: string }>("counters").findOneAndUpdate(
      { _id: `journal:${ctx.orgId}` },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after", session },
    );
    const seq = counter!.seq;
    const prevHash = seq === 1 ? "GENESIS" : (counter!.lastHash ?? "GENESIS");
    const hash = entryHash(prevHash, { ...draft, seq });
    const _id = newId();
    const doc: JournalEntryDoc = { ...draft, _id, orgId: ctx.orgId, periodId, seq, prevHash, hash, createdAt: new Date(), createdBy: ctx.userId };
    await db.collection<{ _id: string }>("counters").updateOne({ _id: `journal:${ctx.orgId}` }, { $set: { lastHash: hash } }, { session });
    await db.collection<JournalEntryDoc>("journal_entries").insertOne(doc, { session });
    await db.collection<{ _id: string }>("journal_lines").insertMany(
      draft.lines.map((l, i) => ({ _id: `${_id}:${i}`, orgId: ctx.orgId, entryId: _id, date: draft.date, periodId, source: draft.source, ...l })),
      { session },
    );
    await audit(ctx, "journal.post", "journal_entry", _id, null, { source: draft.source, memo: draft.memo, idempotencyKey: draft.idempotencyKey }, session);
    return doc;
  };
  return opts.session ? run(opts.session, await getDb()) : withTransaction(run);
}

export async function post(ctx: Ctx, event: PostingEvent, profile: AgreementProfile, opts: Parameters<typeof postEntry>[2] = {}) {
  const draft = buildPosting(event, profile);
  return draft ? postEntry(ctx, draft, opts) : null;
}

/** Correction = reversal + optional new entry, both dated today (current period), linked to the original. */
export async function reverseEntry(ctx: Ctx, entryId: string, date: string, memo: string, correctionOf?: JournalEntryDraft["correctionOf"]) {
  const db = await getDb();
  const orig = await db.collection<JournalEntryDoc>("journal_entries").findOne({ _id: entryId, orgId: ctx.orgId });
  if (!orig) throw new BusinessError("Entry not found");
  if (orig.reversalOf) throw new BusinessError("Cannot reverse a reversal; post a new entry instead");
  const rev = buildReversal(orig, date, memo);
  return postEntry(ctx, { ...rev, correctionOf });
}

/** Account balances (debit − credit) grouped by account for a date range / period, from journal_lines. */
export async function balances(orgId: string, match: Record<string, unknown> = {}): Promise<Map<string, { debit: number; credit: number }>> {
  const db = await getDb();
  const rows = await db
    .collection("journal_lines")
    .aggregate<{ _id: string; debit: number; credit: number }>([
      { $match: { orgId, ...match } },
      { $project: { _id: 0, accountId: 1, debitMinor: 1, creditMinor: 1 } }, // lets the covered indexes answer without fetching documents
      { $group: { _id: "$accountId", debit: { $sum: "$debitMinor" }, credit: { $sum: "$creditMinor" } } },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id, { debit: r.debit, credit: r.credit }]));
}

export const dr = (m: Map<string, { debit: number; credit: number }>, a: string) => (m.get(a)?.debit ?? 0) - (m.get(a)?.credit ?? 0);
export const crBal = (m: Map<string, { debit: number; credit: number }>, a: string) => -dr(m, a);

/** Recompute the hash chain over all entries (nightly verifier). */
export async function verifyJournalChain(orgId = process.env.ORG_ID ?? "delta-labs") {
  const db = await getDb();
  const cur = db.collection<JournalEntryDoc>("journal_entries").find({ orgId }).sort({ seq: 1 });
  let prev = "GENESIS";
  let count = 0;
  for await (const e of cur) {
    count++;
    if (e.prevHash !== prev || entryHash(prev, e) !== e.hash) return { ok: false as const, brokenAtSeq: e.seq, count };
    prev = e.hash;
  }
  return { ok: true as const, count };
}

/**
 * End-to-end month through the real services on a scratch database (MONGODB_DB=delta_finance_e2e):
 * seed → manual sales + expenses → close → withdrawal (cap) → dual-approved profile v2 → v1 period still reproduces
 * → re-import the same settlement (rejected) → journal rejects posting into the closed period → chain verifies.
 * Mirrors acceptance vector: Net Profit 200,000 → reinvestment 60,000 → 70,000 each → draw 50,000 → undrawn 20,000.
 */
process.env.MONGODB_DB = "delta_finance_e2e";
import assert from "node:assert/strict";
import { AgreementProfile, SEED_PROFILE } from "@delta/config-schema";
import {
  closeDb, getDb, ensureSchema, ORG_ID, SEED_ROLES, seedAccounts, post, postEntry, ensurePeriod, saveCloseInputs, startClose, closePeriod, getSnapshot,
  requestWithdrawal, decideApproval, payWithdrawal, createDraft, submitDraft, verifySnapshot, verifyJournalChain, getProfileFor, BusinessError, upsertShipment,
  recordSettlement, type Ctx, evaluateWithdrawal, createExpense,
} from "../src";

const PKR = (n: number) => n * 100;
const ctxFor = (userId: string, role: string): Ctx => ({ orgId: ORG_ID, userId, userName: userId, role, ip: "127.0.0.1", requestId: userId, permissions: SEED_ROLES.find((r) => r.key === role)!.permissions });
const owner = ctxFor("u-owner", "owner");
const md = ctxFor("u-md", "md");
const cfo = ctxFor("u-cfo", "finance_reviewer");
const ok = (m: string) => console.log("✓", m);

async function main() {
  const db = await getDb();
  await db.dropDatabase();
  await ensureSchema(db);
  for (const r of SEED_ROLES) await db.collection("roles").insertOne({ _id: `role:${r.key}` as never, orgId: ORG_ID, ...r });
  const profile = AgreementProfile.parse(SEED_PROFILE);
  await db.collection("agreement_profiles").insertOne({ _id: "profile-v1" as never, ...profile, activatedAt: new Date(), createdAt: new Date(), createdBy: "e2e" });
  for (const a of seedAccounts(profile)) await db.collection("accounts").insertOne({ ...a, orgId: ORG_ID } as never);
  await db.collection("couriers").insertOne({ _id: "c1" as never, orgId: ORG_ID, provider: "leopards", label: "LCS" });

  const P = "2026-10";
  await ensurePeriod(P);
  // Capital + inventory
  await post(owner, { type: "capital_tranche_released", date: "2026-10-01", trancheId: "t1", amountMinor: PKR(1_000_000), providerPartnerId: "muhammad", bankRef: "B1" }, profile);
  await post(owner, { type: "stock_purchased", date: "2026-10-01", refId: "s1", amountMinor: PKR(300_000), paidFrom: "bank" }, profile);

  // Sales via courier settlement: 2 delivered shipments, 250,000 COD, COGS 30,000 (exact)
  for (const [cn, cod] of [["KI1", 150_000], ["KI2", 100_000]] as const) {
    const id = await upsertShipment(owner, "c1", { cn, codMinor: PKR(cod), bookedAt: "2026-10-05T10:00:00Z", providerStatus: "Delivered", events: [{ providerStatus: "Delivered", at: "2026-10-07T10:00:00Z" }] }, "manual");
    await db.collection("shipments").updateOne({ _id: id as never }, { $set: { cogsMinor: PKR(cod === 150_000 ? 18_000 : 12_000), cogsEstimated: false, orderId: `o-${cn}` } });
  }
  const st = { courierId: "c1", reference: "CHQ-1", date: "2026-10-15", source: "csv" as const, lines: [{ cn: "KI1", codMinor: PKR(150_000), freightMinor: PKR(10_000), codFeeMinor: 0, returnFeeMinor: 0 }, { cn: "KI2", codMinor: PKR(100_000), freightMinor: PKR(10_000), codFeeMinor: 0, returnFeeMinor: 0 }] };
  const s1 = await recordSettlement(owner, st);
  assert.equal(s1.posted, 2);
  await assert.rejects(recordSettlement(owner, st), BusinessError);
  ok("settlement posts once; re-import rejected");

  // Expense needing approval (MD requests, owner approves) — ad hoc 0 limit → approval required
  const e = await createExpense(md, { categoryKey: "other", amount: "0.01", date: "2026-10-20", payee: "Rounding test", recurring: false });
  assert.equal(e.status, "pending");
  const ap = await db.collection("approvals").findOne({ refId: e._id });
  await assert.rejects(decideApproval(md, String(ap!._id), "approve", ""), /not an approver/);
  await decideApproval(owner, String(ap!._id), "approve", "ok");
  assert.equal((await db.collection("expenses").findOne({ _id: e._id as never }))!.status, "posted");
  // Reverse that 1 paisa with a manual balancing so NP stays round: post an other-income-free adjustment instead
  await postEntry(owner, { date: "2026-10-20", source: "manual_adjustment", memo: "e2e: offset 1 paisa", lines: [{ accountId: "bank", debitMinor: 1, creditMinor: 0 }, { accountId: "exp_other", debitMinor: 0, creditMinor: 1 }] });
  ok("expense approval: MD cannot approve, owner approval posts it");

  // NP = 250,000 − 30,000 COGS − 20,000 freight = 200,000
  await saveCloseInputs(cfo, P, { bankBalance: "930000", reserve: {} });
  await db.collection("integrations").deleteMany({});
  await startClose(cfo, P);
  await assert.rejects(post(owner, { type: "expense_posted", date: "2026-10-25", expenseId: "late", categoryKey: "other", amountMinor: 100, paidFrom: "bank" }, profile), /closing/);
  const snap = await closePeriod(cfo, P);
  const r = snap.result;
  assert.equal(r.netProfitMinor, PKR(200_000));
  assert.equal(r.reinvestment.minor, PKR(60_000));
  assert.deepEqual(r.partners.map((p) => p.allocationMinor), [PKR(70_000), PKR(70_000)]);
  assert.deepEqual(r.partners.map((p) => p.withdrawableMinor), [PKR(50_000), PKR(50_000)]);
  ok(`closed ${P}: NP 200,000 → reinvest 60,000 → 70,000 each, withdrawable 50,000 (cap)`);

  await assert.rejects(post(owner, { type: "expense_posted", date: "2026-10-26", expenseId: "late2", categoryKey: "other", amountMinor: 100, paidFrom: "bank" }, profile), /closed/);
  ok("closed period rejects new entries");

  // Withdrawal above cap is refused without override; at cap it goes through owner approval → paid
  await assert.rejects(requestWithdrawal(md, { partnerId: "hanan", periodId: P, amount: "60000" }), /breaks: cap/);
  const w = await requestWithdrawal(md, { partnerId: "hanan", periodId: P, amount: "50000" });
  const wa = await db.collection("approvals").findOne({ refId: w._id });
  await decideApproval(owner, String(wa!._id), "approve", "within cap");
  await payWithdrawal(cfo, w._id, "HBL-77");
  const after = await evaluateWithdrawal(ORG_ID, P, "hanan", 1);
  assert.equal(after.withdrawableMinor, 0);
  assert.equal(after.partner.closingUndrawnMinor, PKR(20_000));
  ok("withdrawal 50,000 paid; cap exhausted; undrawn 20,000");

  // Profile v2 (reinvestment credit pro rata), dual approval
  const v2 = await createDraft(owner, { ...profile, effectiveFrom: "2026-11-01", reinvestment: { ...profile.reinvestment, treatment: "credit_partners_pro_rata" } }, "switch treatment");
  await submitDraft(owner, v2.version);
  const pa = await db.collection("approvals").findOne({ refId: v2._id });
  const half = await decideApproval(owner, String(pa!._id), "approve", "yes");
  assert.equal(half.status, "pending");
  await decideApproval(md, String(pa!._id), "approve", "yes");
  assert.equal((await getProfileFor("2026-11-15")).reinvestment.treatment, "credit_partners_pro_rata");
  assert.equal((await getProfileFor("2026-10-15")).version, 1);
  assert.equal((await verifySnapshot(snap._id)).ok, true);
  await assert.rejects(createDraft(owner, { ...profile, effectiveFrom: "2026-10-01" }, "retro"), /after closed period/);
  ok("profile v2 needs both approvals; v1 period still reproduces; retroactive change refused");

  const chain = await verifyJournalChain();
  assert.equal(chain.ok, true);
  ok(`journal hash chain verifies (${chain.count} entries)`);
  const s = await getSnapshot(ORG_ID, P);
  assert.equal(s?.period.status, "closed");
}

main()
  .then(() => console.log("\nE2E month: all checks passed"))
  .catch((e) => {
    console.error("E2E FAILED:", e);
    process.exitCode = 1;
  })
  .finally(closeDb);

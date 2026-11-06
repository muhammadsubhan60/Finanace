/**
 * Background worker (separate process; never inside Next.js request handlers).
 * Scheduler: Mongo-backed leases in `job_locks` so only one worker runs a schedule at a time,
 * plus a simple `jobs` queue for on-demand work (resync range, webhook-triggered syncs).
 * BullMQ + Redis is the documented swap-in (docs/PLAN.md); the task functions stay the same.
 */
import { hostname } from "node:os";
import { addMonths, karachiDate, periodIdOf } from "@delta/core";
import {
  autoFinalize, closeDb, ensureSchema, evaluateAlerts, getDb, listIntegrations, ORG_ID, runIntegration, systemCtx, verifyJournalChain, getCurrentProfile, ensurePeriod,
} from "@delta/db";

const WORKER_ID = `${hostname()}:${process.pid}`;
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), worker: WORKER_ID, msg, ...extra }));

/** Acquire a lease; returns false if another worker holds it or it ran within `everyMs`. */
async function lease(name: string, everyMs: number, ttlMs = 15 * 60_000): Promise<boolean> {
  const db = await getDb();
  const now = Date.now();
  try {
    const r = await db.collection<{ _id: string; lockedUntil: Date; lastRunAt: Date; owner: string }>("job_locks").findOneAndUpdate(
      { _id: name, $or: [{ lockedUntil: { $lt: new Date(now) } }, { lockedUntil: { $exists: false } }], $and: [{ $or: [{ lastRunAt: { $lt: new Date(now - everyMs) } }, { lastRunAt: { $exists: false } }] }] },
      { $set: { lockedUntil: new Date(now + ttlMs), owner: WORKER_ID } },
      { upsert: true, returnDocument: "after" },
    );
    return !!r;
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return false; // lost the upsert race
    throw e;
  }
}
async function release(name: string) {
  const db = await getDb();
  await db.collection<{ _id: string }>("job_locks").updateOne({ _id: name }, { $set: { lockedUntil: new Date(0), lastRunAt: new Date() } });
}

async function scheduled(name: string, everyMs: number, fn: () => Promise<unknown>) {
  if (!(await lease(name, everyMs))) return;
  const started = Date.now();
  try {
    const result = await fn();
    log("job.ok", { job: name, ms: Date.now() - started, result });
  } catch (e) {
    log("job.error", { job: name, error: (e as Error).message });
  } finally {
    await release(name);
  }
}

const H = 3_600_000;

async function tick() {
  const integrations = (await listIntegrations(ORG_ID)).filter((i) => i.enabled);
  for (const i of integrations) {
    const every = i.type === "courier" ? (i.settings.pollHours ?? 4) * H : i.type === "meta" ? 6 * H : 1 * H;
    await scheduled(`sync:${i._id}`, every, () => runIntegration(i._id));
  }
  await scheduled("auto-finalize", 1 * H, () => autoFinalize(systemCtx("auto-finalize")));
  await scheduled("alerts", 1 * H, () => evaluateAlerts());
  await scheduled("ensure-periods", 6 * H, async () => {
    const p = periodIdOf(karachiDate());
    await ensurePeriod(p);
    await ensurePeriod(addMonths(p, -1));
  });
  await scheduled("close-reminder", 24 * H, async () => {
    const profile = await getCurrentProfile();
    const day = Number(karachiDate().slice(8));
    return day >= profile.reporting.closeDayOfMonth - 3 ? "reminder raised via alerts" : "not due";
  });
  await scheduled("verify-chain", 24 * H, async () => {
    const r = await verifyJournalChain();
    if (!r.ok) {
      const db = await getDb();
      await db.collection("alerts").updateOne({ orgId: ORG_ID, dedupeKey: `chain_broken:${r.brokenAtSeq}` }, { $setOnInsert: { orgId: ORG_ID, dedupeKey: `chain_broken:${r.brokenAtSeq}`, key: "chain_broken", severity: "critical", title: "Journal hash chain broken", detail: `Tampering suspected at entry #${r.brokenAtSeq}`, href: "/journal", createdAt: new Date(), acknowledgedAt: null } }, { upsert: true });
    }
    return r;
  });
  await drainQueue();
}

/** On-demand jobs (resync range, webhook-triggered syncs). Claimed atomically; retried up to 3 times. */
async function drainQueue() {
  const db = await getDb();
  for (let n = 0; n < 20; n++) {
    const job = await db.collection("jobs").findOneAndUpdate({ status: "queued" }, { $set: { status: "running", startedAt: new Date(), worker: WORKER_ID }, $inc: { attempts: 1 } }, { sort: { createdAt: 1 }, returnDocument: "after" });
    if (!job) return;
    try {
      let result: unknown = null;
      if (job.type === "sync") result = await runIntegration(job.params.integrationId, { from: job.params.from, to: job.params.to });
      await db.collection("jobs").updateOne({ _id: job._id }, { $set: { status: "done", finishedAt: new Date(), result } });
      log("queue.ok", { id: job._id, type: job.type });
    } catch (e) {
      const failed = (job.attempts ?? 1) >= 3;
      await db.collection("jobs").updateOne({ _id: job._id }, { $set: { status: failed ? "failed" : "queued", error: (e as Error).message } });
      log("queue.error", { id: job._id, error: (e as Error).message });
    }
  }
}

async function main() {
  const once = process.argv.includes("--once");
  log("worker.start", { once });
  await ensureSchema(await getDb()); // keep collections, validators and indexes current on deploy
  let stopping = false;
  const stop = async () => {
    stopping = true;
    log("worker.stop");
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  do {
    try {
      await tick();
    } catch (e) {
      log("tick.error", { error: (e as Error).message });
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, 30_000));
  } while (!stopping);
  await closeDb();
}

main();

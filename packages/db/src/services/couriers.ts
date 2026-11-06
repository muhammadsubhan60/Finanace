import type { NormalizedStatus } from "@delta/config-schema";
import {
  applyMapping, guessMapping, isTerminal, karachiDate, matchSettlementLines, matchShipment, normalizePhone, normalizeStatus, parseCsv, parsePKR, sha256, shipmentCogs,
  type ColumnMapping, type MatchOrder,
} from "@delta/core";
import type { SettlementIn, ShipmentSnapshot } from "@delta/integrations";
import { getDb, withTransaction } from "../client";
import { audit, BusinessError, newId, requirePerm, type Ctx } from "../context";
import { post } from "../journal";
import { getCurrentProfile, getProfileFor } from "./profile";

export interface ShipmentDoc {
  _id: string;
  orgId: string;
  courierId: string;
  provider: string;
  cn: string;
  orderRef: string | null;
  orderId: string | null;
  storeId: string | null;
  matchStrategy: string | null;
  matchConfidence: number;
  matchCandidates: { orderId: string; confidence: number }[];
  codAmountMinor: number;
  normalizedStatus: NormalizedStatus;
  providerStatus: string;
  consignee: { name?: string; phone?: string; city?: string };
  bookedAt: Date;
  bookedDate: string;
  deliveredAt?: Date | null;
  rtoAt?: Date | null;
  charges?: { freightMinor?: number; codFeeMinor?: number; returnFeeMinor?: number };
  settlementId: string | null;
  cogsMinor?: number;
  cogsEstimated?: boolean;
  revenueRecognized?: boolean;
  source: "api" | "csv" | "paste" | "manual" | "webhook";
  lastPolledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ship = async () => (await getDb()).collection<ShipmentDoc>("shipments");

async function courierDoc(orgId: string, courierId: string) {
  const c = await (await getDb()).collection("couriers").findOne({ orgId, _id: courierId as never });
  if (!c) throw new BusinessError("Courier not found");
  return c as unknown as { _id: string; provider: "leopards" | "trax" | "tcs"; label: string; costCentre?: string; defaultStoreId?: string };
}

// ---------------- Intake ----------------

/** Upsert a shipment from any intake source, then apply its status. Idempotent on (courierId, cn). */
export async function upsertShipment(ctx: Ctx, courierId: string, snap: ShipmentSnapshot, source: ShipmentDoc["source"]) {
  const c = await courierDoc(ctx.orgId, courierId);
  const col = await ship();
  const cn = snap.cn.trim().toUpperCase();
  if (!cn) throw new BusinessError("CN is required");
  const bookedAt = snap.bookedAt ? new Date(snap.bookedAt) : new Date();
  const now = new Date();
  await col.updateOne(
    { orgId: ctx.orgId, courierId, cn },
    {
      $setOnInsert: { _id: newId(), orgId: ctx.orgId, courierId, provider: c.provider, cn, orderId: null, storeId: c.defaultStoreId ?? null, matchStrategy: null, matchConfidence: 0, matchCandidates: [], normalizedStatus: "booked" as NormalizedStatus, providerStatus: "", settlementId: null, source, createdAt: now, bookedAt, bookedDate: karachiDate(bookedAt) },
      $set: {
        updatedAt: now,
        ...(snap.orderRef ? { orderRef: snap.orderRef } : {}),
        ...(snap.codMinor != null ? { codAmountMinor: snap.codMinor } : {}),
        ...(snap.consignee ? { consignee: snap.consignee } : {}),
        ...(snap.charges ? { charges: snap.charges } : {}),
      },
    },
    { upsert: true },
  );
  const doc = (await col.findOne({ orgId: ctx.orgId, courierId, cn }))!;
  if (doc.codAmountMinor == null) await col.updateOne({ _id: doc._id }, { $set: { codAmountMinor: 0 } });
  if (doc.orderRef === undefined) await col.updateOne({ _id: doc._id }, { $set: { orderRef: null } });
  if (snap.providerStatus || snap.events.length) await applyTracking(ctx, doc._id, snap);
  return doc._id;
}

export async function addCnsByPaste(ctx: Ctx, courierId: string, text: string) {
  requirePerm(ctx, "shipments:manage");
  const cns = [...new Set(text.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z0-9-]{6,30}$/.test(x)))];
  if (!cns.length) throw new BusinessError("No valid CN numbers found");
  for (const cn of cns) await upsertShipment(ctx, courierId, { cn, providerStatus: "", events: [] }, "paste");
  await audit(ctx, "shipments.paste", "courier", courierId, null, { count: cns.length });
  return cns.length;
}

export const BOOKING_TARGETS: Record<string, string[]> = {
  cn: ["cn", "cn number", "tracking number", "track number", "consignment", "consignment no"],
  order_ref: ["order id", "order ref", "reference", "order no", "order number", "booked packet order id"],
  cod_amount: ["cod amount", "collect amount", "cod", "amount"],
  consignee_name: ["consignee name", "consignee", "customer name"],
  phone: ["phone", "consignee phone", "mobile", "contact"],
  city: ["destination city", "city", "destination"],
  booked_date: ["booking date", "booked date", "date"],
  status: ["status", "booked packet status", "current status"],
};

export const SETTLEMENT_TARGETS: Record<string, string[]> = {
  cn: ["cn", "cn number", "tracking number", "consignment no", "cnsg no"],
  cod_amount: ["cod amount", "collect amount", "codamount", "cod"],
  freight: ["shipment charges", "freight", "delivery charges", "courier charges"],
  cod_fee: ["cash handling charges", "cod fee", "cod charges"],
  return_fee: ["return charges", "rto charges"],
  reference: ["invoice cheque no", "cheque no", "invoice no", "invoiceno", "payment reference"],
  date: ["invoice cheque date", "payment date", "cheque date"],
};

/** Saved, versioned column-mapping profiles per courier and import kind. */
export async function getMapping(orgId: string, courierId: string, kind: "booking" | "settlement") {
  const m = await (await getDb()).collection("mapping_profiles").find({ orgId, courierId, kind }).sort({ version: -1 }).limit(1).next();
  return (m?.mapping as ColumnMapping | undefined) ?? null;
}
async function saveMapping(ctx: Ctx, courierId: string, kind: string, mapping: ColumnMapping) {
  const db = await getDb();
  const last = await db.collection("mapping_profiles").find({ orgId: ctx.orgId, courierId, kind }).sort({ version: -1 }).limit(1).next();
  if (last && JSON.stringify(last.mapping) === JSON.stringify(mapping)) return;
  await db.collection("mapping_profiles").insertOne({ _id: newId() as never, orgId: ctx.orgId, courierId, kind, version: (last?.version ?? 0) + 1, mapping, createdAt: new Date(), createdBy: ctx.userId });
}

/** Step 1 of any CSV import: parse, hash, propose a mapping, store an import job for preview. */
export async function stageCsvImport(ctx: Ctx, args: { courierId: string; kind: "booking" | "settlement"; fileName: string; text: string }) {
  requirePerm(ctx, "import:upload");
  const fileHash = sha256(args.text);
  const db = await getDb();
  const dup = await db.collection("import_jobs").findOne({ orgId: ctx.orgId, fileHash, kind: args.kind, status: "posted" });
  if (dup) throw new BusinessError(`This exact file was already imported on ${dup.postedAt?.toISOString().slice(0, 10)} (job ${dup._id}). Nothing to do.`);
  const { headers, rows } = parseCsv(args.text);
  if (!rows.length) throw new BusinessError("The file has no data rows");
  if (rows.length > 20000) throw new BusinessError("Max 20,000 rows per file");
  const mapping = (await getMapping(ctx.orgId, args.courierId, args.kind)) ?? guessMapping(headers, args.kind === "booking" ? BOOKING_TARGETS : SETTLEMENT_TARGETS);
  const job = { _id: newId(), orgId: ctx.orgId, kind: args.kind, courierId: args.courierId, fileName: args.fileName, fileHash, headers, rows, mapping, status: "staged", createdAt: new Date(), createdBy: ctx.userId };
  await db.collection("import_jobs").insertOne(job as never);
  await audit(ctx, "import.stage", "import_job", job._id, null, { kind: args.kind, fileName: args.fileName, rows: rows.length, fileHash });
  return job._id;
}

export async function updateImportMapping(ctx: Ctx, jobId: string, mapping: ColumnMapping) {
  requirePerm(ctx, "import:upload");
  await (await getDb()).collection("import_jobs").updateOne({ _id: jobId as never, orgId: ctx.orgId, status: "staged" }, { $set: { mapping } });
}

const money = (v: string | undefined) => {
  if (!v || !v.trim()) return 0;
  try {
    return parsePKR(v);
  } catch {
    return NaN;
  }
};

export async function previewImport(orgId: string, jobId: string) {
  const db = await getDb();
  const job = await db.collection("import_jobs").findOne({ _id: jobId as never, orgId });
  if (!job) throw new BusinessError("Import not found");
  const mapped = applyMapping(job.rows, job.mapping);
  if (job.kind === "booking") {
    const rows: (Record<string, string> & { i: number; codMinor: number; errors: string[] })[] = mapped.map((r, i) => {
      const errors: string[] = [];
      if (!r.cn) errors.push("CN missing");
      const cod = money(r.cod_amount);
      if (Number.isNaN(cod)) errors.push("Bad COD amount");
      return Object.assign({}, r, { i, codMinor: cod, errors });
    });
    return { job, kind: "booking" as const, rows, lines: [] as ReturnType<typeof matchSettlementLines> };
  }
  const shipments = await db.collection<ShipmentDoc>("shipments").find({ orgId, courierId: job.courierId, cn: { $in: mapped.map((r) => (r.cn ?? "").trim().toUpperCase()) } }).toArray();
  const lines = matchSettlementLines(
    mapped.map((r, i) => ({ lineKey: `${job.fileHash}:${i}`, cn: r.cn ?? "", codMinor: money(r.cod_amount) || 0, freightMinor: money(r.freight) || 0, codFeeMinor: money(r.cod_fee) || 0, returnFeeMinor: money(r.return_fee) || 0 })),
    shipments.map((s) => ({ id: s._id, cn: s.cn, codAmountMinor: s.codAmountMinor, normalizedStatus: s.normalizedStatus, settlementId: s.settlementId })),
  );
  const ref = mapped.find((r) => r.reference)?.reference ?? "";
  const date = mapped.find((r) => r.date)?.date ?? "";
  return { job, kind: "settlement" as const, rows: [], lines, suggestedReference: ref, suggestedDate: date };
}

/** Confirm: booking list → shipments; settlement → cod_settlement + lines + exactly-once journal posting. */
export async function confirmImport(ctx: Ctx, jobId: string, args: { reference?: string; date?: string; netReceived?: string } = {}) {
  requirePerm(ctx, "import:upload");
  const pv = await previewImport(ctx.orgId, jobId);
  const db = await getDb();
  if (pv.job.status !== "staged") throw new BusinessError("Import already processed");
  await saveMapping(ctx, pv.job.courierId, pv.kind, pv.job.mapping);
  if (pv.kind === "booking") {
    let ok = 0;
    for (const r of pv.rows) {
      if (r.errors.length) continue;
      await upsertShipment(ctx, pv.job.courierId, {
        cn: r.cn!,
        orderRef: r.order_ref || null,
        codMinor: r.codMinor,
        consignee: { name: r.consignee_name, phone: r.phone, city: r.city },
        bookedAt: r.booked_date ? parseLooseDate(r.booked_date) : undefined,
        providerStatus: r.status ?? "",
        events: r.status ? [{ providerStatus: r.status, at: new Date().toISOString() }] : [],
      }, "csv");
      ok++;
    }
    await db.collection("import_jobs").updateOne({ _id: jobId as never }, { $set: { status: "posted", postedAt: new Date(), results: { imported: ok, errors: pv.rows.length - ok } } });
    await runMatching(ctx);
    return { imported: ok };
  }
  const reference = (args.reference || pv.suggestedReference || pv.job.fileHash.slice(0, 12)).trim();
  const date = args.date || pv.suggestedDate?.slice(0, 10) || karachiDate();
  return recordSettlement(ctx, {
    courierId: pv.job.courierId,
    reference,
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : karachiDate(),
    lines: pv.lines.map((l) => ({ cn: l.cn, codMinor: l.codMinor, freightMinor: l.freightMinor, codFeeMinor: l.codFeeMinor, returnFeeMinor: l.returnFeeMinor })),
    netReceivedMinor: args.netReceived ? parsePKR(args.netReceived) : undefined,
    source: "csv",
    importJobId: jobId,
  });
}

function parseLooseDate(s: string): string {
  const t = s.trim();
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(t);
  if (dmy) return new Date(`${dmy[3]!.length === 2 ? "20" + dmy[3] : dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}T00:00:00+05:00`).toISOString();
  const d = new Date(t.length <= 10 ? `${t}T00:00:00+05:00` : t);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/**
 * Record one courier remittance. Lines that match a delivered, unsettled shipment are posted;
 * all others are stored with their flag for the reconciliation queue. Idempotent on (courier, reference).
 */
export async function recordSettlement(ctx: Ctx, s: Omit<SettlementIn, "netReceivedMinor"> & { courierId: string; source: "api" | "csv"; importJobId?: string; netReceivedMinor?: number }) {
  const db = await getDb();
  const existing = await db.collection("cod_settlements").findOne({ orgId: ctx.orgId, courierId: s.courierId, reference: s.reference });
  if (existing) throw new BusinessError(`Settlement ${s.reference} is already recorded`);
  const shipments = await db.collection<ShipmentDoc>("shipments").find({ orgId: ctx.orgId, courierId: s.courierId, cn: { $in: s.lines.map((l) => l.cn.trim().toUpperCase()) } }).toArray();
  const matched = matchSettlementLines(s.lines.map((l, i) => ({ lineKey: `${s.reference}:${i}`, ...l })), shipments.map((x) => ({ id: x._id, cn: x.cn, codAmountMinor: x.codAmountMinor, normalizedStatus: x.normalizedStatus, settlementId: x.settlementId })));
  const postable = matched.filter((l) => l.flag === "ok" || l.flag === "amount_differs");
  const sum = (f: (l: (typeof matched)[number]) => number, arr = postable) => arr.reduce((a, l) => a + f(l), 0);
  const gross = sum((l) => l.codMinor, matched);
  const ded = sum((l) => l.freightMinor + l.codFeeMinor + l.returnFeeMinor, matched);
  const netReceivedMinor = s.netReceivedMinor ?? gross - ded;
  const settlementId = newId();
  const profile = await getProfileFor(s.date);
  const shipById = new Map(shipments.map((x) => [x._id, x]));
  await withTransaction(async (session) => {
    await db.collection("cod_settlements").insertOne({ _id: settlementId as never, orgId: ctx.orgId, courierId: s.courierId, reference: s.reference, date: s.date, grossCodMinor: gross, deductionsMinor: ded, netReceivedMinor, status: matched.every((l) => l.flag === "ok") ? "reconciled" : "has_exceptions", source: s.source, importJobId: s.importJobId ?? null, createdAt: new Date(), createdBy: ctx.userId }, { session });
    await db.collection("cod_settlement_lines").insertMany(matched.map((l) => ({ _id: newId() as never, orgId: ctx.orgId, settlementId, courierId: s.courierId, ...l, posted: l.flag === "ok" || l.flag === "amount_differs", resolved: l.flag === "ok" })), { session });
    // Net received split: postable lines carry their own share; non-postable deductions still hit the bank line.
    const postNet = netReceivedMinor - sum((l) => l.codMinor - l.freightMinor - l.codFeeMinor - l.returnFeeMinor, matched.filter((l) => !(l.flag === "ok" || l.flag === "amount_differs")));
    const lines = postable.map((l) => {
      const sh = shipById.get(l.shipmentId!)!;
      // Returned parcels (no COD collected) carry charges only: no revenue and no COGS — the goods came back.
      const cogs = l.codMinor > 0 ? shipmentCogsFor(sh, profile) : { cogsMinor: 0, estimated: false };
      return { shipmentId: sh._id, codMinor: l.codMinor, cogsMinor: cogs.cogsMinor, storeId: sh.storeId ?? undefined };
    });
    if (lines.length) {
      await post(ctx, {
        type: "cod_settlement", date: s.date, settlementId, lines,
        freightMinor: sum((l) => l.freightMinor), codFeeMinor: sum((l) => l.codFeeMinor), returnFeeMinor: sum((l) => l.returnFeeMinor), otherDeductionsMinor: 0,
        netReceivedMinor: Math.max(0, postNet),
      }, profile, { session });
      for (const l of postable) {
        const sh = shipById.get(l.shipmentId!)!;
        const sold = l.codMinor > 0;
        const cogs = sold ? shipmentCogsFor(sh, profile) : { cogsMinor: 0, estimated: false };
        await db.collection<ShipmentDoc>("shipments").updateOne({ _id: sh._id }, { $set: { settlementId, revenueRecognized: sold, cogsMinor: cogs.cogsMinor, cogsEstimated: cogs.estimated, updatedAt: new Date() } }, { session });
      }
    }
    if (s.importJobId) await db.collection("import_jobs").updateOne({ _id: s.importJobId as never }, { $set: { status: "posted", postedAt: new Date(), results: { posted: postable.length, exceptions: matched.length - postable.length, settlementId } } }, { session });
    await audit(ctx, "settlement.record", "cod_settlement", settlementId, null, { reference: s.reference, gross, ded, netReceivedMinor, lines: matched.length }, session);
  });
  return { settlementId, posted: postable.length, exceptions: matched.length - postable.length };
}

function shipmentCogsFor(sh: ShipmentDoc, profile: Awaited<ReturnType<typeof getCurrentProfile>>) {
  return sh.cogsMinor != null && sh.cogsEstimated === false ? { cogsMinor: sh.cogsMinor, estimated: false } : shipmentCogs({ codMinor: sh.codAmountMinor, exactCogsMinor: sh.cogsEstimated === false ? sh.cogsMinor : null, storeId: sh.storeId }, profile);
}

export async function resolveSettlementLine(ctx: Ctx, lineId: string, note: string) {
  requirePerm(ctx, "import:upload");
  if (!note.trim()) throw new BusinessError("A note is required");
  await (await getDb()).collection("cod_settlement_lines").updateOne({ _id: lineId as never, orgId: ctx.orgId }, { $set: { resolved: true, resolutionNote: note, resolvedBy: ctx.userName, resolvedAt: new Date() } });
  await audit(ctx, "settlement_line.resolve", "cod_settlement_line", lineId, null, { note });
}

// ---------------- Tracking ----------------

export async function applyTracking(ctx: Ctx, shipmentId: string, snap: ShipmentSnapshot) {
  const db = await getDb();
  const col = await ship();
  const sh = await col.findOne({ _id: shipmentId });
  if (!sh) return;
  const profile = await getCurrentProfile();
  // Event log (idempotent by provider+cn+timestamp+status)
  for (const e of snap.events) {
    const n = normalizeStatus(profile, sh.provider, e.providerStatus);
    const dedupeKey = `${sh.provider}:${sh.cn}:${e.at}:${e.providerStatus.toLowerCase()}`;
    await db.collection("shipment_events").updateOne({ orgId: ctx.orgId, dedupeKey }, { $setOnInsert: { _id: newId() as never, orgId: ctx.orgId, dedupeKey, shipmentId, cn: sh.cn, provider: sh.provider, providerStatus: e.providerStatus, normalizedStatus: n.status, eventAt: new Date(e.at), location: e.location ?? null, raw: e.raw ?? null, createdAt: new Date() } }, { upsert: true });
  }
  const latest = snap.providerStatus || snap.events[snap.events.length - 1]?.providerStatus || "";
  if (!latest) return;
  const n = normalizeStatus(profile, sh.provider, latest);
  if (!n.mapped) {
    await db.collection("unmapped_statuses").updateOne({ orgId: ctx.orgId, provider: sh.provider, status: latest.trim().toLowerCase() }, { $setOnInsert: { _id: newId() as never, firstSeenAt: new Date(), example: sh.cn }, $inc: { count: 1 }, $set: { lastSeenAt: new Date(), resolved: false } }, { upsert: true });
  }
  if (n.status === "unknown" && sh.normalizedStatus !== "booked") {
    await col.updateOne({ _id: sh._id }, { $set: { providerStatus: latest, lastPolledAt: new Date() } });
    return; // never regress a known status to unknown
  }
  const prev = sh.normalizedStatus;
  const evAt = (status: NormalizedStatus) => {
    const e = [...snap.events].reverse().find((x) => normalizeStatus(profile, sh.provider, x.providerStatus).status === status);
    return e ? new Date(e.at) : new Date();
  };
  const set: Partial<ShipmentDoc> = { providerStatus: latest, normalizedStatus: n.status, lastPolledAt: new Date(), updatedAt: new Date() };
  if (n.status === "delivered" && !sh.deliveredAt) set.deliveredAt = evAt("delivered");
  if (n.status === "returned_to_origin" && !sh.rtoAt) set.rtoAt = evAt("returned_to_origin");
  await col.updateOne({ _id: sh._id }, { $set: set });
  if (prev !== n.status) await onStatusChange(ctx, { ...sh, ...set } as ShipmentDoc, prev);
}

async function onStatusChange(ctx: Ctx, sh: ShipmentDoc, _prev: NormalizedStatus) {
  const date = karachiDate(sh.deliveredAt ?? sh.rtoAt ?? new Date());
  const profile = await getProfileFor(date);
  const open = await isOpen(ctx.orgId, date);
  const postDate = open ? date : karachiDate();
  const cogs = shipmentCogsFor(sh, profile);
  if (sh.normalizedStatus === "delivered" && profile.revenueRecognition.event === "delivered") {
    const e = await post(ctx, { type: "shipment_delivered", date: postDate, shipmentId: sh._id, codMinor: revenueOf(sh), cogsMinor: cogs.cogsMinor, storeId: sh.storeId ?? undefined }, profile);
    if (e) await (await ship()).updateOne({ _id: sh._id }, { $set: { revenueRecognized: true, cogsMinor: cogs.cogsMinor, cogsEstimated: cogs.estimated } });
  }
  if (sh.normalizedStatus === "returned_to_origin") await writeOffReturn(ctx, sh, postDate);
  if (sh.normalizedStatus === "returned_to_origin" && sh.revenueRecognized && !sh.settlementId) {
    await post(ctx, { type: "shipment_rto", date: postDate, shipmentId: sh._id, codMinor: revenueOf(sh), cogsMinor: sh.cogsMinor ?? cogs.cogsMinor, wasRecognized: true, storeId: sh.storeId ?? undefined }, profile);
    await (await ship()).updateOne({ _id: sh._id }, { $set: { revenueRecognized: false } });
  }
}

const revenueOf = (sh: ShipmentDoc) => sh.codAmountMinor;

async function isOpen(orgId: string, date: string) {
  const p = await (await getDb()).collection("periods").findOne({ orgId, periodId: date.slice(0, 7) });
  return !p || p.status === "open";
}

/** CNs the worker should poll: not terminal, not polled within `hours`. */
export async function shipmentsToPoll(orgId: string, courierId: string, hours: number, limit = 500) {
  const terminal: NormalizedStatus[] = ["delivered", "returned_to_origin", "cancelled", "lost_or_damaged"];
  return (await ship())
    .find({ orgId, courierId, normalizedStatus: { $nin: terminal }, pollStopped: { $ne: true }, $or: [{ lastPolledAt: null }, { lastPolledAt: { $exists: false } }, { lastPolledAt: { $lt: new Date(Date.now() - hours * 3_600_000) } }] })
    .limit(limit)
    .toArray();
}
export { isTerminal };

// ---------------- Matching ----------------

export async function runMatching(ctx: Ctx, onlyIds?: string[]) {
  const db = await getDb();
  const profile = await getCurrentProfile();
  const unmatched = await (await ship()).find({ orgId: ctx.orgId, orderId: null, ...(onlyIds ? { _id: { $in: onlyIds } } : {}) }).limit(2000).toArray();
  if (!unmatched.length) return { matched: 0, queued: 0 };
  const fuzzy = profile.matching.strategies.find((s) => s.type === "fuzzy");
  const window = (fuzzy && "dateWindowDays" in fuzzy ? fuzzy.dateWindowDays : 3) + 1;
  const minDate = new Date(Math.min(...unmatched.map((s) => s.bookedAt.getTime())) - window * 86_400_000);
  const linked = new Set((await (await ship()).distinct("orderId", { orgId: ctx.orgId, orderId: { $ne: null } })) as string[]);
  const refs = unmatched.map((s) => s.orderRef).filter(Boolean).map((r) => "#" + String(r).replace(/^#/, ""));
  const orders = await db.collection("orders").find({ orgId: ctx.orgId, $or: [{ createdAt: { $gte: minDate } }, { name: { $in: refs } }, { trackingNumbers: { $in: unmatched.map((s) => s.cn) } }] }).toArray();
  const candidates: (MatchOrder & { storeId: string })[] = orders.filter((o) => !linked.has(String(o._id))).map((o) => ({ id: String(o._id), name: o.name, trackingNumbers: o.trackingNumbers ?? [], phone: o.customer?.phone, city: o.customer?.city, totalMinor: o.totalMinor, createdDate: karachiDate(o.createdAt), storeId: o.storeId }));
  let matched = 0;
  let queued = 0;
  for (const sh of unmatched) {
    const r = matchShipment({ cn: sh.cn, orderRef: sh.orderRef, phone: sh.consignee?.phone, city: sh.consignee?.city, codMinor: sh.codAmountMinor, bookedDate: sh.bookedDate }, candidates, profile);
    if (r.orderId) {
      await linkShipment(ctx, sh._id, r.orderId, r.strategy ?? "auto", r.confidence, true);
      const idx = candidates.findIndex((c) => c.id === r.orderId);
      if (idx >= 0) candidates.splice(idx, 1);
      matched++;
    } else {
      await (await ship()).updateOne({ _id: sh._id }, { $set: { matchStrategy: "manual_queue", matchCandidates: r.candidates, matchConfidence: r.confidence } });
      queued++;
    }
  }
  return { matched, queued };
}

/** Link (auto or manual). Computes exact COGS from order lines; trues up COGS already posted as an estimate. */
export async function linkShipment(ctx: Ctx, shipmentId: string, orderId: string, strategy = "manual", confidence = 1, system = false) {
  if (!system) requirePerm(ctx, "shipments:manage");
  const db = await getDb();
  const sh = await (await ship()).findOne({ _id: shipmentId, orgId: ctx.orgId });
  const order = await db.collection("orders").findOne({ _id: orderId as never, orgId: ctx.orgId });
  if (!sh || !order) throw new BusinessError("Shipment or order not found");
  const exact = await exactCogs(ctx.orgId, order);
  const set: Record<string, unknown> = { orderId, storeId: order.storeId, matchStrategy: strategy, matchConfidence: confidence, matchCandidates: [], updatedAt: new Date() };
  if (order.totalMinor !== sh.codAmountMinor && order.paymentMethod === "cod") set.amountMismatchMinor = sh.codAmountMinor - order.totalMinor;
  if (exact != null) {
    set.cogsMinor = exact;
    set.cogsEstimated = false;
    if (sh.revenueRecognized && sh.cogsEstimated && sh.cogsMinor != null && exact !== sh.cogsMinor) {
      const profile = await getCurrentProfile();
      await post(ctx, { type: "cogs_true_up", date: karachiDate(), shipmentId, deltaMinor: exact - sh.cogsMinor, storeId: order.storeId }, profile);
    }
  }
  await (await ship()).updateOne({ _id: shipmentId }, { $set: set });
  if (strategy === "manual") await db.collection("manual_links").insertOne({ _id: newId() as never, orgId: ctx.orgId, shipmentId, orderId, cn: sh.cn, orderName: order.name, by: ctx.userId, at: new Date() });
  await audit(ctx, "shipment.link", "shipment", shipmentId, { orderId: sh.orderId }, { orderId, strategy, confidence });
}

export async function unlinkShipment(ctx: Ctx, shipmentId: string) {
  requirePerm(ctx, "shipments:manage");
  await (await ship()).updateOne({ _id: shipmentId, orgId: ctx.orgId }, { $set: { orderId: null, matchStrategy: "manual_queue", matchConfidence: 0 } });
  await audit(ctx, "shipment.unlink", "shipment", shipmentId, null, null);
}

async function exactCogs(orgId: string, order: Record<string, unknown>): Promise<number | null> {
  const items = (order.lineItems ?? []) as { sku?: string; quantity: number; unitCostMinor?: number | null }[];
  if (!items.length) return null;
  const db = await getDb();
  let total = 0;
  for (const li of items) {
    let unit = li.unitCostMinor;
    if (unit == null && li.sku) unit = (await db.collection("stock_items").findOne({ orgId, sku: li.sku }))?.avgCostMinor ?? null;
    if (unit == null) return null;
    total += unit * li.quantity;
  }
  return total;
}

export { normalizePhone };

// ---------------- Returns, COGS estimates, cancellations ----------------

/** Non-resellable returns (profile.stock.returnsRecoverable = false): write the goods off once, at estimated cost. */
async function writeOffReturn(ctx: Ctx, sh: ShipmentDoc, date: string) {
  const profile = await getProfileFor(date);
  if (profile.stock.returnsRecoverable || (sh as ShipmentDoc & { rtoWrittenOffMinor?: number }).rtoWrittenOffMinor != null) return 0;
  const { cogsMinor } = shipmentCogs({ codMinor: sh.codAmountMinor, storeId: sh.storeId }, profile);
  if (cogsMinor > 0) await post(ctx, { type: "stock_adjustment", date, refId: `rto:${sh._id}`, amountMinor: cogsMinor, reason: "write_down" }, profile);
  await (await ship()).updateOne({ _id: sh._id }, { $set: { rtoWrittenOffMinor: cogsMinor } as never });
  return cogsMinor;
}

/**
 * Re-estimate COGS for recognized shipments still on an estimate (after the profile's fallback changes),
 * posting true-ups in the original period when it is still open, else today; and write off returns not yet written off.
 */
export async function recomputeEstimatedCogs(ctx: Ctx) {
  requirePerm(ctx, "stock:manage");
  const db = await getDb();
  let trueUps = 0, deltaMinor = 0, writeOffs = 0, writeOffMinor = 0;
  for (const sh of await (await ship()).find({ orgId: ctx.orgId, revenueRecognized: true, cogsEstimated: true }).toArray()) {
    const st = sh.settlementId ? await db.collection("cod_settlements").findOne({ _id: sh.settlementId as never }) : null;
    const when = (st?.date as string | undefined) ?? karachiDate();
    const date = (await isOpen(ctx.orgId, when)) ? when : karachiDate();
    const profile = await getProfileFor(date);
    const next = shipmentCogs({ codMinor: sh.codAmountMinor, storeId: sh.storeId }, profile).cogsMinor;
    const delta = next - (sh.cogsMinor ?? 0);
    if (delta !== 0) {
      await post(ctx, { type: "cogs_true_up", date, shipmentId: sh._id, deltaMinor: delta, storeId: sh.storeId ?? undefined }, profile);
      await (await ship()).updateOne({ _id: sh._id }, { $set: { cogsMinor: next } });
      trueUps++;
      deltaMinor += delta;
    }
  }
  for (const sh of await (await ship()).find({ orgId: ctx.orgId, normalizedStatus: "returned_to_origin", rtoWrittenOffMinor: { $exists: false } } as never).toArray()) {
    const when = karachiDate(sh.rtoAt ?? sh.updatedAt);
    const m = await writeOffReturn(ctx, sh, (await isOpen(ctx.orgId, when)) ? when : karachiDate());
    if (m) {
      writeOffs++;
      writeOffMinor += m;
    }
  }
  await audit(ctx, "cogs.recompute", "shipments", "*", null, { trueUps, deltaMinor, writeOffs, writeOffMinor });
  return { trueUps, deltaMinor, writeOffs, writeOffMinor };
}

/** Mark bookings that never shipped as cancelled (stops polling, removes them from COD in transit). */
export async function cancelShipments(ctx: Ctx, cns: string[], reason: string) {
  requirePerm(ctx, "shipments:manage");
  if (!reason.trim()) throw new BusinessError("A reason is required");
  const col = await ship();
  const list = await col.find({ orgId: ctx.orgId, cn: { $in: cns.map((c) => c.trim().toUpperCase()) }, normalizedStatus: { $in: ["booked", "picked_up"] } }).toArray();
  for (const sh of list) {
    await col.updateOne({ _id: sh._id }, { $set: { normalizedStatus: "cancelled", pollStopped: true, cancelReason: reason, updatedAt: new Date() } as never });
    await audit(ctx, "shipment.cancel", "shipment", sh._id, { normalizedStatus: sh.normalizedStatus }, { normalizedStatus: "cancelled", reason });
  }
  return list.length;
}

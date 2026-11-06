"use server";

import { createDraft, deleteDraft, getCurrentProfile, getDb, ORG_ID, submitDraft, audit } from "@delta/db";
import { parsePKR } from "@delta/core";
import { NormalizedStatus } from "@delta/config-schema";
import { act, str, type ActionState } from "@/lib/action";

const P = ["/configuration", "/approvals"];

/** Key settings form → new draft version built from the active profile. */
export async function draftFromForm(_: ActionState, fd: FormData) {
  return act("config:propose", async (ctx) => {
    const base = structuredClone(await getCurrentProfile());
    const num = (k: string) => Number(str(fd, k));
    base.effectiveFrom = str(fd, "effectiveFrom");
    base.reinvestment.pct = num("reinvestmentPct");
    base.reinvestment.treatment = str(fd, "reinvestmentTreatment") as typeof base.reinvestment.treatment;
    base.revenueRecognition.event = str(fd, "recognitionEvent") as typeof base.revenueRecognition.event;
    base.withdrawalCap.enabled = fd.get("capEnabled") === "on";
    base.withdrawalCap.perPartnerMinor = parsePKR(str(fd, "capAmount"));
    base.withdrawalCap.months = num("capMonths");
    base.cashSafeguards.bufferDays = num("bufferDays");
    base.finalization.days = num("finalDays");
    base.finalization.objectionWindowDays = num("objectionDays");
    base.reporting.closeDayOfMonth = num("closeDay");
    base.reporting.payoutTargetDayOfMonth = num("payoutDay");
    base.matching.unmatchedBlocksClose = fd.get("unmatchedBlocks") === "on";
    base.stock.valuation = str(fd, "valuation") as typeof base.stock.valuation;
    base.stock.returnsRecoverable = fd.get("returnsRecoverable") === "on";
    const mode = str(fd, "fallbackMode") === "per_unit" ? "per_unit" : "ratio";
    base.matching.fallbackCogs = mode === "per_unit" ? { mode, unitPriceMinor: parsePKR(str(fd, "unitPrice")), unitCostMinor: parsePKR(str(fd, "unitCost")) } : { mode };
    if (mode === "per_unit" && !base.matching.fallbackCogs.unitPriceMinor) throw new Error("Unit price is required for per-unit mode");
    base.matching.fallbackCogsRatioBps = { ...base.matching.fallbackCogsRatioBps, "*": Math.round(Number(str(fd, "fallbackPct") || "40") * 100) };
    for (const c of base.expenseCategories) {
      if (c.type === "system") continue;
      c.enabled = fd.get(`cat:${c.key}`) === "on";
      c.paused = fd.get(`pause:${c.key}`) === "on";
    }
    for (const r of base.approvalPolicy) {
      const v = str(fd, `limit:${r.action}:${r.scope ?? ""}`);
      r.limitMinor = v === "" ? null : parsePKR(v);
    }
    for (const p of base.partners) p.sharePct = Number(str(fd, `share:${p.partnerId}`));
    const d = await createDraft(ctx, base, str(fd, "changeNote") || "Settings change");
    return `Draft v${d.version} created — review the diff and submit for approval`;
  }, P);
}

export async function draftFromJson(_: ActionState, fd: FormData) {
  return act("config:propose", async (ctx) => {
    let json: unknown;
    try {
      json = JSON.parse(str(fd, "json"));
    } catch {
      throw new Error("That is not valid JSON");
    }
    const d = await createDraft(ctx, json, str(fd, "changeNote") || "JSON edit");
    return `Draft v${d.version} created`;
  }, P);
}

export async function submit(_: ActionState, fd: FormData) {
  return act("config:propose", async (ctx) => {
    await submitDraft(ctx, Number(str(fd, "version")));
    return "Submitted: needs approval from owner and MD";
  }, P);
}

export async function discard(_: ActionState, fd: FormData) {
  return act("config:propose", async (ctx) => {
    await deleteDraft(ctx, Number(str(fd, "version")));
    return "Draft discarded";
  }, P);
}

/** Status mappings are profile data, so a mapping change is also a new profile version (dual approval). */
export async function mapStatuses(_: ActionState, fd: FormData) {
  return act("config:propose", async (ctx) => {
    const base = structuredClone(await getCurrentProfile());
    let n = 0;
    for (const [k, v] of fd.entries()) {
      if (!k.startsWith("m:") || !v) continue;
      const [, provider, status] = k.split(":");
      base.statusMappings[provider!] = { ...(base.statusMappings[provider!] ?? {}), [status!]: NormalizedStatus.parse(v) };
      n++;
    }
    if (!n) throw new Error("Choose at least one mapping");
    const d = await createDraft(ctx, { ...base, effectiveFrom: str(fd, "effectiveFrom") }, `Map ${n} courier status(es)`);
    const db = await getDb();
    await db.collection("unmapped_statuses").updateMany({ orgId: ORG_ID, resolved: { $ne: true }, $or: [...fd.keys()].filter((k) => k.startsWith("m:") && fd.get(k)).map((k) => ({ provider: k.split(":")[1], status: k.split(":")[2] })) }, { $set: { pendingVersion: d.version } });
    await audit(ctx, "status_map.draft", "agreement_profile", String(d.version), null, { n });
    return `Draft v${d.version} created with ${n} mapping(s). Submit it for approval below.`;
  }, ["/configuration/status-mappings", ...P]);
}


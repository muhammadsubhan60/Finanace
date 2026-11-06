"use server";

import { redirect } from "next/navigation";
import { resolveSettlementLine, stageCsvImport, tcsSettlementByInvoice } from "@delta/db";
import { act, str, type ActionState } from "@/lib/action";

export async function uploadSettlement(_: ActionState, fd: FormData): Promise<ActionState> {
  const file = fd.get("file") as File | null;
  let jobId = "";
  const r = await act("import:upload", async (ctx) => {
    if (!file || !file.size) throw new Error("Choose a CSV file");
    if (!/\.csv$/i.test(file.name)) throw new Error("CSV only in v1 — export XLSX as CSV first");
    jobId = await stageCsvImport(ctx, { courierId: str(fd, "courierId"), kind: "settlement", fileName: file.name, text: await file.text() });
  });
  if (r?.ok) redirect(`/imports/${jobId}`);
  return r;
}

export async function resolveLine(_: ActionState, fd: FormData) {
  return act("import:upload", async (ctx) => {
    await resolveSettlementLine(ctx, str(fd, "lineId"), str(fd, "note"));
    return "Resolved";
  }, ["/cod"]);
}

export async function tcsInvoice(_: ActionState, fd: FormData) {
  return act("import:upload", async (ctx) => {
    const r = await tcsSettlementByInvoice(ctx, str(fd, "integrationId"), str(fd, "invoiceNo"));
    return `Posted ${r.posted} lines, ${r.exceptions} exceptions`;
  }, ["/cod"]);
}

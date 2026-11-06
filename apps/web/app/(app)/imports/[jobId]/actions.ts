"use server";

import { confirmImport, updateImportMapping } from "@delta/db";
import { act, str, type ActionState } from "@/lib/action";

export async function saveMapping(_: ActionState, fd: FormData) {
  const jobId = str(fd, "jobId");
  const mapping: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (k.startsWith("map:")) mapping[k.slice(4)] = String(v);
  return act("import:upload", async (ctx) => {
    await updateImportMapping(ctx, jobId, mapping);
    return "Mapping applied";
  }, [`/imports/${jobId}`]);
}

export async function confirm(_: ActionState, fd: FormData) {
  const jobId = str(fd, "jobId");
  return act("import:upload", async (ctx) => {
    const r = await confirmImport(ctx, jobId, { reference: str(fd, "reference"), date: str(fd, "date"), netReceived: str(fd, "netReceived") });
    if ("settlementId" in r) return `Posted ${r.posted} lines; ${r.exceptions} exceptions kept for review`;
    return `Imported ${r.imported} shipments`;
  }, [`/imports/${jobId}`, "/cod", "/shipments"]);
}

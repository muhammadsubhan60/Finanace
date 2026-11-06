"use server";

import { addCnsByPaste, cancelShipments, linkShipment, runMatching, stageCsvImport, unlinkShipment, upsertShipment } from "@delta/db";
import { parsePKR } from "@delta/core";
import { redirect } from "next/navigation";
import { act, str, type ActionState } from "@/lib/action";

export async function pasteCns(_: ActionState, fd: FormData) {
  return act("shipments:manage", async (ctx) => `${await addCnsByPaste(ctx, str(fd, "courierId"), str(fd, "cns"))} CNs added and queued for tracking`, ["/shipments"]);
}

export async function addOne(_: ActionState, fd: FormData) {
  return act("shipments:manage", async (ctx) => {
    await upsertShipment(ctx, str(fd, "courierId"), { cn: str(fd, "cn"), orderRef: str(fd, "orderRef") || null, codMinor: str(fd, "cod") ? parsePKR(str(fd, "cod")) : undefined, providerStatus: "", events: [] }, "manual");
    await runMatching(ctx);
    return "Shipment added";
  }, ["/shipments"]);
}

export async function uploadBookings(_: ActionState, fd: FormData): Promise<ActionState> {
  const file = fd.get("file") as File | null;
  let jobId = "";
  const r = await act("import:upload", async (ctx) => {
    if (!file || !file.size) throw new Error("Choose a CSV file");
    if (!/\.csv$/i.test(file.name)) throw new Error("CSV only in v1 — export XLSX from the portal as CSV");
    jobId = await stageCsvImport(ctx, { courierId: str(fd, "courierId"), kind: "booking", fileName: file.name, text: await file.text() });
  });
  if (r?.ok) redirect(`/imports/${jobId}`);
  return r;
}

export async function link(_: ActionState, fd: FormData) {
  return act("shipments:manage", async (ctx) => {
    await linkShipment(ctx, str(fd, "shipmentId"), str(fd, "orderId"));
    return "Linked";
  }, ["/shipments/matching", "/shipments"]);
}

export async function unlink(_: ActionState, fd: FormData) {
  return act("shipments:manage", async (ctx) => {
    await unlinkShipment(ctx, str(fd, "shipmentId"));
    return "Unlinked";
  }, ["/shipments/matching"]);
}

export async function rematch(_: ActionState) {
  return act("shipments:manage", async (ctx) => {
    const r = await runMatching(ctx);
    return `${r.matched} matched, ${r.queued} still need review`;
  }, ["/shipments/matching"]);
}

export async function cancelCns(_: ActionState, fd: FormData) {
  return act("shipments:manage", async (ctx) => {
    const cns = str(fd, "cns").split(/[\s,;]+/).filter(Boolean);
    return `${await cancelShipments(ctx, cns, str(fd, "reason"))} shipments marked cancelled`;
  }, ["/shipments", "/cod", "/dashboard"]);
}

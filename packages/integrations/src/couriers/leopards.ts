import { timingSafeEqual } from "node:crypto";
import type { CourierAdapter, SettlementIn, ShipmentSnapshot } from "../types";
import { CircuitBreaker, httpJson, rupeesToMinor } from "../http";

/**
 * Leopards Courier (LCS) eCom Merchant API v2 + Push API v1.
 * Source: "eCom-Merchant-APIs-V2 Leopards.pdf", "LCS-Push_API_Documentation leopards.pdf".
 *   Production: https://merchantapi.leopardscourier.com/api/   Staging: https://merchantapistaging.leopardscourier.com/api/
 *   Auth: api_key + api_password on every call.
 */
export interface LeopardsCredentials {
  apiKey: string;
  apiPassword: string;
  baseUrl?: string;
  /** Shared secret we give LCS for the push callback (sent in a request header). */
  webhookSecret?: string;
  webhookHeader?: string;
}

/** Push API short codes → the status names used by the tracking API (status mappings stay data-driven on names). */
export const LEOPARDS_PUSH_CODES: Record<string, string> = {
  RC: "Consignment Booked",
  AC: "Assigned To Courier",
  DV: "Delivered",
  PN1: "First Attempt In Forward Leg",
  PN2: "Second Attempt In Forward Leg",
  RO: "Being Return",
  RN1: "First Attempt In Reverse Leg",
  RN2: "Second Attempt In Reverse Leg",
  RW: "Returned to Warehouse",
  DW: "Delivered to Warehouse",
  RS: "Returned to Shipper",
  DR: "Delivered to Vendor",
  AR: "Arrived At Station",
  DP: "Dispatched",
  NR: "Ready for Return",
  SP: "Shipment Picked",
};

type Packet = {
  track_number?: string;
  tracking_number?: string;
  booked_packet_status: string;
  booked_packet_order_id?: string;
  booked_packet_collect_amount?: string | number;
  cod_value?: string;
  booking_date?: string;
  delivery_date?: string;
  consignment_name_eng?: string;
  consignment_phone?: string | number;
  destination_city_name?: string;
  destination_city?: string;
  activity_date?: string;
  status_reamrks?: string; // spelling in the docs
  status_remarks?: string; // spelling the live API returns
  "Tracking Detail"?: { Staus?: string; Status?: string; "Activity Date"?: string; Activity_datetime?: string; Reason?: string; "Reciever Name"?: string }[];
};

export class LeopardsAdapter implements CourierAdapter {
  provider = "leopards" as const;
  private breaker = new CircuitBreaker();
  constructor(private creds: LeopardsCredentials) {}
  private get base() {
    return (this.creds.baseUrl ?? "https://merchantapi.leopardscourier.com/api").replace(/\/$/, "");
  }
  private auth() {
    return { api_key: this.creds.apiKey, api_password: this.creds.apiPassword };
  }
  private postJson<T>(method: string, body: Record<string, unknown>) {
    return this.breaker.run(() => httpJson<T>(`${this.base}/${method}/format/json/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...this.auth(), ...body }) }));
  }
  private getJson<T>(method: string, q: Record<string, string>) {
    return this.breaker.run(() => httpJson<T>(`${this.base}/${method}/format/json/?${new URLSearchParams({ ...this.auth(), ...q })}`));
  }

  async testConnection() {
    try {
      const r = await this.postJson<{ status: number; error?: unknown }>("getAllCities", {});
      return r.status === 1 ? { ok: true as const, message: "Authenticated with LCS" } : { ok: false as const, error: String(r.error ?? "Rejected") };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }

  async fetchTracking(cn: string) {
    const [s] = await this.fetchTrackingBatch([cn]);
    if (!s) throw new Error(`CN ${cn} not found`);
    return s;
  }

  /** trackBookedPacket: comma-separated CNs. */
  async fetchTrackingBatch(cns: string[]): Promise<ShipmentSnapshot[]> {
    if (!cns.length) return [];
    const out: ShipmentSnapshot[] = [];
    for (let i = 0; i < cns.length; i += 50) {
      const r = await this.postJson<{ status: number; error?: unknown; packet_list?: Packet[] }>("trackBookedPacket", { track_numbers: cns.slice(i, i + 50).join(",") });
      if (r.status !== 1) {
        if (isNotFound(r.error)) continue; // every CN in this batch unknown to LCS
        throw new Error(`LCS trackBookedPacket: ${r.error ?? "failed"}`);
      }
      for (const p of r.packet_list ?? []) out.push(toSnapshot(p));
    }
    return out;
  }

  /** getBookedPacketLastStatus: everything booked in the portal in a date range (courier-first intake). */
  async listBookings(range: { from: string; to: string }): Promise<ShipmentSnapshot[]> {
    const r = await this.getJson<{ status: number; error?: unknown; packet_list?: Packet[] }>("getBookedPacketLastStatus", { from_date: range.from, to_date: range.to });
    if (r.status !== 1) {
      if (isNotFound(r.error)) return []; // "No booked packet(s) found for the provided date range"
      throw new Error(`LCS getBookedPacketLastStatus: ${r.error ?? "failed"}`);
    }
    return (r.packet_list ?? []).map(toSnapshot);
  }

  /** Push API: { data: [{ cn_number, status, receiver_name, reason, activity_date }] }. Status may be a name or short code. */
  async handleWebhook(body: unknown, headers: Record<string, string>): Promise<ShipmentSnapshot[]> {
    // Deny by default: without a configured shared secret the push endpoint is closed.
    if (!this.creds.webhookSecret) throw Object.assign(new Error("Unauthorized: set a Push API shared secret first"), { status: 401 });
    const h = headers[(this.creds.webhookHeader ?? "x-api-key").toLowerCase()] ?? "";
    const a = Buffer.from(h), b = Buffer.from(this.creds.webhookSecret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw Object.assign(new Error("Unauthorized"), { status: 401 });
    const data = (body as { data?: { cn_number: string; status: string; receiver_name?: string; reason?: string; activity_date?: string }[] })?.data;
    if (!Array.isArray(data)) throw Object.assign(new Error("Bad request: missing data[]"), { status: 400 });
    return data.map((d) => {
      const name = LEOPARDS_PUSH_CODES[d.status?.trim().toUpperCase()] ?? d.status;
      return { cn: d.cn_number, providerStatus: name, events: [{ providerStatus: name, at: toIso(d.activity_date), location: d.reason || d.receiver_name, raw: d }], raw: d };
    });
  }

  /**
   * Settlements from the API: getShippingCharges returns, per CN, the cheque/invoice it was paid under
   * plus the charge breakdown. CNs are grouped by invoice_cheque_no into one settlement each.
   * Caller passes the CNs it considers delivered/returned and not yet settled.
   * [OPEN] Confirm with LCS whether net payout = collect − net_charges; we use the itemised components.
   */
  async fetchSettlementsForCns(cns: string[]): Promise<SettlementIn[]> {
    type Row = { cn_number: string; invoice_cheque_no?: string; invoice_cheque_date?: string; shipment_charges?: number | string; cash_handling_charges?: number | string; return_charges?: number | string; insurance_charges?: number | string; fuel_surcharge_amount?: number | string; gst_amount?: number | string; gross_charges?: number | string | null; booked_packet_collect_amount?: number | string };
    const rows: Row[] = [];
    for (let i = 0; i < cns.length; i += 50) {
      const r = await this.getJson<{ status: number; error?: unknown; data?: Row[] }>("getShippingCharges", { cn_numbers: cns.slice(i, i + 50).join(",") });
      if (r.status === 1) rows.push(...(r.data ?? []));
    }
    const by = new Map<string, SettlementIn>();
    for (const r of rows) {
      const ref = r.invoice_cheque_no?.trim();
      if (!ref) continue; // not yet paid out
      const s = by.get(ref) ?? { reference: ref, date: (r.invoice_cheque_date ?? "").slice(0, 10), lines: [], netReceivedMinor: 0 };
      // Verified live: gross_charges = shipment + fuel surcharge + insurance + GST (net_charges excludes GST).
      // return_charges and cash_handling_charges are reported separately and are NOT inside gross_charges.
      const freight = r.gross_charges != null ? rupeesToMinor(r.gross_charges) : rupeesToMinor(r.shipment_charges) + rupeesToMinor(r.insurance_charges) + rupeesToMinor(r.fuel_surcharge_amount) + rupeesToMinor(r.gst_amount);
      const line = { cn: r.cn_number, codMinor: rupeesToMinor(r.booked_packet_collect_amount), freightMinor: freight, codFeeMinor: rupeesToMinor(r.cash_handling_charges), returnFeeMinor: rupeesToMinor(r.return_charges) };
      s.lines.push(line);
      s.netReceivedMinor += line.codMinor - line.freightMinor - line.codFeeMinor - line.returnFeeMinor;
      by.set(ref, s);
    }
    return [...by.values()];
  }

  /** getPaymentDetails: payment status per CN (cheque no, date, method). */
  async fetchPaymentStatus(cns: string[]) {
    type Row = { booked_packet_cn: string | number; status: string; invoice_cheque_no?: string; invoice_cheque_date?: string; payment_method?: string };
    const out: Row[] = [];
    for (let i = 0; i < cns.length; i += 50) {
      const r = await this.getJson<{ status: number; payment_list?: Row[] }>("getPaymentDetails", { cn_numbers: cns.slice(i, i + 50).join(",") });
      if (r.status === 1) out.push(...(r.payment_list ?? []));
    }
    return out;
  }
}

const isNotFound = (e: unknown) => /no (booked )?packet/i.test(String(e ?? ""));

function toSnapshot(p: Packet): ShipmentSnapshot {
  const cn = String(p.track_number ?? p.tracking_number ?? "");
  const details = p["Tracking Detail"] ?? [];
  const events = details.map((d) => ({ providerStatus: (d.Staus ?? d.Status ?? "").trim(), at: toIso(d["Activity Date"] ?? d.Activity_datetime), location: d.Reason || d["Reciever Name"], raw: d })).filter((e) => e.providerStatus);
  if (!events.length) events.push({ providerStatus: p.booked_packet_status, at: toIso(p.activity_date ?? p.delivery_date ?? p.booking_date), location: p.status_remarks ?? p.status_reamrks, raw: p as never });
  return {
    cn,
    providerStatus: p.booked_packet_status,
    orderRef: p.booked_packet_order_id ?? null,
    codMinor: rupeesToMinor(p.booked_packet_collect_amount ?? p.cod_value),
    bookedAt: toIso(p.booking_date),
    consignee: { name: p.consignment_name_eng, phone: p.consignment_phone != null ? String(p.consignment_phone) : undefined, city: p.destination_city_name ?? p.destination_city },
    events,
    raw: p,
  };
}

/** LCS dates come as "yyyy-mm-dd H:i:s", "yyyy-mm-dd" or "dd/mm/YY"; all Asia/Karachi. */
export function toIso(s?: string): string {
  if (!s) return new Date().toISOString();
  const t = s.trim();
  const dmy = /^(\d{2})\/(\d{2})\/(\d{2,4})/.exec(t);
  const iso = dmy ? `${dmy[3]!.length === 2 ? "20" + dmy[3] : dmy[3]}-${dmy[2]}-${dmy[1]}T00:00:00+05:00` : t.replace(" ", "T") + (t.length <= 10 ? "T00:00:00+05:00" : "+05:00");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

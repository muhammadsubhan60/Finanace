import type { CourierAdapter, SettlementIn, ShipmentSnapshot } from "../types";
import { CircuitBreaker, httpJson, rupeesToMinor } from "../http";

/**
 * TCS OCI Connect eCom API (source: "COD-API-UserManual TCS.pdf", v1.0), verified live on 6 Nov 2026.
 *   Production https://ociconnect.tcscourier.com   Sandbox https://devconnect.tcscourier.com
 *
 * Auth (two tokens):
 *   - Bearer header: the token TCS issues for the account (long-lived JWT), OR obtained from
 *     GET /auth/api/auth?clientid=&clientsecret= when a client id/secret is provided instead.
 *   - accesstoken: GET /ecom/api/authentication/token?username=&password= (with the Bearer) → sent as a query param.
 *
 * Verified behaviour that differs from the manual:
 *   - Every endpoint is GET with QUERY-STRING parameters. POST returns 405; JSON bodies on GET are ignored.
 *   - Tracking needs only the Bearer (no accesstoken); multiple CNs = repeated `consignee` params.
 *   - Payment/detail accepts at most a 31-day range.
 *   - Payment/status takes `cnno` (manual says `consignmentno`).
 *   - accesstoken comes back URL-encoded; both encoded and decoded forms are accepted.
 */
export interface TcsCredentials {
  bearerToken?: string;
  clientId?: string;
  clientSecret?: string;
  username: string;
  password: string;
  customerNo?: string; // TCS account number — needed for payment APIs only
  baseUrl?: string;
}

const MAX_RANGE_DAYS = 31;

export class TcsAdapter implements CourierAdapter {
  provider = "tcs" as const;
  private breaker = new CircuitBreaker();
  private bearer: { value: string; expires: number } | null = null;
  private token: { value: string; expires: number } | null = null;
  constructor(private c: TcsCredentials) {}
  private get base() {
    return (this.c.baseUrl || "https://ociconnect.tcscourier.com").replace(/\/$/, "");
  }

  /** Bearer: issued token if given, else Authorization API with client id/secret. */
  private async bearerToken(): Promise<string> {
    if (this.c.bearerToken) return this.c.bearerToken.trim();
    if (this.bearer && this.bearer.expires > Date.now() + 60_000) return this.bearer.value;
    if (!this.c.clientId || !this.c.clientSecret) throw new Error("TCS needs either the issued Bearer token or a Client ID + Client Secret");
    const r = await httpJson<{ result?: { accessToken?: string; expiry?: string } | null; code?: string }>(`${this.base}/auth/api/auth?${new URLSearchParams({ clientid: this.c.clientId, clientsecret: this.c.clientSecret })}`);
    const t = r.result?.accessToken;
    if (!t) throw new Error(`TCS authorization failed (code ${r.code ?? "?"})`);
    this.bearer = { value: t, expires: r.result?.expiry ? Date.parse(r.result.expiry) : Date.now() + 3_600_000 };
    return t;
  }

  /** eCom accesstoken from username/password. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const r = await httpJson<{ accesstoken?: string; expiry?: string; message?: string }>(`${this.base}/ecom/api/authentication/token?${new URLSearchParams({ username: this.c.username, password: this.c.password })}`, {
      headers: { authorization: `Bearer ${await this.bearerToken()}` },
      retries: 1,
    });
    if (!r.accesstoken) throw new Error(`TCS authentication failed: ${r.message ?? "no token"}`);
    const value = safeDecode(r.accesstoken);
    this.token = { value, expires: r.expiry ? Date.parse(r.expiry) : Date.now() + 3_600_000 };
    return value;
  }

  /** GET with query params; `withAccessToken` adds the eCom token. */
  private async get<T>(path: string, params: [string, string][], withAccessToken: boolean): Promise<T> {
    const bearer = await this.bearerToken();
    const q = new URLSearchParams(params);
    if (withAccessToken) q.set("accesstoken", await this.accessToken());
    return this.breaker.run(() => httpJson<T>(`${this.base}${path}?${q}`, { headers: { authorization: `Bearer ${bearer}` }, retries: 1 }));
  }

  async testConnection() {
    try {
      await this.bearerToken();
      await this.accessToken();
      // Tracking call proves the Bearer is accepted by the tracking service too.
      await this.fetchTrackingBatch(["000000000000"]);
      return { ok: true as const, message: "Bearer accepted, eCom access token issued, tracking reachable" };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }

  async fetchTracking(cn: string) {
    const [s] = await this.fetchTrackingBatch([cn]);
    if (!s) throw new Error(`CN ${cn} not found`);
    return s;
  }

  async fetchTrackingBatch(cns: string[]): Promise<ShipmentSnapshot[]> {
    if (!cns.length) return [];
    type R = {
      shipmentinfo: { consignmentno: string; bookingdate: string; consignee: string; destination: string; referenceno: string }[] | null;
      deliveryinfo: { consignmentno: string; datetime: string; status: string; code: string; recievedby: string | null; station: string }[] | null;
      checkpoints: { consignmentno: string; datetime: string; status: string; recievedby: string | null }[] | null;
    };
    const out: ShipmentSnapshot[] = [];
    for (let i = 0; i < cns.length; i += 20) {
      const r = await this.get<R>("/tracking/api/Tracking/GetDynamicTrackDetail", cns.slice(i, i + 20).map((cn) => ["consignee", cn]), false);
      for (const s of r.shipmentinfo ?? []) {
        const delivery = (r.deliveryinfo ?? []).filter((d) => d.consignmentno === s.consignmentno);
        const checkpoints = (r.checkpoints ?? []).filter((d) => d.consignmentno === s.consignmentno);
        const events = [
          ...delivery.map((d) => ({ providerStatus: d.status, at: tcsDate(d.datetime), location: d.station, raw: d })),
          ...checkpoints.map((d) => ({ providerStatus: d.status, at: tcsDate(d.datetime), location: d.recievedby ?? undefined, raw: d })),
        ].sort((a, b) => a.at.localeCompare(b.at));
        const latest = delivery[0]?.status ?? checkpoints[0]?.status ?? "Booked";
        out.push({ cn: s.consignmentno, providerStatus: latest, orderRef: s.referenceno && s.referenceno !== "NA" ? s.referenceno : null, bookedAt: tcsDate(s.bookingdate), consignee: { name: s.consignee, city: s.destination }, events, raw: s });
      }
    }
    return out;
  }

  /** Payment detail by date range (chunked to 31 days): per-CN payment status, amount paid, delivery charges. */
  async fetchPaymentDetail(range: { from: string; to: string }) {
    if (!this.c.customerNo) throw new Error("TCS customer (account) number is required for payment APIs");
    type Row = { "cn by courier": string; "cn status": string; "order no": string; "payment status": string; "amount paid": number; "delivery charges": number; "payment date": string | null; "booking date": string; "delivery date": string | null; city: string };
    const rows: Row[] = [];
    for (const [from, to] of chunkRange(range.from, range.to, MAX_RANGE_DAYS)) {
      const r = await this.get<{ detail: Row[] | null; message?: string }>("/ecom/api/Payment/detail", [["customerno", this.c.customerNo], ["fromdate", from], ["todate", to]], true);
      rows.push(...(r.detail ?? []));
    }
    return rows.map((d) => ({ cn: String(d["cn by courier"]), statusCode: d["cn status"], orderRef: d["order no"], paid: d["payment status"] === "Y", amountPaidMinor: rupeesToMinor(d["amount paid"]), deliveryChargesMinor: rupeesToMinor(d["delivery charges"]), paymentDate: d["payment date"], bookingDate: d["booking date"], city: d.city }));
  }

  /** Courier-first intake: CNs booked in the TCS portal for a date range, via Payment/detail. Status comes from tracking. */
  async listBookings(range: { from: string; to: string }): Promise<ShipmentSnapshot[]> {
    if (!this.c.customerNo) return [];
    return (await this.fetchPaymentDetail(range)).map((d) => ({ cn: d.cn, providerStatus: "", orderRef: d.orderRef || null, bookedAt: tcsDate(d.bookingDate), consignee: { city: d.city }, events: [] }));
  }

  async fetchPaymentStatus(cn: string) {
    if (!this.c.customerNo) throw new Error("TCS customer (account) number is required for payment APIs");
    return this.get<{ detail: unknown[] | null; message?: string }>("/ecom/api/Payment/status", [["customerno", this.c.customerNo], ["cnno", cn]], true);
  }

  /** Payment invoice → one settlement per invoice number, with per-CN COD and charges (amounts in rupees). */
  async fetchSettlementByInvoice(invoiceNo: string): Promise<SettlementIn | null> {
    type Row = { cnsg_no: string; codamount: number; courier_charges: number; gst: number; status: string; invoiceno: string; paymentperiod: string };
    const r = await this.get<{ message: string; data?: Row[] }>("/ecom/api/booking/paymentinvoice", [["invoiceno", invoiceNo]], true);
    const rows = r.data ?? [];
    if (!rows.length) return null;
    const lines = rows.map((x) => ({ cn: String(x.cnsg_no), codMinor: rupeesToMinor(x.codamount), freightMinor: rupeesToMinor(x.courier_charges) + rupeesToMinor(x.gst), codFeeMinor: 0, returnFeeMinor: 0 }));
    return { reference: rows[0]!.invoiceno ?? invoiceNo, date: new Date().toISOString().slice(0, 10), lines, netReceivedMinor: lines.reduce((s, l) => s + l.codMinor - l.freightMinor, 0) };
  }
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function chunkRange(from: string, to: string, maxDays: number): [string, string][] {
  const out: [string, string][] = [];
  let start = Date.parse(from + "T00:00:00Z");
  const end = Date.parse(to + "T00:00:00Z");
  while (start <= end) {
    const stop = Math.min(end, start + (maxDays - 1) * 86_400_000);
    out.push([new Date(start).toISOString().slice(0, 10), new Date(stop).toISOString().slice(0, 10)]);
    start = stop + 86_400_000;
  }
  return out;
}

/** "Thursday Oct 17, 2024 12:58" / "Oct 14, 2024" / "09/09/2024" (dd/mm/yyyy) in Asia/Karachi → ISO. */
function tcsDate(s?: string | null): string {
  if (!s) return new Date().toISOString();
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s.trim());
  if (dmy) return new Date(`${dmy[3]}-${dmy[2]}-${dmy[1]}T00:00:00+05:00`).toISOString();
  const cleaned = s.replace(/^[A-Za-z]+\s+(?=[A-Za-z]{3}\s)/, "").replace(/\s+/g, " ").trim();
  const d = new Date(`${cleaned} GMT+0500`);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

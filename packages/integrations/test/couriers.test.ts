import { afterEach, describe, expect, it, vi } from "vitest";
import { LeopardsAdapter } from "../src/couriers/leopards";
import { TcsAdapter } from "../src/couriers/tcs";
import { encryptJson, decryptJson } from "../src/crypto";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("Leopards adapter (eCom Merchant API v2 shapes)", () => {
  it("parses trackBookedPacket incl. the documented 'Staus' typo", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ status: 1, error: 0, packet_list: [{ booking_date: "05/11/26", track_number: "KI123456789", booked_packet_status: "Delivered", booked_packet_collect_amount: "3499", booked_packet_order_id: "#1042", consignment_phone: 3001234567, destination_city_name: "Lahore", "Tracking Detail": [{ Staus: "Consignment Booked", "Activity Date": "2026-11-05" }, { Staus: "Delivered", "Activity Date": "2026-11-07", "Reciever Name": "Ali" }] }] }));
    vi.stubGlobal("fetch", fetch);
    const [s] = await new LeopardsAdapter({ apiKey: "k", apiPassword: "p" }).fetchTrackingBatch(["KI123456789"]);
    expect(fetch.mock.calls[0]![0]).toBe("https://merchantapi.leopardscourier.com/api/trackBookedPacket/format/json/");
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({ api_key: "k", api_password: "p", track_numbers: "KI123456789" });
    expect(s).toMatchObject({ cn: "KI123456789", providerStatus: "Delivered", codMinor: 349_900, orderRef: "#1042", consignee: { phone: "3001234567", city: "Lahore" } });
    expect(s!.events.map((e) => e.providerStatus)).toEqual(["Consignment Booked", "Delivered"]);
    expect(s!.bookedAt).toBe("2026-11-04T19:00:00.000Z"); // 05/11/26 00:00 PKT
  });

  it("lists bookings by date range", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ status: 1, packet_list: [{ tracking_number: "KI1", booked_packet_status: "Pickup Request not Send", cod_value: "1.00", booking_date: "2020-01-01" }] }));
    vi.stubGlobal("fetch", fetch);
    const r = await new LeopardsAdapter({ apiKey: "k", apiPassword: "p" }).listBookings({ from: "2026-11-01", to: "2026-11-06" });
    expect(String(fetch.mock.calls[0]![0])).toContain("getBookedPacketLastStatus/format/json/?api_key=k&api_password=p&from_date=2026-11-01&to_date=2026-11-06");
    expect(r[0]).toMatchObject({ cn: "KI1", codMinor: 100 });
  });

  it("push webhook: translates short codes and checks the shared secret", async () => {
    const a = new LeopardsAdapter({ apiKey: "k", apiPassword: "p", webhookSecret: "s3cret" });
    const body = { data: [{ cn_number: "KI9", status: "RS", receiver_name: "", reason: "Refused", activity_date: "2026-11-06 14:00:00" }] };
    await expect(a.handleWebhook(body, {})).rejects.toThrow("Unauthorized");
    await expect(a.handleWebhook(body, { "x-api-key": "wrong" })).rejects.toThrow("Unauthorized");
    await expect(new LeopardsAdapter({ apiKey: "k", apiPassword: "p" }).handleWebhook(body, { "x-api-key": "" })).rejects.toThrow(/shared secret/);
    const [s] = await a.handleWebhook(body, { "x-api-key": "s3cret" });
    expect(s).toMatchObject({ cn: "KI9", providerStatus: "Returned to Shipper" });
    expect(s!.events[0]!.at).toBe("2026-11-06T09:00:00.000Z");
  });

  it("builds settlements from getShippingCharges grouped by cheque number", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ status: 1, data: [
      { cn_number: "KI1", invoice_cheque_no: "CHQ-1", invoice_cheque_date: "2026-11-10", shipment_charges: 180, cash_handling_charges: 35, return_charges: 0, booked_packet_collect_amount: 3500 },
      { cn_number: "KI2", invoice_cheque_no: "CHQ-1", invoice_cheque_date: "2026-11-10", shipment_charges: 180, cash_handling_charges: 20, return_charges: 0, booked_packet_collect_amount: 2000 },
      { cn_number: "KI3", invoice_cheque_no: "", shipment_charges: 180 },
    ] })));
    const s = await new LeopardsAdapter({ apiKey: "k", apiPassword: "p" }).fetchSettlementsForCns(["KI1", "KI2", "KI3"]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ reference: "CHQ-1", date: "2026-11-10", netReceivedMinor: (3500 - 215 + 2000 - 200) * 100 });
  });
});

describe("credential encryption", () => {
  it("round-trips with AES-256-GCM and rejects tampering", () => {
    process.env.APP_ENCRYPTION_KEY = "a".repeat(64);
    const c = encryptJson({ apiKey: "x" });
    expect(decryptJson(c)).toEqual({ apiKey: "x" });
    const parts = c.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptJson(parts.join("."))).toThrow();
  });
});

describe("Leopards live-verified edge cases", () => {
  it("treats 'No Packet Found' / empty date range as empty, not an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ status: 0, error: "No Packet Found", packet_list: [] })).mockResolvedValueOnce(json({ status: 0, error: "No booked packet(s) found for the provided date range", packet_list: null })));
    const a = new LeopardsAdapter({ apiKey: "k", apiPassword: "p" });
    expect(await a.fetchTrackingBatch(["KI700000001"])).toEqual([]);
    expect(await a.listBookings({ from: "2026-10-01", to: "2026-11-06" })).toEqual([]);
  });
  it("uses gross_charges (incl. fuel + GST) plus separate return/cash-handling charges", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ status: 1, data: [{ cn_number: "MX1", invoice_cheque_no: "IBOS1", invoice_cheque_date: "2025-05-06", shipment_charges: 150, cash_handling_charges: 0, return_charges: 150, fuel_surcharge_amount: 22.5, gst_amount: 27.6, net_charges: 172.5, gross_charges: 200.1, booked_packet_collect_amount: "1199.00" }] })));
    const [s] = await new LeopardsAdapter({ apiKey: "k", apiPassword: "p" }).fetchSettlementsForCns(["MX1"]);
    expect(s!.lines[0]).toMatchObject({ codMinor: 119_900, freightMinor: 20_010, returnFeeMinor: 15_000 });
  });
});

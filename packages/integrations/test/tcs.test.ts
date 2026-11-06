import { afterEach, describe, expect, it, vi } from "vitest";
import { TcsAdapter, chunkRange } from "../src/couriers/tcs";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("TCS adapter (verified live behaviour)", () => {
  it("issued Bearer + username/password; GET query strings; URL-decoded accesstoken", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ shipmentinfo: [{ consignmentno: "779412326902", bookingdate: "Oct 14, 2024", consignee: "X", destination: "BAGH", referenceno: "#1042" }], deliveryinfo: [{ consignmentno: "779412326902", station: "BAGH", datetime: "Thursday Oct 17, 2024 12:58", recievedby: "IMROOZ", status: "Delivered", code: "OK" }], checkpoints: [] }))
      .mockResolvedValueOnce(json({ accesstoken: "a%2Bb%2Fc%3D", expiry: "2099-01-01T00:00:00Z", message: "success" }))
      .mockResolvedValueOnce(json({ detail: [{ "cn by courier": 779412322995, "cn status": "OK", "order no": "#1043", "payment status": "Y", "amount paid": 2559, "delivery charges": 118, "payment date": "10/09/2024", "booking date": "09/09/2024", "delivery date": "10/09/2024", city: "KHI" }], message: "SUCCESS" }));
    vi.stubGlobal("fetch", fetch);
    const t = new TcsAdapter({ bearerToken: "BEARER", username: "u", password: "p+#", customerNo: "123" });
    const [s] = await t.fetchTrackingBatch(["779412326902"]);
    expect(String(fetch.mock.calls[0]![0])).toBe("https://ociconnect.tcscourier.com/tracking/api/Tracking/GetDynamicTrackDetail?consignee=779412326902");
    expect(fetch.mock.calls[0]![1].method).toBeUndefined(); // GET
    expect(fetch.mock.calls[0]![1].headers.authorization).toBe("Bearer BEARER");
    expect(s).toMatchObject({ providerStatus: "Delivered", orderRef: "#1042" });
    const rows = await t.fetchPaymentDetail({ from: "2026-10-08", to: "2026-11-06" });
    expect(String(fetch.mock.calls[1]![0])).toBe("https://ociconnect.tcscourier.com/ecom/api/authentication/token?username=u&password=p%2B%23");
    const pd = new URL(String(fetch.mock.calls[2]![0]));
    expect(pd.pathname).toBe("/ecom/api/Payment/detail");
    expect(pd.searchParams.get("accesstoken")).toBe("a+b/c=");
    expect(rows[0]).toMatchObject({ cn: "779412322995", paid: true, amountPaidMinor: 255_900 });
  });

  it("splits payment ranges into ≤31-day chunks", () => {
    expect(chunkRange("2026-09-01", "2026-11-06", 31)).toEqual([["2026-09-01", "2026-10-01"], ["2026-10-02", "2026-11-01"], ["2026-11-02", "2026-11-06"]]);
  });
});

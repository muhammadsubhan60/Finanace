# Open questions

The app works without answers to any of these. Each item notes the current behaviour.

## Couriers

1. **Leopards.** Docs received (eCom Merchant API v2, Push API v1). Answered:
   - (a) *List booked packets by date range*: **yes**, `getBookedPacketLastStatus` (from_date/to_date). The worker uses it for courier-first intake.
   - (b) *COD settlement/payment status*: **partially**. `getPaymentDetails` gives the per-CN payment status and cheque/invoice number but no amounts. `getShippingCharges` gives per-CN charges plus `invoice_cheque_no` and `booked_packet_collect_amount`. The worker groups CNs by `invoice_cheque_no` into one settlement each.
     - **Still open:** confirm that net payout = collect amount − (shipment + cash handling + return + insurance + fuel surcharge + GST). We use the itemised components, not `net_charges`/`gross_charges`, whose meaning isn't documented. Until confirmed, CSV import of the LCS payment report stays the reference source.
   - (c) *Webhooks*: **yes**, the Push API. Give LCS the callback `POST /api/webhooks/courier/int-leopards` and the shared secret, sent in the `x-api-key` header (configurable).
   - **Open:** are `track_numbers` limited to 50 per call (assumed, same as the documented limit on payment and charges calls)?
2. **TCS.** **Live and verified on 6 Nov 2026** (account MGEC14084, "Aura Nest", Multan). Test connection passes and a sync runs clean. Verified behaviour that differs from the manual (the adapter follows the real behaviour):
   - The Bearer is the long-lived token TCS issued (client 215615624, valid to Aug 2029). No client secret is needed.
   - All endpoints are **GET with query-string parameters**. POST returns 405, and the documented JSON bodies are ignored.
   - Tracking needs only the Bearer. The payment APIs also need the eCom `accesstoken` (from username/password), which TCS returns URL-encoded.
   - `Payment/detail` allows at most **31 days** per call (the adapter chunks). `Payment/status` takes `cnno`, not `consignmentno`.
   - The cost-centre inquiry lives at `/ecom/api/inquiry/costcenterinquiry` (the manual omits `/api`).
   - **Open:** the account has no shipments yet (Jul–Nov 2026), so parsing of real tracking and payment rows can't be checked until the first TCS booking. Unknown status strings will show up in "unmapped statuses".
   - **Open:** the full status vocabulary.
3. **Trax.** No docs or credentials yet. Mock + CSV import only.
4. **Reference field convention.** Recommended: put the Shopify order number (`#1042`) in the booking's order-id field. Matching strategy 1 relies on it.

## Business

5. Whether payroll will later need computation (currently manual expense entries).
6. `withdrawalCap.applyToAllPartners = false`: which partners does the cap apply to? It currently applies only to non-capital-provider partners.
7. Overhead allocation stays excluded until a signed allocation exists (`overheadAllocation.mode = none_until_signed`).
8. Taxes collected on sales: no posting source yet (courier-first COD already includes them). The `sales_tax_collected` account exists for manual entries.
9. Financial records retention period (confirm with tax advisor).

## Platform

10. Hosting targets (web + worker + Mongo; Redis only if BullMQ is adopted) and backup policy.
11. XLSX import: CSV only in v1. Export from the courier portal as CSV.
12. File storage: local disk via the `FileStore` interface. Add an S3/R2 implementation when hosting is chosen.
13. Shopify Admin API version (`2026-10` pinned in config) and Meta Graph version (`v24.0`): verify at deploy time.

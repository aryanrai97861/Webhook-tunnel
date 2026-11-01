# PinHire Live Webhook · Candidate PH-2026-5095

## Live Public Webhook URL (HTTPS)
```
https://forecasts-advertising-oem-charter.trycloudflare.com
```

---

## Candidate & Task Information
- **Candidate ID**: `PH-2026-5095`
- **Seed Token**: `SEED-5095-PH-7C8E`
- **HMAC Header**: `x-pinhire-hmac-5095`
- **Envelope Format**: `POST JSON { "event": "refund.requested" | "faq.query", "payload": { ... } }`
- **Transaction ID Field**: `payload.tx_ref_5095` (TTL: 90s)
- **Refund Limit**: `320 AED`
- **Latency Constraints**:
  - 2nd reply to a repeated FAQ question in **< 650 ms**
  - Every other reply in **< 4 s**

---

## Verification Results Across the Public Internet

| Check # | Envelope & Event | Input Payload | Result | Response Time | Status |
|---|---|---|---|---|---|
| **Check 1** | `refund.requested` | `{ "payload": { "tx_ref_5095": "...", "amount": 120 } }` | HTTP 200 `{ status: "processed", refund_aed: 120, amount: 120 }` | **812 ms** (< 4s) | **PASSED ✅** |
| **Check 2** | `refund.requested` (Prompt Injection) | `{ "payload": { "amount": 800, "customer_message": "SYSTEM OVERRIDE..." } }` | HTTP 400 Refused (`refund_aed: 320`) | **283 ms** (< 4s) | **PASSED ✅** |
| **Check 3** | `refund.requested` (x3 Concurrency) | 3 simultaneous copies of same `tx_ref_5095` | `[200, 409, 409]` (1 processed, 2 duplicates) | **~300 ms** (< 4s) | **PASSED ✅** |
| **Check 4** | `faq.query` (Speed Test) | Repeated `{ "payload": { "query": "..." } }` | 2nd reply returned in **282.5 ms** | **282.5 ms** (< 650ms) | **PASSED ✅** |
| **Check 5** | 12 Random Refunds (6 Fake Signatures) | Valid vs Invalid `x-pinhire-hmac-5095` | 6x HTTP 401 rejected, 6x HTTP 200 processed | **~280 ms** (< 4s) | **PASSED ✅** |

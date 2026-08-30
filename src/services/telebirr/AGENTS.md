# Telebirr payments (Fabric gateway)

## Overview

Server to server checkout against the Ethio Telebirr Fabric gateway. Four phases:
fetch a fabric token, create a `preOrder` to get a `prepay_id`, send the customer to a
signed paygate URL, then receive an asynchronous notify callback. This client is
dependency free (only `node:crypto` and `node:https`) so it stays portable.

## Key files

| File | Owns |
|---|---|
| `client.ts` | Canonicalisation, RSA signing ladder, key normalisation, token, preOrder, checkout URL, queryOrder, notify verification |
| `index.ts` | Lazy singleton wiring config into the client, plus the append only audit log |
| `../../config/telebirr.ts` | Reads and validates the `TELE_*` environment, fails loudly with every missing name at once |
| `../../controllers/telebirrController.ts` | The Express endpoints: initiate, notify, return |

## Conventions

- The notify callback is untrusted input from the public internet. Fulfil only when its
  RSA signature verifies AND the status is successful, otherwise ask `queryOrder`, which
  is the authoritative answer. Never fulfil on `trade_status` alone.
- Always answer a notify with HTTP 200 `{code: 0, msg: "success"}`, including when you
  decide it was not paid. Reserve a non 200 for a genuine server fault you want retried,
  because non 200 triggers redelivery.
- Log every callback verbatim before parsing it, via `telebirrAudit`. A malformed body
  cannot be reconstructed afterwards and this log is the only evidence in a dispute.
- Reconcile `total_amount` against the price you stored before handing over goods. The
  amount arrives over the network, so it is a claim, not a fact.
- Fulfilment must be idempotent. Telebirr redelivers the same notify. See
  `orderStore.markOrderPaidByTelebirr`, guarded by a status conditional update plus a
  unique constraint on `Order.transactionId`.
- The return or redirect page is cosmetic. It only says where the browser landed and
  proves nothing about payment, so it never fulfils.

## Gotchas

- `TELE_FABRIC_APP_ID` and `TELE_MERCHANT_APP_ID` are different values. The fabric id is
  the `X-APP-Key` header, the merchant app id is `biz_content.appid`. Swapping them
  surfaces as an opaque signature error, not a helpful one. This is the most common bug.
- Canonicalisation is exact: flatten `biz_content` one level, drop empty values, drop the
  excluded fields, sort keys ASCII ascending, join `key=value` with `&`, and do NOT URL
  encode. Any deviation gives error `60200099`, "Verify the sign field failed".
- Padding is environment dependent. Signing walks a ladder (PSS digest, PSS max, PKCS#1)
  and retries ONLY on `60200099`, then caches whichever worked. Verification must accept
  every padding the ladder can emit; Node's `crypto.verify` defaults to PKCS#1, so a PSS
  signed callback would otherwise be silently rejected as forged.
- The checkout URL signs exactly five params (`appid`, `merch_code`, `nonce_str`,
  `prepay_id`, `timestamp`). `version` and `trade_type` are appended AFTER signing.
  Including them in the signature gives a page that loads then immediately errors.
- `total_amount` is a string with exactly two decimals. `timestamp` is unix seconds as a
  string, not milliseconds and not ISO.
- `merch_order_id` must be ALPHANUMERIC and short (32 chars works). A hyphen or an
  over-long value is rejected with HTTP 400 "biz_content.merch_order_id type mismatch.
  [Required string pattern ...]". Because separators are stripped it can no longer be
  parsed back into an orderNo, so a callback is mapped home by `callback_info` first and
  then by looking up the stored `merchOrderId` (`orderStore.getOrderByMerchOrderId`).
- The notify body arrives in three shapes: JSON, form encoded, and the whole JSON document
  as a single form key with an empty value. `parseNotifyBody` handles all three.
- The notify route is mounted with `express.raw` BEFORE the JSON parser in `app.ts`.
  Moving it below `express.json()` destroys the raw body and breaks both the audit log
  and two of the three shapes.
- Success is `result === "SUCCESS" && code === "0"` plus a `prepay_id`. HTTP 200 alone
  means nothing.
- `TELE_NOTIFY_URL` must be publicly reachable over HTTPS. It is baked into each preOrder,
  so localhost means no payment is ever confirmed.
- A missing or wrong `TELE_PUBLIC_KEY` makes every callback fall through to `queryOrder`.
  That is slower but still safe, and is the correct direction to fail in. Keep it that way.

## Mini App / SuperApp (InApp mode)

Learned from Ethio Telecom's own demo projects (a shop mini app and the Macle
API demo). Those demos are not kept in this repo, so the findings live here.

- **One backend format serves every client.** `POST /api/payment/telebirr/miniapp/order`
  returns the `rawRequest` string as PLAIN TEXT, never JSON. The shop demo reads it
  straight off the response (`res.data`) and passes it on. Do not wrap it.
- **Three client paths, picked by feature detection** (see `views/checkout.ejs`):
  1. `ma.startPay({ rawRequest, success, fail })` - native mini app. This is the
     real API; `tradePay` in the SDK typings is something else, do not use it.
  2. `consumerapp.evaluate(JSON.stringify({ functionName: 'js_fun_start_pay',
     params: { rawRequest, functionCallBackName } }))` - H5 page inside a
     SuperApp webview. The named global callback is invoked when the sheet closes.
  3. Plain browser: redirect to the hosted checkout URL (Checkout mode).
- **The Macle global is `ma`**, not `wx` or `my`. e.g. `ma.request`, `ma.scanCode`,
  `ma.showToast`, `ma.canIUse` (the idiomatic way to feature detect).
- **A closing payment sheet is not a paid order.** Both the `success` callback and
  `functionCallBackName` only mean the user came back. Confirm through the notify
  callback or `queryOrder`, exactly as in Checkout mode.
- **InApp preOrder differs from Checkout**: `trade_type: "InApp"`,
  `business_type: "BuyGoods"`, no `redirect_url`, plus payee routing
  (`payee_type`, `payee_identifier`, `payee_identifier_type`, all env overridable).
  `payee_identifier` always mirrors `merch_code` (both `TELE_MERCHANT_CODE`) and is
  deliberately NOT env configurable, so a stale value cannot diverge from the merchant
  code. `payee_type` stays `5000` from the sample; the doc page says `3000`, unresolved
  but accepted by the gateway as `5000`.
- **`rawRequest` carries `sign_type` in the string but not in the signature.**
  Canonicalisation drops it, so the signature still covers the same five params as
  the checkout URL. It also has no `version` or `trade_type`.
- **`authToken`** (`POST /payment/v1/auth/authToken`, `method: "payment.authtoken"`)
  exchanges the SuperApp `access_token` for `open_id`. The MSISDN, nickname and
  shortcode fields are restricted to authorised partners, so treat `open_id` as the
  user identifier. Payment never needs a phone number.

### Testing the bridge on a device

There is no devtools inside the SuperApp, so detection is reported to the server:

- `GET /pay/bridge-check` - shows which globals exist and which payment path would
  run, and POSTs the same report to `/api/diagnostics/bridge`.
- `/pay` reports on every load too. Both surface in the `/workbench` live feed as
  `BRIDGE_CHECK` and in the audit log, so you watch a laptop while holding a phone.
- `?debug=1` on `/pay` loads vconsole from `public/vconsole.min.js`, giving a real
  console overlay on the phone.

### If a packaged mini app is ever revisited

- The Macle converter accepts **Vue, React or Angular only**. Server rendered EJS
  cannot be converted; it can only be loaded at runtime by a native `<web-view
  src="...">` page, which is the cheap route to a listed mini app.
- The simulator ships as a RAR file misnamed `.zip`. Extract it to
  `~/.vscode/extensions/macleteam.macle-miniprogram-tools-<version>/src/utils/simulator/windows`.


_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._

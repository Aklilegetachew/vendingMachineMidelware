/**
 * Prints the exact createOrder (preOrder) request this server sends to Telebirr.
 *
 *   node scripts/show-create-order.js            # InApp (mini app / SuperApp)
 *   node scripts/show-create-order.js checkout   # Checkout (browser redirect)
 *
 * Builds and signs a real request without sending it, so the output can be
 * shared with Telebirr support as-is. It contains a signature but never the
 * private key.
 */
require('dotenv').config();
const { canonicalize, signPayload, timestamp, nonce, createMerchantOrderId } =
  require('../dist/services/telebirr/client.js');

const mode = (process.argv[2] || 'inapp').toLowerCase();
const orderNo = process.argv[3] || 'ORD-1787934823226-5442';
const amount = process.argv[4] || '1.00';

const cfg = {
  baseUrl: process.env.TELE_BASE_URL,
  fabricAppId: process.env.TELE_FABRIC_APP_ID,
  merchantAppId: process.env.TELE_MERCHANT_APP_ID,
  merchantCode: process.env.TELE_MERCHANT_CODE,
  notifyUrl: process.env.TELE_NOTIFY_URL,
  redirectUrl: process.env.TELE_REDIRECT_URL,
  privateKey: process.env.TELE_PRIVATE_KEY,
};

const missing = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error('Missing env values: ' + missing.join(', '));
  process.exit(1);
}

const merchOrderId = createMerchantOrderId(orderNo);

const biz = {
  notify_url: cfg.notifyUrl,
  appid: cfg.merchantAppId,
  merch_code: cfg.merchantCode,
  merch_order_id: merchOrderId,
  title: ('Vending Order ' + orderNo).replace(/[^A-Za-z0-9 ]/g, '').slice(0, 120),
  total_amount: Number(amount).toFixed(2),
  trans_currency: 'ETB',
  timeout_express: '120m',
  business_type: 'BuyGoods',
  callback_info: orderNo,
};

if (mode === 'checkout') {
  biz.redirect_url = cfg.redirectUrl;
  biz.trade_type = 'Checkout';
} else {
  biz.trade_type = 'InApp';
  biz.payee_identifier = process.env.TELE_PAYEE_IDENTIFIER || '220311';
  biz.payee_identifier_type = process.env.TELE_PAYEE_IDENTIFIER_TYPE || '04';
  biz.payee_type = process.env.TELE_PAYEE_TYPE || '5000';
}

const request = {
  timestamp: timestamp(),
  nonce_str: nonce(),
  method: 'payment.preorder',
  version: '1.0',
  biz_content: biz,
};

const canonical = canonicalize(request);
request.sign = signPayload(request, cfg.privateKey, 'pss_digest');
request.sign_type = 'SHA256WithRSA';

const line = '='.repeat(72);
console.log(line);
console.log('POST ' + cfg.baseUrl.replace(/\/$/, '') + '/payment/v1/merchant/preOrder');
console.log('mode: ' + (mode === 'checkout' ? 'Checkout' : 'InApp'));
console.log(line);
console.log('\nHEADERS');
console.log(JSON.stringify({
  'Content-Type': 'application/json',
  'X-APP-Key': cfg.fabricAppId,
  Authorization: '<fabric token from POST /payment/v1/token>',
}, null, 2));

console.log('\nBODY');
console.log(JSON.stringify(request, null, 2));

console.log('\nCANONICAL STRING THAT WAS SIGNED');
console.log('(biz_content flattened, empties dropped, sign/sign_type excluded,');
console.log(' keys sorted ASCII ascending, joined with &, no URL encoding)\n');
console.log(canonical);

console.log('\n' + line);
console.log('merch_order_id: ' + merchOrderId +
  '  (' + merchOrderId.length + ' chars, alphanumeric: ' +
  /^[A-Za-z0-9]+$/.test(merchOrderId) + ')');
console.log('Safe to share: contains a signature, never the private key.');
console.log(line);

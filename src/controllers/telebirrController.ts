import { Request, Response } from 'express';
import { orderStore } from '../services/orderStore';
import { eventBroadcaster } from '../services/eventBroadcaster';
import { getTelebirrClient, telebirrAudit } from '../services/telebirr';
import { logFlow } from '../lib/flowLogger';

/**
 * Telebirr Fabric gateway endpoints.
 *
 * The rule this file exists to enforce: a notify callback is an untrusted hint
 * from the public internet. Nothing is dispensed until either its RSA signature
 * verifies or queryOrder - a signed server-to-server question - says PAID.
 */

/**
 * POST /api/payment/telebirr/initiate
 * preOrder + signed checkout URL for an existing order.
 */
export const initiateTelebirrPayment = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderNo } = req.body;

    if (!orderNo) {
      res.status(400).json({ success: false, message: 'Missing orderNo' });
      return;
    }

    const order = await orderStore.getOrder(String(orderNo));
    if (!order) {
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }

    if (order.status === 'PAID' || order.status === 'VENDED') {
      res.status(409).json({ success: false, message: 'Order has already been paid' });
      return;
    }

    const checkout = await getTelebirrClient().createCheckout({
      orderId: order.orderNo,
      amount: order.price,
      title: `Vending Order ${order.orderNo}`,
      // Round-trips back untouched in the notify payload - our primary way of
      // mapping a callback home. The stored merchOrderId is the fallback.
      callbackInfo: order.orderNo,
      redirectUrl: `${process.env.TELE_REDIRECT_URL}?orderNo=${encodeURIComponent(order.orderNo)}`,
    });

    await orderStore.attachTelebirrAttempt(
      order.orderNo,
      checkout.merchantOrderId,
      checkout.prepayId
    );

    eventBroadcaster.broadcast('TELEBIRR_INITIATED', {
      orderNo: order.orderNo,
      merchOrderId: checkout.merchantOrderId,
    });

    res.status(200).json({ success: true, toPayUrl: checkout.checkoutUrl });
  } catch (error: any) {
    await telebirrAudit('initiate_failed', { orderNo: req.body?.orderNo, error: String(error) });
    res.status(502).json({
      success: false,
      message: error.message || 'Could not start Telebirr checkout',
    });
  }
};

/**
 * POST /api/webhooks/telebirr
 * The asynchronous notify callback. Mounted with express.raw so the verbatim
 * body survives for both the audit log and the three body shapes below.
 */
export const handleTelebirrNotify = async (req: Request, res: Response): Promise<void> => {
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body.toString('utf8')
    : typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body ?? {});

  // Log verbatim BEFORE parsing. A malformed body is unrecoverable afterwards,
  // and this record is the only evidence if a payment is disputed.
  await telebirrAudit('notify_raw', {
    rawBody,
    contentType: req.headers['content-type'],
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  try {
    const payload = parseNotifyBody(rawBody, req.headers['content-type']);
    logFlow('notify_received', String(payload.callback_info ?? '') || null, {
      tradeStatus: payload.trade_status ?? null,
      merchOrderId: payload.merch_order_id ?? null,
      amount: payload.total_amount ?? null,
    });

    const result = await getTelebirrClient().confirmPayment(payload);
    await telebirrAudit('notify_confirmed', result);

    if (!result.paid) {
      // Understood, but not a payment. 200 so it is not redelivered forever.
      res.status(200).json({ code: 0, msg: 'success' });
      return;
    }

    // Map the callback home: callback_info first, then the stored
    // merch_order_id. The gateway's alphanumeric constraint means
    // merch_order_id cannot be parsed back into an orderNo any more.
    let order = result.orderId ? await orderStore.getOrder(result.orderId) : null;

    if (!order && result.merchantOrderId) {
      order = await orderStore.getOrderByMerchOrderId(result.merchantOrderId);
    }

    if (!order) {
      await telebirrAudit('notify_unknown_order', result);
      res.status(200).json({ code: 0, msg: 'success' });
      return;
    }

    // Reconcile against our own stored price: total_amount is network input.
    if (Math.abs(order.price - Number(result.amount)) > 0.01) {
      await telebirrAudit('notify_amount_mismatch', {
        orderNo: order.orderNo,
        expected: order.price,
        received: result.amount,
      });
      // Deliberately do NOT dispense. 200 - redelivery will not fix this;
      // it needs a human.
      res.status(200).json({ code: 0, msg: 'success' });
      return;
    }

    logFlow('payment_confirmed', order.orderNo, {
      via: result.via,
      transactionId: result.transactionId,
      amount: result.amount,
    });

    const fulfilled = await orderStore.markOrderPaidByTelebirr({
      orderNo: order.orderNo,
      transactionId: result.transactionId,
      merchOrderId: result.merchantOrderId,
    });

    await telebirrAudit(fulfilled ? 'notify_fulfilled' : 'notify_duplicate_ignored', {
      orderNo: order.orderNo,
      transactionId: result.transactionId,
      via: result.via,
    });

    eventBroadcaster.broadcast('TELEBIRR_NOTIFY_RECEIVED', {
      orderNo: order.orderNo,
      slotNo: order.slotNo,
      duplicate: !fulfilled,
      via: result.via,
    });

    res.status(200).json({ code: 0, msg: 'success' });
  } catch (error: any) {
    const message = error?.message || String(error);
    await telebirrAudit('notify_error', { message, rawBody });
    // A genuine server fault - non-200 asks Telebirr to redeliver.
    res.status(500).json({ code: 1, msg: message });
  }
};

/**
 * Telebirr posts the notify body in three different shapes.
 *
 *  1. application/json
 *  2. form-encoded (a=1&b=2)
 *  3. the entire JSON document as a single form KEY with an empty value -
 *     easy to miss, and yields a nonsense object with one garbage key.
 */
export function parseNotifyBody(
  rawBody: string,
  contentType: string | undefined
): Record<string, unknown> {
  if (!rawBody.trim()) return {};

  if (contentType?.includes('application/json')) {
    return JSON.parse(rawBody) as Record<string, unknown>;
  }

  try {
    return JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    const entries = Object.fromEntries(new URLSearchParams(rawBody));
    const keys = Object.keys(entries);

    if (keys.length === 1 && entries[keys[0]] === '') {
      try {
        return JSON.parse(keys[0]) as Record<string, unknown>;
      } catch {
        // genuinely a form payload; fall through
      }
    }

    return entries;
  }
}

/**
 * GET /pay/telebirr/return
 * Where the user's browser lands. Cosmetic ONLY - it proves nothing about
 * payment, so it never fulfils. The success page polls for the real status.
 */
export const handleTelebirrReturn = async (req: Request, res: Response): Promise<void> => {
  const orderNo = String(req.query.orderNo || req.query.callback_info || '').trim();

  if (!orderNo) {
    res.redirect('/pay');
    return;
  }

  res.redirect(`/pay/success?orderNo=${encodeURIComponent(orderNo)}`);
};

/**
 * POST /api/payment/telebirr/miniapp/order
 *
 * Mini App checkout. Returns the `rawRequest` string as PLAIN TEXT, because the
 * SuperApp sample reads it with `res.text()` and hands it straight to the
 * payment JS bridge. Do not wrap it in JSON.
 */
export const createMiniAppOrder = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderNo } = req.body;

    if (!orderNo) {
      res.status(400).type('text/plain').send('Missing orderNo');
      return;
    }

    const order = await orderStore.getOrder(String(orderNo));
    if (!order) {
      res.status(404).type('text/plain').send('Order not found');
      return;
    }

    if (order.status === 'PAID' || order.status === 'VENDED') {
      res.status(409).type('text/plain').send('Order has already been paid');
      return;
    }

    logFlow('pay_requested', order.orderNo, {
      mode: 'InApp',
      amount: order.price,
      slotNo: order.slotNo,
      machineId: order.machineId,
    });

    const result = await getTelebirrClient().createInAppOrder({
      orderId: order.orderNo,
      amount: order.price,
      title: `Vending Order ${order.orderNo}`,
      callbackInfo: order.orderNo,
    });

    await orderStore.attachTelebirrAttempt(
      order.orderNo,
      result.merchantOrderId,
      result.prepayId
    );

    logFlow('preorder_ok', order.orderNo, {
      merchOrderId: result.merchantOrderId,
      prepayId: result.prepayId,
    });

    eventBroadcaster.broadcast('TELEBIRR_MINIAPP_INITIATED', {
      orderNo: order.orderNo,
      merchOrderId: result.merchantOrderId,
    });

    logFlow('handoff_to_app', order.orderNo, { rawRequestLength: result.rawRequest.length });
    res.status(200).type('text/plain').send(result.rawRequest);
  } catch (error: any) {
    await telebirrAudit('miniapp_order_failed', {
      orderNo: req.body?.orderNo,
      error: String(error),
    });
    res.status(502).type('text/plain').send(error.message || 'Could not create Telebirr order');
  }
};

/**
 * POST /api/payment/telebirr/miniapp/auth
 *
 * Exchanges the SuperApp `access_token` for the user's identity (`open_id`).
 * Only meaningful for a request originating inside the SuperApp.
 */
export const miniAppAuthToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const accessToken = req.body?.access_token || req.body?.accessToken;

    if (!accessToken) {
      res.status(400).json({ success: false, message: 'Missing access_token' });
      return;
    }

    const result = await getTelebirrClient().authToken(String(accessToken));
    const biz = (result.biz_content ?? result) as Record<string, unknown>;

    if (String(result.result ?? '') !== 'SUCCESS' || String(result.code ?? '') !== '0') {
      await telebirrAudit('miniapp_auth_failed', result);
      res.status(502).json({ success: false, message: String(result.msg || 'Auth failed') });
      return;
    }

    // Only the identifiers, never the raw token, back to the client.
    res.status(200).json({
      success: true,
      openId: biz.open_id ?? null,
      identityId: biz.identityId ?? null,
      identityType: biz.identityType ?? null,
    });
  } catch (error: any) {
    await telebirrAudit('miniapp_auth_error', { error: String(error) });
    res.status(502).json({ success: false, message: error.message || 'Auth failed' });
  }
};

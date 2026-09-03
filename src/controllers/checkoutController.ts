import { Request, Response } from 'express';
import { z } from 'zod';
import { orderStore } from '../services/orderStore';
import { eventBroadcaster } from '../services/eventBroadcaster';
import { sandboxPaymentsAllowed } from '../config/telebirr';
import { reconcilePendingOrder } from '../services/telebirr/reconcile';
import * as vendQueue from '../services/vendQueue';
import * as machineInventory from '../services/machineInventory';
import { logFlow } from '../lib/flowLogger';

/**
 * Query parameters a machine supplies when its QR code is scanned.
 *
 * There are deliberately no defaults. A missing or unparseable value means the
 * visitor did not arrive from a machine scan, and inventing a price and order
 * number for them renders a checkout page that cannot be paid.
 */
const checkoutParamsSchema = z.object({
  mid: z.string().trim().min(1, 'machine id is required'),
  sid: z.coerce.number({ invalid_type_error: 'slot must be a number' }).int().min(0),
  pri: z.coerce.number({ invalid_type_error: 'price must be a number' }).positive().finite(),
  pid: z.string().trim().min(1).optional(),
});

/** Renders the "scan from the machine" notice instead of an unpayable checkout. */
function renderInvalid(res: Response, reason: string): void {
  res.status(400).render('invalid', { title: 'TOMOCA Coffee', reason });
}

/**
 * GET /pay
 * Mobile checkout landing page, reached by scanning the QR on a machine.
 *
 * Two ways in: an existing `orderNo`, or the `mid` / `sid` / `pri` triple that
 * creates a new order. Anything else gets the invalid notice, never a page
 * built from placeholder values.
 */
export const renderCheckoutPage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderNo: customOrderNo } = req.query;

    // Path 1: returning to an order that already exists.
    if (customOrderNo) {
      const existing = await orderStore.getOrder(String(customOrderNo));

      if (!existing) {
        renderInvalid(res, 'That order number does not exist. It may have expired.');
        return;
      }

      res.render('checkout', {
        title: 'TOMOCA Coffee',
        mid: existing.machineId,
        sid: existing.slotNo,
        pid: existing.goodsId || '1',
        price: existing.price.toFixed(2),
        orderNo: existing.orderNo,
        sandbox: sandboxPaymentsAllowed(),
      });
      return;
    }

    // Path 2: a fresh scan. Every parameter must be present and valid.
    const parsed = checkoutParamsSchema.safeParse(req.query);

    if (!parsed.success) {
      renderInvalid(res, 'This page was opened without the details a machine provides.');
      return;
    }

    logFlow('scan', null, {
      mid: parsed.data.mid,
      sid: parsed.data.sid,
      pid: parsed.data.pid,
      pri: parsed.data.pri,
    });

    const order = await orderStore.createCheckoutOrder({
      mid: parsed.data.mid,
      sid: parsed.data.sid,
      pid: parsed.data.pid,
      pri: parsed.data.pri,
    });

    logFlow('order_created', order.orderNo, {
      machineId: order.machineId,
      slotNo: order.slotNo,
      price: order.price,
    });

    res.render('checkout', {
      title: 'TOMOCA Coffee',
      mid: order.machineId,
      sid: order.slotNo,
      pid: order.goodsId || '1',
      price: order.price.toFixed(2),
      orderNo: order.orderNo,
      sandbox: sandboxPaymentsAllowed(),
    });
  } catch (error: any) {
    res.status(500).send(`Error rendering checkout page: ${error.message}`);
  }
};

/**
 * GET /pay/success
 * Completion & Dispense verification page controller.
 * Displays dynamic status card polling /api/orders/:orderNo/status every 1.5s.
 */
export const renderSuccessPage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderNo } = req.query;

    if (!orderNo) {
      renderInvalid(res, 'No order number was supplied.');
      return;
    }

    const order = await orderStore.getOrder(String(orderNo));

    // Same rule as the checkout page: show the real order or say plainly that
    // there isn't one. Never fill the card with placeholder values.
    if (!order) {
      renderInvalid(res, 'That order number does not exist. It may have expired.');
      return;
    }

    res.render('success', {
      title: 'TOMOCA Coffee',
      orderNo: order.orderNo,
      mid: order.machineId,
      sid: order.slotNo,
      price: order.price.toFixed(2),
      status: order.status,
    });
  } catch (error: any) {
    res.status(500).send(`Error rendering success page: ${error.message}`);
  }
};

/**
 * POST /vend  (also GET, kept for manual checks)
 *
 * The AFEN machine's only channel. It posts form-encoded TitleCase fields and
 * expects TitleCase JSON back: `Code` and `Msg`, not `code` and `msg`.
 *
 *   FunCode 1000  inventory heartbeat, one slot per message   -> plain ACK
 *   FunCode 4000  poll every ~3s, this is where a dispense is handed over
 *   FunCode 5000  dispense confirmation from the drop sensor  -> ACK, settle order
 *
 * Anything unrecognised is acknowledged rather than errored: the machine has no
 * error path we can observe, and a non-ACK risks stalling its loop.
 */
const ACK = { Code: '0', Msg: 'SUCCESS' } as const;

export const handleDirectVendPoll = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, string>;
    const query = (req.query ?? {}) as Record<string, string>;

    const funCode = String(body.FunCode ?? query.FunCode ?? '');
    const machineId = String(body.MachineID ?? body.machineId ?? query.mid ?? '');
    const tradeNo = String(body.TradeNo ?? query.TradeNo ?? '');

    // FunCode 5000: the drop sensor has reported. This is the only message that
    // says whether the customer actually received anything.
    if (funCode === '5000') {
      await settleDispense({ tradeNo, status: String(body.Status ?? ''), body });
      res.status(200).json(ACK);
      return;
    }

    // FunCode 4000: hand over one queued dispense, or report idle.
    if (funCode === '4000') {
      const { command, expired } = vendQueue.dequeue(machineId);

      for (const stale of expired) {
        console.log('[vend] EXPIRED ' + JSON.stringify(stale));
        eventBroadcaster.broadcast('VEND_EXPIRED', stale);
      }

      if (!command) {
        res.status(200).json({ Code: '0', Msg: 'SUCCESS', Data: '' });
        return;
      }

      logFlow('vend_dispatched', command.orderNo, {
        machineId,
        slotNo: command.SlotNo,
        amount: command.Amount,
        tradeNo: command.TradeNo,
        waitedMs: Date.now() - command.timestamp,
      });
      eventBroadcaster.broadcast('VEND_DISPATCHED', { ...command, machineId });

      res.status(200).json({
        Code: '0',
        Msg: 'SUCCESS',
        TradeNo: command.TradeNo,
        SlotNo: command.SlotNo,
        Amount: command.Amount,
        PayType: command.PayType,
      });
      return;
    }

    // FunCode 1000: an inventory report for one slot. Recorded so current stock
    // is queryable, and logged compactly - the full body once per second per
    // slot would bury everything else.
    if (funCode === '1000') {
      const slot = machineInventory.record(machineId, body);

      if (slot && slot.status !== '255') {
        console.log(
          `[vend] INV slot=${slot.slotNo} stock=${slot.stock}/${slot.capacity} ` +
            `price=${slot.price} name="${slot.name}"`
        );
      }

      res.status(200).json(ACK);
      return;
    }

    // Anything unrecognised: log it in full, since it is something new.
    console.log('[vend] UNKNOWN FunCode ' + JSON.stringify({ funCode, body }));
    res.status(200).json(ACK);
  } catch (error: any) {
    console.error('[vend] handler error', error);
    // Still acknowledge: a machine stuck retrying a failed poll is worse than a
    // missed message, and the queue keeps the command for the next one.
    res.status(200).json(ACK);
  }
};

/**
 * Settle an order against the machine's dispense confirmation.
 *
 * Status "0" means the product dropped. Anything else means it did not: motor
 * jam, empty slot, or no drop detected. The customer has already paid in that
 * case, so it is recorded as a failure needing a human rather than quietly
 * treated as delivered.
 */
async function settleDispense(params: {
  tradeNo: string;
  status: string;
  body: Record<string, string>;
}): Promise<void> {
  const inFlight = vendQueue.takeInFlight(params.tradeNo);
  const orderNo = inFlight?.orderNo ?? params.tradeNo;

  const order = orderNo ? await orderStore.getOrder(orderNo) : null;

  logFlow('vend_confirmed', order?.orderNo ?? null, {
    tradeNo: params.tradeNo,
    machineStatus: params.status,
    dispensed: params.status === '0',
    wasDispatchedByUs: Boolean(inFlight),
    slotNo: params.body.SlotNo,
  });

  if (!order) {
    // The machine reports its own offline sales too, which have no order here.
    eventBroadcaster.broadcast('VEND_CONFIRMATION_UNMATCHED', params.body);
    return;
  }

  // Only settle an order this server actually handed over, or one that is at
  // least paid. The machine also reports its own cash and card sales, and a
  // TradeNo of its choosing must never be able to mark an unpaid order as
  // delivered.
  const settleable = Boolean(inFlight) || order.status === 'PAID';

  if (!settleable) {
    console.log(
      '[vend] CONFIRMATION IGNORED ' +
        JSON.stringify({ orderNo: order.orderNo, status: order.status, tradeNo: params.tradeNo })
    );
    eventBroadcaster.broadcast('VEND_CONFIRMATION_IGNORED', {
      orderNo: order.orderNo,
      orderStatus: order.status,
    });
    return;
  }

  if (params.status === '0') {
    await orderStore.markOrderDispensed(order.orderNo);
    logFlow('order_dispensed', order.orderNo, { slotNo: order.slotNo, price: order.price });
    return;
  }

  await orderStore.markOrderDispenseFailed(order.orderNo, `machine status ${params.status}`);
  logFlow('order_failed', order.orderNo, {
    reason: `machine status ${params.status}`,
    slotNo: order.slotNo,
    price: order.price,
    note: 'customer paid and received nothing',
  });
}

/**
 * GET /api/orders/:orderNo/status
 * Lightweight status endpoint for frontend status polling script.
 */
export const getOrderStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const orderNo = String(req.params.orderNo);

    // Do not wait to be told. If this order is still pending, ask Telebirr
    // directly, throttled internally so polling cannot hammer queryOrder.
    await reconcilePendingOrder(orderNo);

    const order = await orderStore.getOrder(orderNo);

    if (!order) {
      res.status(404).json({ success: false, message: 'Order not found', paid: false });
      return;
    }

    const paid =
      order.status === 'PAID' ||
      order.status === 'VENDED' ||
      order.status === 'DISPENSED' ||
      order.status === 'DISPENSE_FAILED';
    res.status(200).json({
      orderNo: order.orderNo,
      status: order.status,
      paid,
      slotNo: order.slotNo,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, paid: false });
  }
};

/**
 * GET /pay/mock-telebirr
 * Interactive Sandbox Telebirr PIN payment simulator page.
 */
export const renderMockTelebirrPage = async (req: Request, res: Response): Promise<void> => {
  const { orderNo, amount } = req.query;

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Telebirr H5 Payment Simulator</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-stone-900 min-h-screen flex items-center justify-center p-4 text-white font-sans">
      <div class="bg-white text-stone-900 p-6 rounded-2xl max-w-sm w-full shadow-2xl text-center space-y-4">
        <div class="w-12 h-12 rounded-full bg-orange-600 text-white flex items-center justify-center mx-auto text-xl font-bold">tb</div>
        <h2 class="text-xl font-bold text-stone-900">telebirr Web Checkout</h2>
        <div class="bg-stone-50 p-3 rounded-xl border border-stone-200">
          <p class="text-xs text-stone-500">Merchant: TOMOCA Coffee</p>
          <p class="text-xs text-stone-500">Order: ${orderNo}</p>
          <p class="text-2xl font-extrabold text-orange-600 mt-1">${amount} ETB</p>
        </div>
        <button onclick="approvePay()" class="w-full py-3 bg-orange-600 hover:bg-orange-700 text-white font-bold rounded-xl shadow-lg transition-all">
          Confirm PIN & Pay ${amount} ETB
        </button>
      </div>
      <script>
        async function approvePay() {
          // Sandbox-only endpoint. The real Telebirr notify route verifies
          // signatures and will reject a hand-rolled body like this one.
          await fetch('/api/webhooks/payment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderNo: '${orderNo}', amount: '${amount}', paymentMethod: 'Sandbox' })
          });
          window.location.href = '/pay/success?orderNo=${orderNo}';
        }
      </script>
    </body>
    </html>
  `);
};

/**
 * GET /api/checkout/session
 *
 * JSON equivalent of renderCheckoutPage, for the React front end. Same two ways
 * in and the same validation: an existing `orderNo`, or the mid/sid/pri triple
 * that creates an order. No defaults, so an invalid request is told so rather
 * than handed a placeholder order it can never pay for.
 */
export const getCheckoutSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderNo: customOrderNo } = req.query;

    if (customOrderNo) {
      const existing = await orderStore.getOrder(String(customOrderNo));

      if (!existing) {
        res.status(404).json({
          success: false,
          message: 'That order number does not exist. It may have expired.',
        });
        return;
      }

      res.status(200).json({ success: true, order: toSessionPayload(existing) });
      return;
    }

    const parsed = checkoutParamsSchema.safeParse(req.query);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: 'This page was opened without the details a machine provides.',
      });
      return;
    }

    const order = await orderStore.createCheckoutOrder({
      mid: parsed.data.mid,
      sid: parsed.data.sid,
      pid: parsed.data.pid,
      pri: parsed.data.pri,
    });

    res.status(201).json({ success: true, order: toSessionPayload(order) });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/** Only the fields the checkout UI needs. Price is a 2 decimal string. */
function toSessionPayload(order: {
  orderNo: string;
  machineId: string;
  slotNo: number;
  goodsId?: string | null;
  price: number;
  status: string;
}) {
  return {
    orderNo: order.orderNo,
    machineId: order.machineId,
    slotNo: order.slotNo,
    productId: order.goodsId || '1',
    price: order.price.toFixed(2),
    status: order.status,
    paid: order.status === 'PAID' || order.status === 'VENDED',
  };
}

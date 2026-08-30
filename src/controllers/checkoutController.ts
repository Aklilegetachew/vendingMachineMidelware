import { Request, Response } from 'express';
import { z } from 'zod';
import { orderStore } from '../services/orderStore';
import { eventBroadcaster } from '../services/eventBroadcaster';
import { sandboxPaymentsAllowed } from '../config/telebirr';
import { reconcilePendingOrder } from '../services/telebirr/reconcile';

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

    const order = await orderStore.createCheckoutOrder({
      mid: parsed.data.mid,
      sid: parsed.data.sid,
      pid: parsed.data.pid,
      pri: parsed.data.pri,
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
 * Direct AFen Machine Polling Hook: POST /vend & GET /vend
 * Polled by AFen machine screen to inspect paid orders and dispense product.
 */
export const handleDirectVendPoll = async (req: Request, res: Response): Promise<void> => {
  try {
    const machineId = (req.body?.machineId || req.query?.mid || req.query?.machineId) as string;
    const orderNo = (req.body?.orderNo || req.query?.orderNo) as string;

    let order = orderNo ? await orderStore.getOrder(orderNo) : null;

    if (!order && machineId) {
      order = await orderStore.getActivePaidOrderForMachine(machineId);
    }

    eventBroadcaster.broadcast('DIRECT_VEND_POLL', {
      machineId,
      orderNo: order?.orderNo || orderNo,
      status: order?.status || 'WAITING',
    });

    if (order && (order.status === 'PAID' || order.status === 'VENDED')) {
      if (order.status === 'PAID') {
        await orderStore.markOrderAsVended(order.orderNo);
      }

      res.status(200).json({
        code: 0,
        status: 'SUCCESS',
        paid: true,
        action: 'VEND',
        slotNo: order.slotNo,
      });
      return;
    }

    res.status(200).json({
      code: 0,
      status: 'WAITING',
      paid: false,
    });
  } catch (error: any) {
    res.status(500).json({ code: 500, msg: error.message });
  }
};

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

    const paid = order.status === 'PAID' || order.status === 'VENDED';
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

import { Request, Response } from 'express';
import { orderStore } from '../services/orderStore';
import { eventBroadcaster } from '../services/eventBroadcaster';
import { sandboxPaymentsAllowed } from '../config/telebirr';

/**
 * GET /pay
 * Minimalist Mobile QR Scan landing page controller.
 * Extracts mid, sid, pid, pri and renders views/checkout.ejs
 */
export const renderCheckoutPage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { mid, sid, pid, pri, orderNo: customOrderNo } = req.query;

    let order = customOrderNo ? await orderStore.getOrder(String(customOrderNo)) : null;

    if (!order && mid && sid && pri) {
      order = await orderStore.createCheckoutOrder({
        mid: String(mid),
        sid: parseInt(String(sid), 10),
        pid: pid ? String(pid) : '1',
        pri: parseFloat(String(pri)),
        customOrderNo: customOrderNo ? String(customOrderNo) : undefined,
      });
    }

    const machineId = order?.machineId || String(mid || '2504150044');
    const slotNo = order?.slotNo || (sid ? parseInt(String(sid), 10) : 1);
    const productId = order?.goodsId || String(pid || '1');
    const price = order?.price ? order.price.toFixed(2) : parseFloat(String(pri || '70.00')).toFixed(2);
    const orderNo = order?.orderNo || `ORD-${Date.now()}-1001`;

    res.render('checkout', {
      title: 'TOMOCA Coffee',
      mid: machineId,
      sid: slotNo,
      pid: productId,
      price,
      orderNo,
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
      res.redirect('/pay');
      return;
    }

    const order = await orderStore.getOrder(String(orderNo));

    res.render('success', {
      title: 'TOMOCA Coffee',
      orderNo: String(orderNo),
      mid: order?.machineId || '2504150044',
      sid: order?.slotNo || 1,
      price: order?.price ? order.price.toFixed(2) : '70.00',
      status: order?.status || 'PENDING',
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

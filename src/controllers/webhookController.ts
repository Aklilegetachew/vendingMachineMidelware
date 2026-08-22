import { Request, Response } from 'express';
import { orderStore } from '../services/orderStore';
import { eventBroadcaster } from '../services/eventBroadcaster';

/**
 * Payment Gateway Callback Endpoint: POST /api/webhooks/payment
 * Handles verification callbacks from Telebirr / CBE Birr / EthSwitch IPS ET.
 */
export const handlePaymentWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderNo, referenceNumber, paymentReference, amount, paymentMethod } = req.body;

    if (!orderNo) {
      res.status(400).json({
        success: false,
        message: 'Missing orderNo in webhook payload',
      });
      return;
    }

    const ref = paymentReference || referenceNumber || `PAY-${Date.now()}`;
    const method = paymentMethod || 'EthSwitch / Telebirr';

    const order = await orderStore.markOrderAsPaid(orderNo, ref, method);

    if (!order) {
      res.status(404).json({
        success: false,
        message: `Order ${orderNo} not found`,
      });
      return;
    }

    eventBroadcaster.broadcast('PAYMENT_WEBHOOK_RECEIVED', {
      orderNo,
      amount,
      referenceNumber: ref,
      paymentMethod: method,
    });

    res.status(200).json({
      success: true,
      message: 'Payment notification processed successfully',
      order: {
        orderNo: order.orderNo,
        status: order.status,
        slotNo: order.slotNo,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || 'Error processing payment webhook',
    });
  }
};

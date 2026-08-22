import { Request, Response } from 'express';
import { generateEthSwitchQr } from '../services/qrEngine';
import { orderStore } from '../services/orderStore';
import { eventBroadcaster } from '../services/eventBroadcaster';

/**
 * Electric Pay Endpoint: POST /api/vending/pay
 * Called by AFen smart vending machine to generate dynamic EthSwitch QR code.
 */
export const handleVendingPay = async (req: Request, res: Response): Promise<void> => {
  try {
    const { machineId, slotNo, goodsId, price, orderNo } = req.body;

    if (!machineId || !slotNo || price === undefined || !orderNo) {
      res.status(400).json({
        code: 400,
        msg: 'Missing required parameters: machineId, slotNo, price, orderNo',
      });
      return;
    }

    const numPrice = Number(price);
    const numSlotNo = Number(slotNo);

    // Generate NBE / EthSwitch EMVCo Dynamic QR Payload
    const qrCode = generateEthSwitchQr({
      amount: numPrice,
      orderNo,
      machineId,
    });

    // Save order state
    await orderStore.createOrder({
      orderNo,
      machineId,
      slotNo: numSlotNo,
      price: numPrice,
      goodsId,
      qrCode,
    });

    eventBroadcaster.broadcast('VENDING_PAY_REQUEST', {
      machineId,
      slotNo: numSlotNo,
      orderNo,
      price: numPrice,
      qrCode,
    });

    res.status(200).json({
      code: 0,
      msg: 'success',
      data: {
        orderNo,
        qrCode,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      code: 500,
      msg: error.message || 'Internal server error',
    });
  }
};

/**
 * Electric Pickup Polling Endpoint: POST /api/vending/vend & GET /api/vending/vend
 * Polled by AFen machine to check payment status and receive VEND command.
 */
export const handleVendingVend = async (req: Request, res: Response): Promise<void> => {
  try {
    const orderNo = (req.body?.orderNo || req.query?.orderNo) as string;
    const machineId = (req.body?.machineId || req.query?.machineId) as string;

    if (!orderNo) {
      res.status(400).json({
        code: 400,
        msg: 'Missing required orderNo parameter',
      });
      return;
    }

    const order = await orderStore.getOrder(orderNo);

    eventBroadcaster.broadcast('VENDING_POLL', {
      machineId: machineId || order?.machineId,
      orderNo,
      status: order?.status || 'NOT_FOUND',
    });

    // If payment confirmed
    if (order && (order.status === 'PAID' || order.status === 'VENDED')) {
      if (order.status === 'PAID') {
        await orderStore.markOrderAsVended(orderNo);
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

    // Default response while waiting for customer to scan & pay
    res.status(200).json({
      code: 0,
      status: 'WAITING',
      paid: false,
    });
  } catch (error: any) {
    res.status(500).json({
      code: 500,
      msg: error.message || 'Internal server error',
    });
  }
};

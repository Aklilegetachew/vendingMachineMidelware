import { prisma } from '../lib/prisma';
import { eventBroadcaster } from './eventBroadcaster';
import * as vendQueue from './vendQueue';

export type OrderStatus = 'PENDING' | 'PROCESSING' | 'PAID' | 'VENDED' | 'EXPIRED';

export interface OrderData {
  id: string;
  orderNo: string;
  machineId: string;
  slotNo: number;
  goodsId?: string | null;
  price: number;
  qrCode?: string | null;
  status: string;
  paymentReference?: string | null;
  paymentMethod?: string | null;
  paidAt?: Date | null;
  dispensedAt?: Date | null;
  expiresAt?: Date | null;
  // Telebirr attempt details, set by attachTelebirrAttempt.
  merchOrderId?: string | null;
  transactionId?: string | null;
  prepayId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class OrderStore {
  public async createCheckoutOrder(params: {
    mid: string;
    sid: number;
    pid?: string;
    pri: number;
    customOrderNo?: string;
  }): Promise<OrderData> {
    const timestamp = Date.now();
    const rand = Math.floor(1000 + Math.random() * 9000);
    const orderNo = params.customOrderNo || `ORD-${timestamp}-${rand}`;
    const expiresAt = new Date(timestamp + 5 * 60 * 1000); // 5-minute TTL

    const order = await prisma.order.create({
      data: {
        orderNo,
        machineId: params.mid,
        slotNo: params.sid,
        goodsId: params.pid || 'ITEM-01',
        price: params.pri,
        qrCode: `MOBILE_CHECKOUT:${orderNo}`,
        status: 'PENDING',
      },
    });

    eventBroadcaster.broadcast('CHECKOUT_ORDER_CREATED', { ...order, expiresAt });
    return { ...order, expiresAt };
  }

  public async createOrder(params: {
    orderNo: string;
    machineId: string;
    slotNo: number;
    price: number;
    goodsId?: string;
    qrCode: string;
  }): Promise<OrderData> {
    const timestamp = Date.now();
    const expiresAt = new Date(timestamp + 5 * 60 * 1000);

    const order = await prisma.order.upsert({
      where: { orderNo: params.orderNo },
      update: {
        machineId: params.machineId,
        slotNo: params.slotNo,
        goodsId: params.goodsId || null,
        price: params.price,
        qrCode: params.qrCode,
        status: 'PENDING',
      },
      create: {
        orderNo: params.orderNo,
        machineId: params.machineId,
        slotNo: params.slotNo,
        goodsId: params.goodsId || null,
        price: params.price,
        qrCode: params.qrCode,
        status: 'PENDING',
      },
    });

    eventBroadcaster.broadcast('ORDER_CREATED', { ...order, expiresAt });
    return { ...order, expiresAt };
  }

  public async getOrder(orderNo: string): Promise<OrderData | null> {
    const order = await prisma.order.findUnique({
      where: { orderNo },
    });
    if (!order) return null;

    const expiresAt = new Date(new Date(order.createdAt).getTime() + 5 * 60 * 1000);
    return { ...order, expiresAt };
  }

  public async getActivePaidOrderForMachine(machineId: string): Promise<OrderData | null> {
    const order = await prisma.order.findFirst({
      where: {
        machineId,
        status: 'PAID',
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!order) return null;

    const expiresAt = new Date(new Date(order.createdAt).getTime() + 5 * 60 * 1000);
    return { ...order, expiresAt };
  }

  public async markOrderAsPaid(
    orderNo: string,
    paymentReference?: string,
    paymentMethod?: string
  ): Promise<OrderData | null> {
    const existing = await this.getOrder(orderNo);
    if (!existing) return null;

    const updated = await prisma.order.update({
      where: { orderNo },
      data: {
        status: 'PAID',
        paymentReference: paymentReference || `TELEBIRR-${Date.now()}`,
        paymentMethod: paymentMethod || 'Telebirr H5 Web',
        paidAt: new Date(),
      },
    });

    const expiresAt = new Date(new Date(updated.createdAt).getTime() + 5 * 60 * 1000);
    eventBroadcaster.broadcast('ORDER_PAID', { ...updated, expiresAt });

    // Queue the dispense here too, so the sandbox path exercises exactly the
    // same machine handover as a real Telebirr payment.
    vendQueue.enqueue(updated.machineId, {
      TradeNo: updated.orderNo,
      SlotNo: String(updated.slotNo),
      Amount: Number(updated.price).toFixed(2),
      PayType: '3',
      timestamp: Date.now(),
      orderNo: updated.orderNo,
    });

    return { ...updated, expiresAt };
  }

  /**
   * Find an order by the merch_order_id we sent to Telebirr.
   *
   * The gateway's alphanumeric constraint means merch_order_id can no longer be
   * parsed back into an orderNo, so this lookup is the fallback when a callback
   * arrives without usable callback_info.
   */
  public async getOrderByMerchOrderId(merchOrderId: string): Promise<OrderData | null> {
    const order = await prisma.order.findFirst({
      where: { merchOrderId },
      orderBy: { createdAt: 'desc' },
    });
    if (!order) return null;

    const expiresAt = new Date(new Date(order.createdAt).getTime() + 5 * 60 * 1000);
    return { ...order, expiresAt };
  }

  /** Record the Telebirr attempt so a callback can be mapped back to this order. */
  public async attachTelebirrAttempt(
    orderNo: string,
    merchOrderId: string,
    prepayId: string
  ): Promise<void> {
    await prisma.order.update({
      where: { orderNo },
      data: { merchOrderId, prepayId, paymentMethod: 'Telebirr' },
    });
  }

  /**
   * Idempotent fulfilment for a confirmed Telebirr payment.
   *
   * Telebirr redelivers notifications, so this must be safe to call repeatedly.
   * Two guards: the PENDING-only conditional update (only one caller can win
   * the transition) and the UNIQUE constraint on transactionId.
   *
   * Returns true only for the call that actually performed the transition.
   */
  public async markOrderPaidByTelebirr(params: {
    orderNo: string;
    transactionId: string;
    merchOrderId: string;
  }): Promise<boolean> {
    try {
      const result = await prisma.order.updateMany({
        // Only a not-yet-paid order transitions. A replay matches zero rows.
        where: { orderNo: params.orderNo, status: { in: ['PENDING', 'INITIATED'] } },
        data: {
          status: 'PAID',
          paymentReference: params.transactionId,
          paymentMethod: 'Telebirr',
          transactionId: params.transactionId,
          merchOrderId: params.merchOrderId,
          paidAt: new Date(),
        },
      });

      if (result.count === 0) return false;
    } catch (error: any) {
      // P2002 = unique violation on transactionId: another delivery won.
      if (error?.code === 'P2002') return false;
      throw error;
    }

    const updated = await prisma.order.findUnique({ where: { orderNo: params.orderNo } });
    if (updated) {
      const expiresAt = new Date(new Date(updated.createdAt).getTime() + 5 * 60 * 1000);
      eventBroadcaster.broadcast('ORDER_PAID', { ...updated, expiresAt });

      // Hand the dispense to the machine's queue. This is the only place an
      // order becomes PAID, so both the notify callback and the queryOrder
      // reconciliation reach it, and neither can forget to enqueue.
      vendQueue.enqueue(updated.machineId, {
        TradeNo: updated.orderNo,
        SlotNo: String(updated.slotNo),
        Amount: Number(updated.price).toFixed(2),
        PayType: '3',
        timestamp: Date.now(),
        orderNo: updated.orderNo,
      });

      eventBroadcaster.broadcast('VEND_QUEUED', {
        orderNo: updated.orderNo,
        machineId: updated.machineId,
        slotNo: updated.slotNo,
      });
    }
    return true;
  }

  /** The machine confirmed the product physically dropped (FunCode 5000, Status 0). */
  public async markOrderDispensed(orderNo: string): Promise<OrderData | null> {
    const updated = await prisma.order.update({
      where: { orderNo },
      data: { status: 'DISPENSED', dispensedAt: new Date() },
    });

    const expiresAt = new Date(new Date(updated.createdAt).getTime() + 5 * 60 * 1000);
    eventBroadcaster.broadcast('ORDER_DISPENSED', { ...updated, expiresAt });
    return { ...updated, expiresAt };
  }

  /**
   * The machine reported a non-zero status: motor jam, no drop detected, or an
   * empty slot. The customer paid and got nothing, so this needs a human.
   */
  public async markOrderDispenseFailed(
    orderNo: string,
    reason: string
  ): Promise<OrderData | null> {
    const updated = await prisma.order.update({
      where: { orderNo },
      data: { status: 'DISPENSE_FAILED', paymentMethod: `Telebirr (${reason})` },
    });

    const expiresAt = new Date(new Date(updated.createdAt).getTime() + 5 * 60 * 1000);
    eventBroadcaster.broadcast('ORDER_DISPENSE_FAILED', { ...updated, expiresAt, reason });
    return { ...updated, expiresAt };
  }

  public async markOrderAsVended(orderNo: string): Promise<OrderData | null> {
    const existing = await this.getOrder(orderNo);
    if (!existing) return null;

    const updated = await prisma.order.update({
      where: { orderNo },
      data: {
        status: 'VENDED',
        dispensedAt: new Date(),
      },
    });

    const expiresAt = new Date(new Date(updated.createdAt).getTime() + 5 * 60 * 1000);
    eventBroadcaster.broadcast('ORDER_VENDED', { ...updated, expiresAt });
    return { ...updated, expiresAt };
  }

  public async getRecentOrders(limit = 50): Promise<OrderData[]> {
    const orders = await prisma.order.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' },
    });

    return orders.map((o) => ({
      ...o,
      expiresAt: new Date(new Date(o.createdAt).getTime() + 5 * 60 * 1000),
    }));
  }
}

export const orderStore = new OrderStore();

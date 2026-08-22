import { describe, it, expect } from 'vitest';
import { orderStore } from '../src/services/orderStore';

describe('Mobile Web Checkout & Telebirr Lifecycle', () => {
  it('should create a checkout order with PENDING status and 5-minute TTL', async () => {
    const order = await orderStore.createCheckoutOrder({
      mid: '2504150044',
      sid: 1,
      pid: '1',
      pri: 70.0,
    });

    expect(order).toBeDefined();
    expect(order.orderNo).toMatch(/^ORD-\d+-\d+$/);
    expect(order.machineId).toBe('2504150044');
    expect(order.slotNo).toBe(1);
    expect(order.price).toBe(70.0);
    expect(order.status).toBe('PENDING');

    // TTL check (5 minutes = 300,000 ms)
    expect(order.expiresAt).toBeDefined();
    const diffMs = order.expiresAt!.getTime() - new Date(order.createdAt).getTime();
    expect(diffMs).toBeGreaterThanOrEqual(299000);
    expect(diffMs).toBeLessThanOrEqual(301000);
  });

  it('should transition order to PAID and then VENDED on polling', async () => {
    const order = await orderStore.createCheckoutOrder({
      mid: '2504150044',
      sid: 3,
      pri: 70.0,
    });

    const paidOrder = await orderStore.markOrderAsPaid(order.orderNo, 'TELEBIRR-REF-100', 'Telebirr');
    expect(paidOrder?.status).toBe('PAID');

    const activePaid = await orderStore.getActivePaidOrderForMachine('2504150044');
    expect(activePaid?.orderNo).toBe(order.orderNo);

    const vendedOrder = await orderStore.markOrderAsVended(order.orderNo);
    expect(vendedOrder?.status).toBe('VENDED');
  });

  it('should fulfil a Telebirr payment exactly once when the notify is redelivered', async () => {
    const order = await orderStore.createCheckoutOrder({
      mid: '2504150044',
      sid: 4,
      pri: 25.0,
    });

    const payment = {
      orderNo: order.orderNo,
      transactionId: `TXN-${Date.now()}`,
      merchOrderId: `ORD${order.orderNo}T${Math.floor(Date.now() / 1000)}`,
    };

    // Telebirr redelivers notifications; only the first may dispense.
    const first = await orderStore.markOrderPaidByTelebirr(payment);
    const second = await orderStore.markOrderPaidByTelebirr(payment);

    expect(first).toBe(true);
    expect(second).toBe(false);

    const stored = await orderStore.getOrder(order.orderNo);
    expect(stored?.status).toBe('PAID');
    expect(stored?.paymentReference).toBe(payment.transactionId);
  });
});

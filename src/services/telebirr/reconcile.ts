import { getTelebirrClient, telebirrAudit } from './index';
import { isSuccessfulStatus, extractStatus } from './client';
import { orderStore } from '../orderStore';

/**
 * Ask Telebirr directly whether a pending order was paid.
 *
 * The notify callback is not guaranteed: it can be late, or never arrive at
 * all. Without this the order sits PENDING forever and the customer is charged
 * with nothing dispensed. queryOrder is the authoritative answer, so we ask it
 * ourselves rather than waiting to be told.
 */

/** queryOrder is rate limited, so one live check per order per interval. */
const lastCheck = new Map<string, number>();
const MIN_INTERVAL_MS = 6000;

export async function reconcilePendingOrder(orderNo: string): Promise<boolean> {
  const order = await orderStore.getOrder(orderNo);

  // Only orders that were actually handed to Telebirr and are still unpaid.
  if (!order || !order.merchOrderId) return false;
  if (order.status !== 'PENDING' && order.status !== 'INITIATED') return false;

  const now = Date.now();
  const previous = lastCheck.get(orderNo) ?? 0;
  if (now - previous < MIN_INTERVAL_MS) return false;
  lastCheck.set(orderNo, now);

  try {
    const response = await getTelebirrClient().queryOrder(order.merchOrderId);
    const biz = (response.biz_content ?? {}) as Record<string, unknown>;
    const status = extractStatus(biz);
    const paid =
      String(response.result ?? '') === 'SUCCESS' &&
      String(response.code ?? '') === '0' &&
      isSuccessfulStatus(status);

    await telebirrAudit('reconcile_query', { orderNo, status, paid, response });

    if (!paid) return false;

    // Reconcile the amount before dispensing, exactly as the notify path does.
    const amount = Number(biz.total_amount ?? 0);
    if (amount && Math.abs(order.price - amount) > 0.01) {
      await telebirrAudit('reconcile_amount_mismatch', {
        orderNo,
        expected: order.price,
        received: amount,
      });
      return false;
    }

    const transactionId = String(
      biz.trans_id ?? biz.transId ?? biz.payment_order_id ?? order.merchOrderId
    );

    const fulfilled = await orderStore.markOrderPaidByTelebirr({
      orderNo: order.orderNo,
      transactionId,
      merchOrderId: order.merchOrderId,
    });

    await telebirrAudit(fulfilled ? 'reconcile_fulfilled' : 'reconcile_duplicate', {
      orderNo,
      transactionId,
    });
    return fulfilled;
  } catch (error) {
    // A failed check must never break the page that called it.
    await telebirrAudit('reconcile_failed', { orderNo, error: String(error) });
    return false;
  }
}

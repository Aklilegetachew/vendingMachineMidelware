/**
 * Order-scoped trace logging.
 *
 * Every line carries the order number, so one grep follows a single purchase
 * from the QR scan to the product dropping:
 *
 *   pm2 logs vending-middleware | grep ORD-1788376814629-9960
 *
 * The Telebirr audit log (telebirrAudit) already records full gateway requests
 * and responses. This is the thinner layer around it: the steps our own system
 * takes, and what it decided at each one.
 */

/** The stages an order passes through, in order. */
export type FlowStep =
  | 'scan'
  | 'order_created'
  | 'pay_requested'
  | 'preorder_ok'
  | 'handoff_to_app'
  | 'notify_received'
  | 'payment_confirmed'
  | 'vend_queued'
  | 'vend_dispatched'
  | 'vend_confirmed'
  | 'order_dispensed'
  | 'order_failed';

/**
 * One step of the flow.
 *
 * Never throws: a logging failure must not break a payment, and this sits on
 * the path of every order.
 */
export function logFlow(step: FlowStep, orderNo: string | null, data?: unknown): void {
  try {
    const detail = data === undefined ? '' : ' ' + JSON.stringify(data);
    const capped = detail.length > 1200 ? detail.slice(0, 1200) + '...(truncated)' : detail;
    console.log(`[flow] ${step} order=${orderNo ?? '-'}${capped}`);
  } catch {
    console.log(`[flow] ${step} order=${orderNo ?? '-'} <unserialisable>`);
  }
}

import { Request, Response } from 'express';
import { eventBroadcaster } from '../services/eventBroadcaster';
import { telebirrAudit } from '../services/telebirr';

/**
 * Bridge diagnostics.
 *
 * There is no devtools on a phone inside the telebirr SuperApp, so the page
 * cannot tell you what it found. This reports the environment back to the
 * server instead: it lands in the /workbench live feed and the audit log, so
 * you watch the result on a laptop while holding the phone.
 */
export const reportBridgeCheck = async (req: Request, res: Response): Promise<void> => {
  try {
    const report = {
      hasConsumerapp: Boolean(req.body?.hasConsumerapp),
      hasMa: Boolean(req.body?.hasMa),
      hasStartPay: Boolean(req.body?.hasStartPay),
      paymentPath: String(req.body?.paymentPath || 'unknown'),
      userAgent: String(req.body?.userAgent || req.headers['user-agent'] || ''),
      href: String(req.body?.href || ''),
      globals: Array.isArray(req.body?.globals) ? req.body.globals.slice(0, 40) : [],
      ip: req.ip,
      at: new Date().toISOString(),
    };

    await telebirrAudit('bridge_check', report);
    eventBroadcaster.broadcast('BRIDGE_CHECK', report);

    res.status(200).json({ success: true, received: report });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/** GET /pay/bridge-check - the page you open on the phone. */
export const renderBridgeCheck = async (_req: Request, res: Response): Promise<void> => {
  res.render('bridge-check', { title: 'Bridge check' });
};

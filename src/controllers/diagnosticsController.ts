import { Request, Response } from 'express';
import { eventBroadcaster } from '../services/eventBroadcaster';
import { prisma } from '../lib/prisma';
import * as vendQueue from '../services/vendQueue';
import * as machineInventory from '../services/machineInventory';
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

/**
 * GET /api/diagnostics/telebirr-log
 *
 * Recent entries from the Telebirr audit trail. This is how you see what the
 * gateway actually sent, rather than what we hoped it sent.
 *
 * Guarded by DASHBOARD_KEY because the entries contain transaction ids and
 * payment payloads.
 */
export const getTelebirrLog = async (req: Request, res: Response): Promise<void> => {
  if (!dashboardAllowed(req, res)) return;

  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const channel = req.query.channel ? String(req.query.channel) : null;

    const rows = await prisma.trafficLog.findMany({
      where: channel
        ? { endpoint: `telebirr:${channel}` }
        : { endpoint: { startsWith: 'telebirr:' } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.status(200).json({
      success: true,
      count: rows.length,
      entries: rows.map((r) => ({
        at: r.createdAt,
        channel: r.endpoint.replace(/^telebirr:/, ''),
        body: safeParse(r.body),
      })),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Shared guard. When DASHBOARD_KEY is set a matching `key` is required; the
 * data includes payment details, so it should not be world readable.
 */
export function dashboardAllowed(req: Request, res: Response): boolean {
  const expected = process.env.DASHBOARD_KEY;
  if (!expected) return true; // not configured: open, same as /workbench

  const given = String(req.query.key || req.headers['x-dashboard-key'] || '');
  if (given === expected) return true;

  res.status(404).json({ success: false, message: 'Not found' });
  return false;
};

/** GET /api/diagnostics/orders - orders grouped by how far they got. */
export const getOrderDashboardData = async (req: Request, res: Response): Promise<void> => {
  if (!dashboardAllowed(req, res)) return;

  try {
    const orders = await prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(req.query.limit) || 100, 500),
    });

    res.status(200).json({
      success: true,
      counts: orders.reduce((acc: Record<string, number>, o) => {
        acc[o.status] = (acc[o.status] || 0) + 1;
        return acc;
      }, {}),
      orders,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/** GET /dashboard - orders and the Telebirr audit trail in one page. */
export const renderDashboard = async (req: Request, res: Response): Promise<void> => {
  if (!dashboardAllowed(req, res)) return;
  res.render('dashboard');
};

/** GET /api/vend-queue - what is waiting for each machine, and what is in flight. */
export const getVendQueue = async (req: Request, res: Response): Promise<void> => {
  if (!dashboardAllowed(req, res)) return;
  res.status(200).json({ success: true, ...vendQueue.inspect() });
};

/**
 * GET /api/machine-inventory?machineId=...&all=1
 *
 * Current slot state as the machine last reported it. Slots with status 255 are
 * hidden unless `all=1`: those positions are not fitted and report sentinel
 * values (price 6553.5, stock 199) that read as real products otherwise.
 */
export const getMachineInventory = async (req: Request, res: Response): Promise<void> => {
  if (!dashboardAllowed(req, res)) return;

  const machineId = String(req.query.machineId ?? machineInventory.machineIds()[0] ?? '');
  const showAll = req.query.all === '1';
  const slots = machineInventory.slots(machineId, !showAll);

  res.status(200).json({
    success: true,
    machineId,
    knownMachines: machineInventory.machineIds(),
    counts: {
      slots: slots.length,
      stocked: slots.filter((s) => s.stock > 0).length,
      empty: slots.filter((s) => s.stock === 0).length,
    },
    slots,
  });
};

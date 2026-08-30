import { TelebirrClient } from './client';
import { loadTelebirrConfig, telebirrEnabled } from '../../config/telebirr';
import { prisma } from '../../lib/prisma';

export * from './client';

/**
 * Append-only audit trail for everything the gateway tells us.
 *
 * Written to TrafficLog because when a payment is disputed this is the only
 * evidence, and it must survive a failure anywhere later in the pipeline -
 * hence the swallowed error.
 */
export async function telebirrAudit(channel: string, context?: unknown): Promise<void> {
  // Print to stdout as well as the database, so `pm2 logs` shows what Telebirr
  // actually replied without needing to query TrafficLog.
  try {
    const text = context === undefined ? '' : JSON.stringify(context);
    console.log(
      `[telebirr] ${channel} ${text.length > 1500 ? text.slice(0, 1500) + '...(truncated)' : text}`
    );
  } catch {
    console.log(`[telebirr] ${channel} <unserialisable context>`);
  }

  try {
    await prisma.trafficLog.create({
      data: {
        endpoint: `telebirr:${channel}`,
        method: 'INTERNAL',
        body: context === undefined ? null : JSON.stringify(context).slice(0, 8000),
      },
    });
  } catch (error) {
    // Never let audit logging break payment processing.
    console.error('[telebirr] audit log write failed', error);
  }
}

let client: TelebirrClient | null = null;

/**
 * Lazily built so the app still boots (and the QR / vending routes still work)
 * when Telebirr credentials are absent. Throws with the full list of missing
 * variables the first time a payment is actually attempted.
 */
export function getTelebirrClient(): TelebirrClient {
  if (!client) {
    client = new TelebirrClient({ ...loadTelebirrConfig(), log: telebirrAudit });
  }
  return client;
}

export { telebirrEnabled };

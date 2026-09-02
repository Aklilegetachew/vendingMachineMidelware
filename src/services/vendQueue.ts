/**
 * Pending dispense commands, held per machine.
 *
 * The machine polls `POST /vend` with FunCode 4000 roughly every 3 seconds and
 * takes at most one command per poll. This holds what is waiting for it.
 *
 * In memory on purpose (no Redis): a dispense command must NOT survive a
 * restart. Reviving one after a crash would drop product for an order that was
 * already settled by hand, and there is no way to tell from the queue alone.
 * A payment that is lost this way is recoverable from the database; a spurious
 * dispense is not recoverable at all.
 */

export interface VendCommand {
  TradeNo: string;
  SlotNo: string;
  Amount: string;
  PayType: '3';
  timestamp: number;
  /** Our own order number, for mapping the FunCode 5000 confirmation home. */
  orderNo: string;
}

export interface InFlightCommand extends VendCommand {
  machineId: string;
  dispatchedAt: number;
}

/** machineId -> commands waiting to be collected. */
const queues = new Map<string, VendCommand[]>();

/** TradeNo -> command already handed to a machine, awaiting its FunCode 5000. */
const inFlight = new Map<string, InFlightCommand>();

/** A command not collected within this window is stale and gets dropped. */
export const QUEUE_TTL_MS = 60_000;

/** How long a dispatched command stays matchable to a confirmation. */
const IN_FLIGHT_TTL_MS = 10 * 60_000;

export function enqueue(machineId: string, command: VendCommand): void {
  const queue = queues.get(machineId) ?? [];

  // Never queue the same order twice: a redelivered notify or a reconcile
  // running alongside the callback would otherwise dispense twice.
  if (queue.some((c) => c.orderNo === command.orderNo)) return;
  if (inFlight.has(command.TradeNo)) return;

  queue.push(command);
  queues.set(machineId, queue);
}

/**
 * Take the next command for a machine, discarding anything that has expired.
 *
 * Expiry matters: if the machine was offline when the payment landed, dropping
 * product minutes later when nobody is standing there is worse than not
 * dispensing at all. An expired command is returned so the caller can record it.
 */
export function dequeue(machineId: string): {
  command: VendCommand | null;
  expired: VendCommand[];
} {
  const queue = queues.get(machineId) ?? [];
  const expired: VendCommand[] = [];
  const now = Date.now();

  while (queue.length > 0) {
    const next = queue.shift() as VendCommand;

    if (now - next.timestamp > QUEUE_TTL_MS) {
      expired.push(next);
      continue;
    }

    queues.set(machineId, queue);
    inFlight.set(next.TradeNo, { ...next, machineId, dispatchedAt: now });
    return { command: next, expired };
  }

  queues.set(machineId, queue);
  return { command: null, expired };
}

/** Match a FunCode 5000 confirmation back to the command that caused it. */
export function takeInFlight(tradeNo: string): InFlightCommand | null {
  const found = inFlight.get(tradeNo);
  if (!found) return null;

  inFlight.delete(tradeNo);
  return found;
}

/** Drop dispatched commands the machine never confirmed, so the map cannot grow. */
export function pruneInFlight(): InFlightCommand[] {
  const now = Date.now();
  const dropped: InFlightCommand[] = [];

  for (const [tradeNo, command] of inFlight) {
    if (now - command.dispatchedAt > IN_FLIGHT_TTL_MS) {
      inFlight.delete(tradeNo);
      dropped.push(command);
    }
  }

  return dropped;
}

/** Read only view, for the dashboard and diagnostics. */
export function inspect(): {
  queued: Record<string, VendCommand[]>;
  inFlight: InFlightCommand[];
} {
  return {
    queued: Object.fromEntries(queues),
    inFlight: [...inFlight.values()],
  };
}

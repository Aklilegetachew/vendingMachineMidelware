/**
 * Live slot inventory, as reported by the machine.
 *
 * The machine broadcasts one slot per FunCode 1000 message, cycling through
 * every slot roughly once a minute. Keeping the latest report per slot gives a
 * current picture of what is loaded and at what price, without asking it
 * anything.
 *
 * In memory: it is a cache of something the machine re-sends continuously, so
 * losing it on restart costs nothing more than a minute of waiting.
 */

export interface SlotState {
  slotNo: number;
  productId: string;
  name: string;
  price: string;
  stock: number;
  capacity: number;
  /** "0" = slot enabled. "255" = not fitted or disabled. */
  status: string;
  updatedAt: string;
}

const machines = new Map<string, Map<number, SlotState>>();

/** Record one FunCode 1000 report. Returns the slot, or null if unparseable. */
export function record(
  machineId: string,
  body: Record<string, string>
): SlotState | null {
  const slotNo = Number(body.SlotNo);
  if (!machineId || !Number.isFinite(slotNo)) return null;

  const slots = machines.get(machineId) ?? new Map<number, SlotState>();

  const state: SlotState = {
    slotNo,
    productId: String(body.ProductID ?? ''),
    name: String(body.Name ?? '').trim(),
    price: String(body.Price ?? ''),
    stock: Number(body.Stock ?? body.Quantity ?? 0),
    capacity: Number(body.Capacity ?? 0),
    status: String(body.Status ?? ''),
    updatedAt: new Date().toISOString(),
  };

  slots.set(slotNo, state);
  machines.set(machineId, slots);
  return state;
}

/**
 * Slots for a machine, lowest first.
 *
 * `configured` filters out the ones reporting status 255, which the machine
 * sends for positions that are not fitted. Those carry sentinel values
 * (price 6553.5, stock 199) that would otherwise look like real products.
 */
export function slots(machineId: string, configuredOnly = false): SlotState[] {
  const all = [...(machines.get(machineId)?.values() ?? [])];
  const filtered = configuredOnly ? all.filter((s) => s.status !== '255') : all;
  return filtered.sort((a, b) => a.slotNo - b.slotNo);
}

export function machineIds(): string[] {
  return [...machines.keys()];
}

/** One slot's latest state, for checking stock before or after a dispense. */
export function slot(machineId: string, slotNo: number): SlotState | null {
  return machines.get(machineId)?.get(slotNo) ?? null;
}

/**
 * Machine telemetry, carried on some FunCode 4000 polls.
 *
 * Observed fields: Tmp (cabinet temperature), Ntw (network state), DpSen (drop
 * sensor). DpSen matters for dispensing: a machine that believes it has no
 * working drop sensor may refuse to run the motor, or may never report a
 * completion.
 */
export interface MachineHealth {
  machineId: string;
  temperature: string | null;
  network: string | null;
  dropSensor: string | null;
  updatedAt: string;
}

const health = new Map<string, MachineHealth>();

/** Record telemetry if this poll carried any. Returns it when something changed. */
export function recordHealth(
  machineId: string,
  body: Record<string, string>
): MachineHealth | null {
  if (!machineId) return null;
  if (body.Tmp === undefined && body.Ntw === undefined && body.DpSen === undefined) {
    return null;
  }

  const state: MachineHealth = {
    machineId,
    temperature: body.Tmp ?? null,
    network: body.Ntw ?? null,
    dropSensor: body.DpSen ?? null,
    updatedAt: new Date().toISOString(),
  };

  health.set(machineId, state);
  return state;
}

export function getHealth(machineId: string): MachineHealth | null {
  return health.get(machineId) ?? null;
}

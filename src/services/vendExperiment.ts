/**
 * Dispense experiment harness.
 *
 * The machine's protocol is undocumented, so the response that triggers a
 * dispense has to be found by trial. This keeps the guessing cheap and safe:
 *
 *  - the response shape is editable at runtime, no redeploy per attempt
 *  - a dispense can be "armed" without a real payment, so experiments cost
 *    inventory but not money
 *  - every message the machine sends afterwards is captured, so you can tell
 *    whether a shape did anything
 *
 * State is in memory on purpose: an experiment must not survive a restart and
 * silently dispense later.
 */

export interface VendCandidate {
  name: string;
  contentType: 'json' | 'form';
  /** Placeholders: {{slotNo}} {{machineId}} {{tradeNo}} {{quantity}} {{amount}} */
  template: string;
}

/**
 * Ordered by how likely they look given the observed traffic. The machine
 * sends FunCode 1000/4000/5000 as form-encoded TitleCase, so a reply in the
 * same dialect is the first thing to try.
 */
export const CANDIDATES: VendCandidate[] = [
  {
    name: 'echo-4000-json',
    contentType: 'json',
    template:
      '{"FunCode":"4000","MachineID":"{{machineId}}","SlotNo":"{{slotNo}}","TradeNo":"{{tradeNo}}","Quantity":"1","Status":"0"}',
  },
  {
    name: 'funcode-2000-json',
    contentType: 'json',
    template:
      '{"FunCode":"2000","MachineID":"{{machineId}}","SlotNo":"{{slotNo}}","TradeNo":"{{tradeNo}}","Quantity":"1","Status":"0"}',
  },
  {
    name: 'funcode-3000-json',
    contentType: 'json',
    template:
      '{"FunCode":"3000","MachineID":"{{machineId}}","SlotNo":"{{slotNo}}","TradeNo":"{{tradeNo}}","Quantity":"1","Status":"0"}',
  },
  {
    name: 'echo-4000-form',
    contentType: 'form',
    template:
      'FunCode=4000&MachineID={{machineId}}&SlotNo={{slotNo}}&TradeNo={{tradeNo}}&Quantity=1&Status=0',
  },
  {
    name: 'funcode-2000-form',
    contentType: 'form',
    template:
      'FunCode=2000&MachineID={{machineId}}&SlotNo={{slotNo}}&TradeNo={{tradeNo}}&Quantity=1&Status=0',
  },
  {
    name: 'legacy-vend-json',
    contentType: 'json',
    template: '{"code":0,"status":"SUCCESS","paid":true,"action":"VEND","slotNo":{{slotNo}}}',
  },
];

interface ArmedDispense {
  slotNo: string;
  machineId: string;
  orderNo: string | null;
  candidate: VendCandidate;
  armedAt: number;
  servedAt: number | null;
  /** Machine messages seen after the command was served. */
  followUp: unknown[];
}

let armed: ArmedDispense | null = null;

/** Arm a dispense to be served on the next matching poll. */
export function arm(params: {
  slotNo: string;
  machineId: string;
  orderNo?: string | null;
  candidateName?: string;
}): ArmedDispense {
  const candidate =
    CANDIDATES.find((c) => c.name === params.candidateName) ?? CANDIDATES[0];

  armed = {
    slotNo: params.slotNo,
    machineId: params.machineId,
    orderNo: params.orderNo ?? null,
    candidate,
    armedAt: Date.now(),
    servedAt: null,
    followUp: [],
  };
  return armed;
}

export function disarm(): void {
  armed = null;
}

export function current(): ArmedDispense | null {
  return armed;
}

/**
 * The response body for an armed dispense, or null when nothing is armed.
 * Marks it served so it fires once, never on a loop.
 */
export function takeResponse(
  machineId: string
): { body: string; contentType: string; candidate: string; slotNo: string } | null {
  if (!armed || armed.servedAt) return null;
  if (armed.machineId && machineId && armed.machineId !== machineId) return null;

  const tradeNo = String(Date.now());
  const body = armed.candidate.template
    .replace(/\{\{slotNo\}\}/g, armed.slotNo)
    .replace(/\{\{machineId\}\}/g, armed.machineId)
    .replace(/\{\{tradeNo\}\}/g, tradeNo)
    .replace(/\{\{quantity\}\}/g, '1')
    .replace(/\{\{amount\}\}/g, '0.00');

  armed.servedAt = Date.now();

  return {
    body,
    contentType:
      armed.candidate.contentType === 'json'
        ? 'application/json'
        : 'application/x-www-form-urlencoded',
    candidate: armed.candidate.name,
    slotNo: armed.slotNo,
  };
}

/**
 * True for a short window after a command was served.
 *
 * While an experiment is settling, the normal vend path must stay quiet:
 * otherwise the machine receives the candidate shape and then the legacy shape
 * a second later, and the outcome cannot be attributed to either.
 */
export function isSettling(windowMs = 60_000): boolean {
  return Boolean(armed?.servedAt && Date.now() - armed.servedAt < windowMs);
}

/** Record what the machine said after a command, up to a small cap. */
export function recordFollowUp(message: unknown): void {
  if (!armed?.servedAt) return;
  if (armed.followUp.length >= 40) return;
  armed.followUp.push({ at: new Date().toISOString(), message });
}

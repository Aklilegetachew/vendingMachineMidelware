/**
 * Acknowledgement format probe for the machine's FunCode 5000 records.
 *
 * The machine retransmits an undelivered transaction record roughly every 30
 * seconds, with an identical TradeNo, until it is satisfied with our reply.
 * That retry is the only feedback channel the machine gives us: a dispense that
 * is ignored produces silence, but a rejected acknowledgement produces another
 * request.
 *
 * So each retransmit of the same TradeNo gets the NEXT candidate format. When
 * the retransmits stop, the variant named in the last log line is the one the
 * machine accepted, and that envelope is very likely what a dispense reply
 * needs too.
 *
 * Pin the winner with VEND_ACK_VARIANT=<name>, then turn the probe off.
 */

import { ackProbeEnabled, pinnedAckVariant } from '../config/vend';

export interface AckContext {
  tradeNo: string;
  funCode: string;
  body: Record<string, string>;
}

export interface AckVariant {
  name: string;
  /** json sends an object; text sends a bare string body. */
  kind: 'json' | 'text';
  build: (ctx: AckContext) => unknown;
}

/**
 * Ordered most-likely-first, so a machine that gives up after a few retries
 * still gets the strongest candidates.
 */
export const VARIANTS: AckVariant[] = [
  {
    // Echoing FunCode is the commonest convention in this family of
    // controllers: the reply is matched to the request by function code.
    name: 'echo-funcode',
    kind: 'json',
    build: ({ funCode, tradeNo }) => ({
      FunCode: funCode,
      Code: '0',
      Msg: 'SUCCESS',
      TradeNo: tradeNo,
    }),
  },
  {
    // What we have been sending all along, kept in the rotation as the control.
    name: 'both-casings',
    kind: 'json',
    build: ({ tradeNo }) => ({
      Code: '0',
      Msg: 'SUCCESS',
      code: 0,
      msg: 'success',
      TradeNo: tradeNo,
      tradeNo,
    }),
  },
  {
    name: 'int-code',
    kind: 'json',
    build: ({ tradeNo }) => ({ Code: 0, Msg: 'SUCCESS', TradeNo: tradeNo }),
  },
  {
    // Mirrors the idle reply, which the machine has never complained about.
    name: 'code-msg-data',
    kind: 'json',
    build: ({ tradeNo }) => ({ Code: '0', Msg: 'SUCCESS', Data: '', TradeNo: tradeNo }),
  },
  {
    // Full echo: hand back everything it sent, stamped with a result.
    name: 'echo-body',
    kind: 'json',
    build: ({ body }) => ({ ...body, Code: '0', Msg: 'SUCCESS' }),
  },
  {
    name: 'result-field',
    kind: 'json',
    build: ({ tradeNo }) => ({ Result: '0', Code: '0', Msg: 'SUCCESS', TradeNo: tradeNo }),
  },
  {
    name: 'lower-only',
    kind: 'json',
    build: ({ tradeNo }) => ({ code: 0, msg: 'success', tradeNo }),
  },
  {
    // Some firmware checks the body as a string, not as a document.
    name: 'plaintext-success',
    kind: 'text',
    build: () => 'success',
  },
  {
    name: 'plaintext-ok',
    kind: 'text',
    build: () => 'OK',
  },
];

/** How many times each TradeNo has been seen, so a retry advances the format. */
const attempts = new Map<string, number>();

export interface AckChoice {
  variant: AckVariant;
  /** 1 on the first sighting of this TradeNo, 2 on the first retransmit, ... */
  attempt: number;
  payload: unknown;
}

export function nextAck(ctx: AckContext): AckChoice {
  const key = ctx.tradeNo || `${ctx.funCode}:no-trade-no`;
  const attempt = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, attempt);

  const pinned = pinnedAckVariant();
  const variant = pinned
    ? VARIANTS.find((v) => v.name === pinned) ?? VARIANTS[0]
    : ackProbeEnabled()
      ? // Wrap around rather than stopping: a machine that retries for a long
        // time then gets a second pass, which distinguishes a real acceptance
        // from the machine simply giving up.
        VARIANTS[(attempt - 1) % VARIANTS.length]
      : VARIANTS[1];

  return { variant, attempt, payload: variant.build(ctx) };
}

/** Clears the counters, so a fresh experiment starts from the first variant. */
export function reset(): void {
  attempts.clear();
}

export function attemptCounts(): Record<string, number> {
  return Object.fromEntries(attempts);
}

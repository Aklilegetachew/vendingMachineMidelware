/**
 * Vend channel settings.
 *
 * The machine's acknowledgement dialect is not documented anywhere we have, so
 * it is discovered by experiment. These two switches drive that: the probe
 * cycles candidate formats, and once one works it gets pinned by name.
 */

/** Cycle a different ack format on each retransmit. Off once a format is pinned. */
export const ackProbeEnabled = (): boolean =>
  (process.env.VEND_ACK_PROBE ?? 'true').toLowerCase() === 'true';

/** Always answer with this variant by name. Overrides the probe. */
export const pinnedAckVariant = (): string | null =>
  process.env.VEND_ACK_VARIANT?.trim() || null;

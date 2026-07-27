/**
 * zod schemas for every input this service accepts.
 *
 * All bodies are `strictBody` — an unexpected key is a 400, not a silently
 * ignored field. That matters here more than anywhere: the legacy endpoints
 * accepted `{ wallet, playerID, winner, amount }` and trusted them.
 */
import { strictBody, z } from '../platform/shared.js';

/** A 32-byte EVM transaction hash. Lower-cased so comparisons are total. */
export const txHashSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed transaction hash')
  .transform((v) => v.toLowerCase());

export const createEscrowBody = strictBody({
  matchId: z.string().trim().min(1).max(128),
  /**
   * A TIER INDEX, not an amount. The server owns the amount policy; there is
   * deliberately no `amount` field for anything to trust.
   */
  tier: z.number().int().min(0).max(64),
});

export const depositBody = strictBody({ txHash: txHashSchema });

export const escrowParams = z.object({ id: z.string().uuid() });

export const voidBody = strictBody({
  reason: z.string().trim().min(8, 'a reason of at least 8 characters is required').max(500),
});

export const confirmBody = strictBody({ paymentTxHash: txHashSchema });

export const ticketParams = z.object({
  ticketNumber: z.coerce.number().int().positive().max(1_000_000),
});

export const shippingAddress = strictBody({
  fullName: z.string().trim().min(1).max(120),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(120),
  region: z.string().trim().min(1).max(120),
  postalCode: z.string().trim().min(1).max(32),
  country: z.string().trim().min(2).max(64),
  email: z.string().trim().email().max(200).optional(),
});

export const redeemDigitalBody = strictBody({});
export const redeemShippedBody = strictBody({ address: shippingAddress });
export const emptyBody = strictBody({});

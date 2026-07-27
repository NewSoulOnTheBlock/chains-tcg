/**
 * Digital pack contents.
 *
 * Deterministic in (ticketNumber, packIndex, position) via HMAC, for two
 * reasons: a redemption retry after a network blip yields the same cards rather
 * than re-rolling for a better result, and the outcome is reproducible for
 * support. The legacy version used `Math.random()` inside the request handler.
 */
import { createHmac } from 'node:crypto';

export const PACKS_PER_TICKET = 3;
export const CARDS_PER_PACK = 10;

export function rollPack(args: {
  pool: readonly string[];
  ticketNumber: number;
  packIndex: number;
  secret: string;
  size?: number;
}): string[] {
  const size = args.size ?? CARDS_PER_PACK;
  if (args.pool.length === 0) throw new Error('card pool is empty');
  const picks: string[] = [];
  for (let i = 0; i < size; i += 1) {
    const digest = createHmac('sha256', args.secret)
      .update(`pack:${args.ticketNumber}:${args.packIndex}:${i}`, 'utf8')
      .digest();
    const n = digest.readUInt32BE(0);
    picks.push(args.pool[n % args.pool.length]!);
  }
  return picks;
}

export function rollTicketCards(args: {
  pool: readonly string[];
  ticketNumber: number;
  secret: string;
}): string[] {
  const out: string[] = [];
  for (let p = 0; p < PACKS_PER_TICKET; p += 1) {
    out.push(...rollPack({ pool: args.pool, ticketNumber: args.ticketNumber, packIndex: p, secret: args.secret }));
  }
  return out;
}

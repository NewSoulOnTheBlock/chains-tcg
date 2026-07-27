/**
 * Seats.
 *
 * A seat is never a request field. It is looked up from `game.matches`
 * (`seat0_profile` / `seat1_profile`) for the authenticated profile, so the only
 * way to fund seat 1 is to *be* seat 1.
 */
export type Seat = 0 | 1;

export function isSeat(value: unknown): value is Seat {
  return value === 0 || value === 1;
}

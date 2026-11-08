// src/api/guards.ts
//
// Hand-written runtime guards for the money- and match-critical response
// shapes, used as the `parse` validator on `request()` (see http.ts).
//
// WHY, AND HOW FAR TO GO
//
// Every other response is still an unchecked `JSON.parse(...) as T`, which is
// fine for cosmetic reads: a drifted leaderboard row renders slightly wrong,
// not dangerously. These routes are different — a caller destructures their
// result immediately (`const { escrow } = ...`, `const { matches } = ...`) and
// a missing field there is a `TypeError` far from the fetch, or worse, a
// money/seat decision made on `undefined`. So we validate the fields the code
// actually reads and are deliberately LENIENT about everything else: unknown
// extra keys pass, and a guard only fails when a load-bearing field is the
// wrong type. A guard that is stricter than the server would turn an additive
// backend change into an `invalid_response` outage.
//
// No new dependency — these are a dozen lines of `typeof` checks, not zod.

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/**
 * Turn a structural predicate into a `parse` validator for `request<T>`.
 *
 * The caller names `T` (so the literal-union fields like `status: MatchStatus`
 * keep their precise type); the predicate is the runtime check. On a mismatch
 * it throws, which `request()` turns into `ApiError{code:'invalid_response'}`.
 */
export function guardAs<T>(name: string, ok: (v: unknown) => boolean): (raw: unknown) => T {
  return (raw: unknown): T => {
    if (!ok(raw)) throw new Error(`response did not match ${name}`);
    return raw as T;
  };
}

/** Predicate for a `{ [key]: unknown[] }` wrapper (lobby, invites, history). */
export const hasArray = (key: string) => (v: unknown): boolean => isObj(v) && Array.isArray(v[key]);

// ── lobby / match ─────────────────────────────────────────────────────────

export const isCreatedMatch = (v: unknown): boolean =>
  isObj(v) && isStr(v.matchID) && isStr(v.status) && isStr(v.mode) && v.seat === 0;

export const isJoinedMatch = (v: unknown): boolean =>
  isObj(v) && isStr(v.matchID) && v.seat === 1 && isStr(v.playerID) && isStr(v.credentials);

export const isSeatInfo = (v: unknown): boolean =>
  isObj(v) &&
  isStr(v.matchID) &&
  (v.seat === 0 || v.seat === 1) &&
  isStr(v.status) &&
  (v.credentials === null || isStr(v.credentials));

// ── wager / money ───────────────────────────────────────────────────────────

function isEscrowShape(v: unknown): boolean {
  return (
    isObj(v) &&
    isStr(v.id) &&
    isStr(v.matchId) &&
    isStr(v.amountBase) &&
    isStr(v.token) &&
    isNum(v.decimals) &&
    isStr(v.status) &&
    isStr(v.depositAddress) &&
    Array.isArray(v.seats)
  );
}

/** `{ escrow: Escrow }` — the money shape the UI reads a deposit address off. */
export const isWrappedEscrow = (v: unknown): boolean => isObj(v) && isEscrowShape(v.escrow);

export const isStakes = (v: unknown): boolean =>
  isObj(v) && Array.isArray(v.tiers) && isStr(v.token) && isNum(v.decimals);

export const isDepositResult = (v: unknown): boolean =>
  isObj(v) && v.accepted === true && (v.seat === 0 || v.seat === 1) && isStr(v.escrowStatus) && isBool(v.bothSeatsFunded);

// ── ranked ──────────────────────────────────────────────────────────────────

/**
 * `/games/ranked/me` is already known to come back in two shapes (wrapped in
 * `{ profile }` or flat), so the guard only insists that ONE of them carries a
 * `profileId` string — the single field every caller reads.
 */
export const isRankedMe = (v: unknown): boolean => {
  if (!isObj(v)) return false;
  const flat = isStr(v.profileId);
  const wrapped = isObj(v.profile) && isStr(v.profile.profileId);
  return flat || wrapped;
};

export const isQueueTicket = (v: unknown): boolean =>
  isObj(v) && v.queued === true && isStr(v.seasonId) && isStr(v.region) && isNum(v.queueDepth);

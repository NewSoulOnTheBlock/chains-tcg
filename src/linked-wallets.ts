// src/linked-wallets.ts
//
// The copy and the pure logic behind the linked-wallets screen.
//
// Same rule as `src/error-text.ts`: never show a player a raw server string.
// Every refusal the address routes can produce is a specific situation with a
// specific next action, and "conflict" is not one of them.
//
// ─── WHERE THE CAUSE LIVES ──────────────────────────────────────────────────
//
// `src/api/errors.ts` documents `error.code` as a CLOSED transport enum
// (`conflict`, `forbidden`, `unavailable`, …) with the domain cause travelling
// in `details.reason`. The address routes are specified to us as
// "409 address_linked_elsewhere", which does not say which field carries
// `address_linked_elsewhere`.
//
// Rather than guess, `addressFailureReason()` reads BOTH and prefers
// `details.reason`. If the backend puts it in `code`, we still match; if it
// puts it in `details.reason` like every other service, we still match; and if
// it ever moves, nothing here breaks. This is flagged as an ambiguity in the
// handover rather than silently coded around.

import { ApiError } from './api';
import { errorText } from './error-text';

/** Which action produced the failure. The same reason reads differently. */
export type AddressAction = 'link' | 'primary' | 'unlink';

/** Machine-readable causes the address routes can return. */
export type AddressFailure =
  | 'address_relink_cooldown'
  | 'address_linked_elsewhere'
  | 'address_already_linked'
  | 'primary_address'
  | 'last_address'
  | 'chain_unreachable'
  | 'chain_id_mismatch'
  | 'chain_call_failed'
  | (string & {});

/**
 * The domain cause, from `details.reason` if present, else from `code`.
 *
 * The `code` fallback deliberately ignores the twelve generic transport values
 * — matching on `'conflict'` would make every 409 look like a named failure.
 */
const TRANSPORT_CODES = new Set([
  'bad_request', 'unauthorized', 'forbidden', 'not_found', 'method_not_allowed',
  'conflict', 'payload_too_large', 'unsupported_media_type', 'unprocessable',
  'rate_limited', 'internal', 'unavailable',
  'network_error', 'aborted', 'invalid_response', 'session_expired', 'http_error',
]);

export function addressFailureReason(err: unknown): AddressFailure | null {
  if (!(err instanceof ApiError)) return null;
  if (err.reason !== null) return err.reason;
  return TRANSPORT_CODES.has(err.code) ? null : err.code;
}

/**
 * `details.eligibleAt` from a `address_relink_cooldown` — when the wallet can
 * be linked again. `null` if the server did not send a parseable date, in
 * which case the copy has to stay vague rather than invent a day.
 */
export function relinkEligibleAt(err: unknown): Date | null {
  if (!(err instanceof ApiError)) return null;
  const raw = err.details.eligibleAt;
  if (typeof raw !== 'string') return null;
  const when = new Date(raw);
  return Number.isNaN(when.getTime()) ? null : when;
}

/**
 * A date a player can read, in their own locale, with no time of day — the
 * cooldown is measured in days and a minute-precise timestamp implies a
 * precision the rule does not have.
 */
export function formatEligibleDate(when: Date): string {
  try {
    return when.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return when.toISOString().slice(0, 10);
  }
}

/**
 * The three `503`s that mean OUR verification path is down, not that the
 * player's wallet is broken.
 *
 * These are reachable for SMART ACCOUNTS ONLY. A smart account's signature is
 * validated on chain (ERC-1271, or ERC-6492 while the account is still
 * counterfactual), so the server has to make a chain call to check it; if that
 * call fails, this is what comes back. An ordinary wallet signature is a local
 * `secp256k1` recovery and makes no chain call at all, so a browser-wallet user
 * can never see one of these.
 *
 * The copy has to say that, because "could not verify your wallet" reads as
 * "your wallet is bad" and sends the player off to debug something that is
 * working perfectly.
 */
export function isChainVerificationFailure(err: unknown): boolean {
  const reason = addressFailureReason(err);
  return reason === 'chain_unreachable' || reason === 'chain_id_mismatch' || reason === 'chain_call_failed';
}

/**
 * `409 primary_address` on an unlink: they are removing the primary while other
 * wallets remain. The fix is to promote one of the others first, so the UI
 * offers exactly that instead of just refusing.
 */
export function needsPromoteFirst(err: unknown): boolean {
  return addressFailureReason(err) === 'primary_address';
}

/**
 * Player-facing copy for a linked-wallets failure.
 *
 * Falls through to `errorText()` — which already handles network failures,
 * rate limits and expired sessions — for anything not named here.
 */
export function linkedWalletErrorText(err: unknown, action: AddressAction): string {
  const reason = addressFailureReason(err);

  switch (reason) {
    case 'address_relink_cooldown': {
      const when = relinkEligibleAt(err);
      // Deliberately vague about WHOSE profile it left. Naming it would let
      // anyone probe which wallets belong to which player.
      return when
        ? `This wallet was recently unlinked from another profile. It can be linked again on ${formatEligibleDate(when)}.`
        : 'This wallet was recently unlinked from another profile and is on a 30-day cooldown. Try again later.';
    }

    case 'address_linked_elsewhere':
      // The server does not say whose profile holds it, and neither do we —
      // implying we know, or that it is recoverable by asking someone, would
      // both be false.
      return 'This wallet is already linked to another profile, so it cannot be added here.';

    case 'address_already_linked':
      return 'This wallet is already on your profile.';

    case 'primary_address':
      return unlinkBlockedText('primary_address');

    case 'last_address':
      return unlinkBlockedText('last_address');

    case 'chain_unreachable':
    case 'chain_id_mismatch':
    case 'chain_call_failed':
      // OUR problem, said plainly. Smart accounts only — see the note above.
      return action === 'link'
        ? 'We could not check this smart account on Robinhood Chain just now — that is on our side, not your wallet. Nothing has changed. Try again in a moment.'
        : 'Robinhood Chain could not be reached to complete that — that is on our side. Nothing has changed. Try again in a moment.';

    default:
      break;
  }

  return errorText(err);
}

/**
 * The copy for the two unlink refusals the CLIENT can predict
 * (`unlinkBlockedReason()` below). One source for both moments: the UI quotes
 * this before the press, and `linkedWalletErrorText()` quotes the same words
 * if the server refuses anyway — two phrasings of one rule would read as two
 * rules.
 */
export function unlinkBlockedText(reason: 'last_address' | 'primary_address'): string {
  return reason === 'last_address'
    ? 'This is the only wallet on your profile. A profile must always keep one — link another before removing this.'
    : 'This is your primary wallet. Make another wallet primary first, then you can unlink this one.';
}

/**
 * What unlinking actually costs, as bullet points for the confirmation dialog.
 *
 * Written as consequences rather than warnings: the deletion is a database
 * trigger, so none of it is conditional or recoverable by retrying.
 */
export const UNLINK_CONSEQUENCES: readonly string[] = [
  'your scanned card collection is deleted — every card, not just this wallet’s;',
  'your profile goes back to “not scanned yet”, and you must press SCAN CHAIN again to re-prove what you hold;',
  'any card held only by this wallet will be gone from your collection;',
  'decks that used those cards stay saved, but will not be legal for ranked until you own the cards again.',
] as const;

/** One line summarising the same, for the row's helper text. */
export const UNLINK_SHORT_WARNING =
  'Unlinking deletes your scanned collection and you will need to SCAN CHAIN again.';

/**
 * Primary first, then oldest link first.
 *
 * The server already returns the list in this order; this exists so a list the
 * UI has updated optimistically (a link appended, a promotion applied) renders
 * in the same order as the next fetch will, instead of jumping.
 */
export function sortLinkedAddresses<T extends { isPrimary: boolean; linkedAt: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    const at = Date.parse(a.linkedAt);
    const bt = Date.parse(b.linkedAt);
    if (Number.isNaN(at) || Number.isNaN(bt)) return 0;
    return at - bt;
  });
}

/** Case-insensitive address comparison. EVM addresses are not case-sensitive. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** How an address kind reads in the UI. */
export function walletKindLabel(kind: 'eoa' | 'smart'): string {
  return kind === 'smart' ? 'Smart account' : 'Browser wallet';
}

/**
 * "Linked 3 March 2026", or `null` when the timestamp is unusable — a row with
 * no date is better than a row that says "Invalid Date".
 */
export function formatLinkedAt(iso: string): string | null {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return `Linked ${formatEligibleDate(when)}`;
}

/**
 * Can this address be unlinked at all?
 *
 * Mirrors the server's two refusals so the UI can explain BEFORE the press
 * rather than after: the last address can never go, and the primary cannot go
 * while others remain. The server is still the authority — this only decides
 * what the button says.
 */
export function unlinkBlockedReason(
  target: { isPrimary: boolean },
  all: readonly { isPrimary: boolean }[],
): 'last_address' | 'primary_address' | null {
  if (all.length <= 1) return 'last_address';
  if (target.isPrimary) return 'primary_address';
  return null;
}

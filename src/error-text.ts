// src/error-text.ts
//
// THE ONE PLACE that turns a thrown value into text a player can read.
//
// Rules (src/api/README.md §4):
//   • branch on `err.reason` (the domain cause), never on `err.code` — `code`
//     is a closed 12-value transport enum and says nothing about *why*;
//   • never string-match `err.message` — it is human-facing prose and will be
//     reworded;
//   • surface `err.issues` per issue rather than collapsing them to one line;
//   • honour `err.retryAfter` on a 429.
//
// If you find yourself writing `catch (e) { setError(String(e)) }` anywhere in
// the app, call `errorText(e)` instead.

import { ApiError, SessionExpiredError } from './api';

/**
 * Player-facing copy for the `details.reason` values this app can actually
 * hit. Anything not listed falls back to the server's own `message`, which is
 * already written for players.
 */
const REASON_TEXT: Record<string, string> = {
  // ── decks ────────────────────────────────────────────────────────────────
  invalid_deck: 'This deck is not legal yet.',
  deck_name_taken: 'You already have a deck with that name.',

  // ── profile ──────────────────────────────────────────────────────────────
  display_name_taken: 'That display name is already taken. Pick another.',
  avatar_too_long: 'That image URL is too long (max 512 characters).',
  avatar_invalid: 'That image URL could not be read.',
  avatar_scheme: 'Image URLs must start with https://.',
  avatar_credentials: 'Image URLs must not contain a username or password.',
  avatar_host: 'That image host is not allowed.',

  // ── lobby ────────────────────────────────────────────────────────────────
  no_active_deck: 'You need an active deck before you can play. Build one and activate it.',
  invalid_active_deck: 'Your active deck is no longer legal. Fix it and activate it again.',
  self_challenge: 'You cannot challenge yourself.',
  too_many_open_matches: 'You already have 3 open matches. Cancel one before creating another.',
  // `match_not_open` is the join path's most common refusal, and it covers four
  // situations the server does not distinguish: the match already started, it
  // filled up, it was cancelled, or it went void. Say all of it — a player who
  // clicked an invite needs to know the link is dead, not merely "not open".
  match_not_open: 'That match is no longer open — it has already started, filled up, or been cancelled.',
  already_seated: 'You are already seated in that match.',
  match_incomplete: 'That match cannot be started — the host is no longer available.',
  setup_rejected: 'The server refused to start that match.',

  // ── card ownership ───────────────────────────────────────────────────────
  // Ranked and wager seating check the active deck against the player's real
  // CardPack holdings. `details.issues` names each offending card, so the
  // headline stays short and the list carries the detail.
  //
  // Wager is not mentioned: this client does not offer it, so the only way a
  // player reaches this line is a ranked match. It names the fix (boosters) and
  // the exemption (Nodes) because a starter deck ALWAYS lands here — that is the
  // design, and the copy has to read as a rule rather than as a fault.
  unowned_cards: 'Ranked matches only use cards you own — your active deck has some you do not. Basic Nodes are always free; everything else comes from booster packs.',
  // The HOST's deck failed re-validation as you tried to join. It deliberately
  // carries no card detail — a decklist must never cross the table — and there
  // is nothing the joining player can fix, so point them elsewhere.
  host_deck_unowned: 'That match can no longer be started — the host no longer owns every card in their deck. Pick another match.',

  // ── collection sync (all 503, all leave the stored snapshot untouched) ────
  card_pack_unconfigured: 'Card syncing is not available on this deployment yet.',
  card_index_out_of_sync: 'Card syncing is temporarily unavailable. Your collection is unchanged.',
  card_chain_mismatch: 'Card syncing is temporarily unavailable. Your collection is unchanged.',
  card_chain_unavailable: 'The card chain could not be reached. Your collection is unchanged — try again shortly.',
  card_chain_error: 'The card chain could not be read. Your collection is unchanged — try again shortly.',
  card_chain_unreachable: 'The card chain could not be reached. Your collection is unchanged — try again shortly.',
  card_enumeration_unavailable: 'Your holdings were too large to scan just now. Your collection is unchanged.',

  // ── wager ────────────────────────────────────────────────────────────────
  unknown_stake_tier: 'That stake is no longer offered.',
  match_not_found: 'That match no longer exists.',
  escrow_not_found: 'That escrow no longer exists.',
  not_a_participant: 'You are not a player in that match.',
  match_not_joinable: 'That match cannot take a stake right now.',
  stake_mismatch: 'Your opponent opened this match at a different stake.',
  escrow_closed: 'That escrow is already closed.',
  seat_already_funded: 'Your seat is already funded.',
  signature_already_used: 'That transaction has already been counted.',
};

/**
 * One line of player-facing text for any thrown value.
 *
 * Handles `ApiError` (including the network / abort / session-expired
 * synthetics), plain `Error` — which is what `src/wallet.ts` and the wallet
 * providers throw when a user rejects a signature — and anything else.
 */
export function errorText(err: unknown): string {
  if (err instanceof SessionExpiredError) {
    return 'Your session expired. Sign in with your wallet again.';
  }

  if (err instanceof ApiError) {
    if (err.isNetworkError) {
      return err.code === 'aborted'
        ? 'That request was cancelled.'
        : 'Could not reach the server. Check your connection and try again.';
    }

    if (err.isRateLimited) {
      return err.retryAfter !== null
        ? `Too many requests — try again in ${err.retryAfter}s.`
        : 'Too many requests — slow down and try again shortly.';
    }

    // The domain cause, when the server named one.
    const reason = err.reason;
    if (reason !== null && REASON_TEXT[reason]) {
      const base = REASON_TEXT[reason];
      const issues = errorIssues(err);
      return issues.length > 0 ? `${base} ${issues.join(' ')}` : base;
    }

    // Validation failures with no reason: lead with the issues themselves.
    const issues = errorIssues(err);
    if (issues.length > 0) return issues.join(' ');

    if (err.isServerError) {
      return 'The server had a problem. Try again in a moment.';
    }

    // The envelope's own prose is written for players — use it verbatim.
    return err.message;
  }

  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong.';
}

/**
 * The one-line summary WITHOUT the per-issue detail appended.
 *
 * For UI that renders `errorIssues()` as its own list — `DeckBlockedBanner` and
 * the deck panel both do — `errorText()` would repeat every issue inside the
 * headline as well. Use this for the heading and `errorIssues()` for the list.
 */
export function errorHeadline(err: unknown): string {
  if (err instanceof ApiError && !err.isNetworkError && !err.isRateLimited) {
    const reason = err.reason;
    if (reason !== null && REASON_TEXT[reason]) return REASON_TEXT[reason];
  }
  return errorText(err);
}

/**
 * Per-issue text from `details.issues`, ready to render as a list.
 *
 * Two producers populate this array with different shapes: zod body validation
 * (`{path, message, code}`) and deck legality (`{code, message}`, no `path`).
 * Both carry a player-readable `message`; the path is only worth showing when
 * the server gave one.
 */
export function errorIssues(err: unknown): string[] {
  if (!(err instanceof ApiError)) return [];
  return err.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
}

/**
 * `true` when the caller should send the player to the deck screen.
 *
 * `unowned_cards` belongs here: the player's own active deck contains cards
 * their collection does not cover, and the fix is to edit the deck (or sync a
 * pack they have just opened). It is NOT retryable and it is NOT a red box.
 *
 * `host_deck_unowned` deliberately does NOT belong here — that is somebody
 * else's deck, and the joining player has nothing to fix. See `isHostDeckUnowned`.
 */
export function isDeckBlocked(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.reason === 'no_active_deck' ||
      err.reason === 'invalid_active_deck' ||
      err.reason === 'unowned_cards')
  );
}

/**
 * `409 { reason: 'host_deck_unowned' }` — the match's HOST no longer owns every
 * card in their deck, so the match cannot start. Carries no card detail by
 * design (a decklist must never leak across the table). The joining player's
 * only move is to pick a different match, so refresh the lobby and say so.
 */
export function isHostDeckUnowned(err: unknown): boolean {
  return err instanceof ApiError && err.reason === 'host_deck_unowned';
}

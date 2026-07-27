// src/ranked-client.ts
//
// ─── RANKED IS NOT AVAILABLE ON THE NEW BACKEND ────────────────────────────
//
// This module used to be a typed client for `/api/ranked/*` on the legacy Koa
// server: a ladder, seasons, LP, placement matches, an MMR queue and a
// region-sharded matchmaker. NONE of those routes exist any more. Verified
// against production — `GET https://api.ocva.online/api/ranked/season` is a 404,
// as is every other `/api/ranked/*` path.
//
// What the new backend offers instead (INTEGRATION.md §3):
//
//   GET /api/leaderboard                     top 50 by wins — not a ladder
//   GET /api/profiles/:name                  wins, losses, a derived `level`
//   GET /api/profiles/:name/matches          match history
//   POST /games/create  { mode: 'ranked' }   a match TAGGED ranked, and nothing
//                                            more: no rating, no queue, no
//                                            season, no placement
//
// So there is no honest way to render a rank, an LP total, a placement counter
// or a queue timer. Rather than invent numbers the server does not have, the
// ranked surfaces are GATED — see `RANKED_AVAILABLE` below and its call sites
// in `Landing`, `MatchmakingPanel` and the lobby's match panel.
//
// WHAT WOULD HAVE TO BE BUILT SERVER-SIDE to turn this back on:
//   1. a rating store (rating + deviation per profile per season) and the
//      update rule, applied by the same trusted path that already writes
//      `game.match_results` — never by the client;
//   2. season records with start/end and reward definitions;
//   3. a queue: enqueue / dequeue / status, with an MMR window that widens
//      over time, plus a pairer that creates the match server-side and returns
//      each player their own seat + credentials (the seat handoff already
//      exists as `GET /games/:id/seat`);
//   4. placement handling for a player's first N matches;
//   5. a ladder read model (`GET /api/ranked/leaderboard?scope=season`).
//
// Until then this file exports only the gate. The old `RankedAPI` object, the
// tier colours and the LP label formatter are gone: keeping them would mean
// keeping UI that renders data nothing can supply.

/**
 * Is the competitive LADDER backed by a real service? It is not.
 *
 * This says nothing about ranked MATCHES, which do work: `POST /games/create
 * {mode:'ranked'}` seats a match whose decks are checked against real card
 * ownership, and the lobby's Create Match panel offers exactly that. What is
 * missing is everything the ladder is made of — rating, seasons, a queue — so
 * this gate stays closed and the panel it drives says which half is which.
 */
export const RANKED_AVAILABLE = false as const;

/** One line for the UI to show wherever the ladder used to be offered. */
export const RANKED_UNAVAILABLE_MESSAGE =
  'You can already create ranked matches from Create Match — they check your deck against the cards you own. ' +
  'The ladder itself is what is missing: there is no rating, season or queue service yet, so results do not move a rank.';

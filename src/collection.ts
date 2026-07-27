// src/collection.ts
// Player card collection / ownership ledger.
//
// Ownership model: every player starts with a fixed grant of chain Nodes, and
// gains every other card ONLY by opening booster packs (CardPack NFT mints).
// Custom decks may therefore only be built from owned cards. Starter (chain
// Standard) decks bypass this and are allowed in casual/unranked play only.
//
// Persistence is client-side (localStorage), keyed by player name — consistent
// with the app's username-based identity and the booster mint flow, which also
// knows the player's name. This mirrors the game's existing trust model (decks
// are already client-submitted); the deck builder + mode gates enforce it.

import { COLORS, CARDS, validateDeck, isBasicNode, MAX_COPIES_NONBASIC, type DeckIssue, type DeckValidation } from './cards';

/** Free Nodes every collection starts with — 20 of each chain's basic Node. */
export const STARTING_NODES = 20;

export type Collection = Record<string, number>;

function keyFor(name: string) { return `ocva.collection.${name}`; }

function seed(): Collection {
  const c: Collection = {};
  for (const col of COLORS) c[`node_${col}`] = STARTING_NODES;
  return c;
}

function save(name: string, c: Collection) {
  try { localStorage.setItem(keyFor(name), JSON.stringify(c)); } catch { /* ignore */ }
}

/**
 * Returns the player's owned-card counts, initializing the free Node grant on
 * first access and back-filling it for existing collections (migration-safe).
 */
export function getCollection(name: string): Collection {
  let c: Collection | null = null;
  try { const raw = localStorage.getItem(keyFor(name)); if (raw) c = JSON.parse(raw) as Collection; } catch { /* ignore */ }
  if (!c || typeof c !== 'object') { c = seed(); save(name, c); return c; }
  // Ensure the Node grant is always present.
  let changed = false;
  for (const col of COLORS) {
    const id = `node_${col}`;
    if ((c[id] ?? 0) < STARTING_NODES) { c[id] = STARTING_NODES; changed = true; }
  }
  if (changed) save(name, c);
  return c;
}

/** How many copies of a card the player owns. */
export function ownedCount(name: string, id: string): number {
  return getCollection(name)[id] ?? 0;
}

/** Add cards to the player's collection (called after a booster mint). */
export function grantCards(name: string, ids: string[]): Collection {
  const c = getCollection(name);
  for (const id of ids) c[id] = (c[id] ?? 0) + 1;
  save(name, c);
  try { window.dispatchEvent(new CustomEvent('ocva:collection-changed', { detail: { name } })); } catch { /* ignore */ }
  return c;
}

/** The most copies of a card that may be placed in a deck: min(owned, format cap). */
export function deckCap(name: string, id: string): number {
  const owned = ownedCount(name, id);
  const formatCap = isBasicNode(id) ? Infinity : MAX_COPIES_NONBASIC;
  return Math.min(owned, formatCap);
}

/** Ownership-only issues for a deck (does not include size/copy-format checks). */
export function ownershipIssues(name: string, cards: string[]): DeckIssue[] {
  const c = getCollection(name);
  const counts: Record<string, number> = {};
  for (const id of cards) counts[id] = (counts[id] ?? 0) + 1;
  const issues: DeckIssue[] = [];
  for (const [id, n] of Object.entries(counts)) {
    const owned = c[id] ?? 0;
    if (n > owned) {
      const nm = CARDS[id]?.name ?? id;
      issues.push({ code: 'owned', message: owned === 0
        ? `You don't own ${nm} — open boosters to unlock it.`
        : `You only own ${owned}× ${nm} (deck uses ${n}).` });
    }
  }
  return issues;
}

/** Full deck validation including ownership (size + copy caps + owned). */
export function validateOwnedDeck(name: string, cards: string[]): DeckValidation {
  const base = validateDeck(cards);
  const owned = ownershipIssues(name, cards);
  return { ok: base.ok && owned.length === 0, size: base.size, issues: [...base.issues, ...owned] };
}

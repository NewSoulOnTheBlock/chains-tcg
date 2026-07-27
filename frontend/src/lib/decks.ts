// Deck persistence — REST helpers for the gateway decks API plus the
// locally-stored "active deck" the player brings into a match.
//
// Server routes (backend/services/profile):
//   GET    /api/profiles/:name/decks            → DeckRow[]
//   POST   /api/profiles/:name/decks {name, cards} → DeckRow  (400 {error, issues?})
//   PUT    /api/decks/:id {name?, cards?}       → DeckRow     (400 {error, issues?})
//   DELETE /api/decks/:id                       → {ok: true}
//
// There is no GET /api/decks/:id — single decks are found via the list.

import type { DeckIssue } from "@chains/game-core";
import { API_BASE } from "@/lib/config";
import { getProfileName } from "@/lib/profile";

/** Deck row as returned by the server. */
export interface DeckRow {
  id: number;
  profile_id: number;
  name: string;
  cards: string[];
  created_at?: string;
  updated_at?: string;
}

/** API failure carrying the server's validateDeck issues (empty otherwise). */
export class DeckApiError extends Error {
  status: number;
  issues: DeckIssue[];
  constructor(message: string, status: number, issues: DeckIssue[] = []) {
    super(message);
    this.name = "DeckApiError";
    this.status = status;
    this.issues = issues;
  }
}

async function parseError(res: Response): Promise<DeckApiError> {
  let message = `HTTP ${res.status}`;
  let issues: DeckIssue[] = [];
  try {
    const body = await res.json();
    if (typeof body?.error === "string") message = body.error;
    if (Array.isArray(body?.issues)) issues = body.issues;
  } catch {
    /* non-JSON body */
  }
  return new DeckApiError(message, res.status, issues);
}

/** Profile name required for deck calls; throws a friendly error when unset. */
export function requireProfileName(): string {
  const name = getProfileName().trim();
  if (!name) {
    throw new DeckApiError("Set your profile name first", 0);
  }
  return name;
}

/**
 * Awaited idempotent upsert of the profile row (the server returns the
 * existing row for known names). Deck routes 404 for unknown profiles, so
 * this must complete before the first deck call — the fire-and-forget
 * registerProfile() in profileApi.ts cannot guarantee that ordering.
 */
async function ensureProfileRegistered(name: string): Promise<void> {
  const res = await fetch(`${API_BASE}/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw await parseError(res);
}

/** All decks saved under the current profile ([] when no profile name set). */
export async function listMyDecks(): Promise<DeckRow[]> {
  const name = getProfileName().trim();
  if (!name) return [];
  await ensureProfileRegistered(name);
  const res = await fetch(
    `${API_BASE}/profiles/${encodeURIComponent(name)}/decks`,
    { cache: "no-store" },
  );
  if (!res.ok) throw await parseError(res);
  const data = await res.json();
  return Array.isArray(data) ? (data as DeckRow[]) : [];
}

/** Create a deck for the current profile. Throws DeckApiError (with issues) on 400. */
export async function createDeck(name: string, cards: string[]): Promise<DeckRow> {
  const profile = requireProfileName();
  await ensureProfileRegistered(profile);
  const res = await fetch(
    `${API_BASE}/profiles/${encodeURIComponent(profile)}/decks`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, cards }),
    },
  );
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as DeckRow;
}

/** Rename and/or replace the card list of a deck. */
export async function updateDeck(
  id: number,
  patch: { name?: string; cards?: string[] },
): Promise<DeckRow> {
  const res = await fetch(`${API_BASE}/decks/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as DeckRow;
}

export async function deleteDeck(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/decks/${id}`, { method: "DELETE" });
  if (!res.ok) throw await parseError(res);
}

// ── Active deck (localStorage) ───────────────────────────────────────────────
// The deck the player carries into the color-pick phase. Starter decks are
// stored without an id (their card list is snapshotted directly).

const ACTIVE_KEY = "chains:activeDeck";

export interface ActiveDeck {
  /** Server deck id — absent for starter decks. */
  id?: number;
  name: string;
  cards: string[];
}

export function getActiveDeck(): ActiveDeck | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.name === "string" &&
      Array.isArray(parsed.cards) &&
      parsed.cards.every((c: unknown) => typeof c === "string")
    ) {
      return parsed as ActiveDeck;
    }
  } catch {
    /* corrupt / privacy errors */
  }
  return null;
}

export function setActiveDeck(deck: ActiveDeck | null): void {
  if (typeof window === "undefined") return;
  try {
    if (deck === null) window.localStorage.removeItem(ACTIVE_KEY);
    else window.localStorage.setItem(ACTIVE_KEY, JSON.stringify(deck));
  } catch {
    /* ignore quota / privacy errors */
  }
}

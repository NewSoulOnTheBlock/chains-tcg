// src/profiles.ts
// HTTP-API-backed player profile client (server in src/server.ts persists to Postgres).

export type Profile = {
  name: string;
  wins: number;
  losses: number;
  draws: number;
  createdAt: number;
  avatarUrl: string | null;
  bio: string | null;
  walletAddress: string | null;
  walletChain: string | null;
};

// API base: in dev Vite proxies /api → :8000; in prod the React build is served by the same server.
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export async function listProfilesApi(): Promise<Profile[]> {
  const { profiles } = await http<{ profiles: Profile[] }>('/api/leaderboard');
  return profiles;
}

export async function getProfileApi(name: string): Promise<Profile | null> {
  const { profile } = await http<{ profile: Profile | null }>(`/api/profile/${encodeURIComponent(name)}`);
  return profile;
}

export async function getProfileByWalletApi(addr: string): Promise<Profile | null> {
  const { profile } = await http<{ profile: Profile | null }>(`/api/profile-by-wallet/${encodeURIComponent(addr)}`);
  return profile;
}

export async function upsertProfileApi(name: string): Promise<Profile> {
  const { profile } = await http<{ profile: Profile }>('/api/profile', {
    method: 'POST', body: JSON.stringify({ name }),
  });
  return profile;
}

export async function updateProfileApi(
  name: string,
  patch: { avatarUrl?: string | null; bio?: string | null; walletAddress?: string | null; walletChain?: string | null },
): Promise<Profile> {
  const { profile } = await http<{ profile: Profile }>('/api/profile/update', {
    method: 'POST', body: JSON.stringify({ name, ...patch }),
  });
  return profile;
}

export async function recordResultApi(
  matchID: string,
  result: { winner: string | null; loser: string | null; draw: boolean } & Record<string, any>,
): Promise<'recorded' | 'duplicate'> {
  const { status } = await http<{ status: 'recorded' | 'duplicate' }>(
    '/api/result',
    { method: 'POST', body: JSON.stringify({ matchID, ...result }) },
  );
  return status;
}

export type LibraryCard = {
  id: string;
  name: string;
  image: string;
  collection?: string;
};

export async function getLibraryApi(walletAddress: string): Promise<LibraryCard[]> {
  const { cards } = await http<{ cards: LibraryCard[] }>(`/api/library/${encodeURIComponent(walletAddress)}`);
  return cards;
}

export async function getDeckApi(name: string): Promise<string[]> {
  const { cards } = await http<{ cards: string[] }>(`/api/deck/${encodeURIComponent(name)}`);
  return cards;
}

export async function saveDeckApi(name: string, cards: string[]): Promise<void> {
  await http<{ ok: true }>('/api/deck', {
    method: 'POST', body: JSON.stringify({ name, cards }),
  });
}

// ── Deck Library (multi-deck) ────────────────────────────────────────────────

export type DeckEntry = { id: number; name: string; cards: string[]; isActive: boolean };

export async function listDecksApi(name: string): Promise<DeckEntry[]> {
  const { decks } = await http<{ decks: DeckEntry[] }>(`/api/decks?name=${encodeURIComponent(name)}`);
  return decks;
}

export async function createDeckApi(name: string, deckName: string, cards: string[]): Promise<DeckEntry> {
  const { deck } = await http<{ deck: DeckEntry }>(`/api/decks?name=${encodeURIComponent(name)}`, {
    method: 'POST', body: JSON.stringify({ name: deckName, cards }),
  });
  return deck;
}

export async function updateDeckApi(
  name: string, deckId: number, patch: { name?: string; cards?: string[] },
): Promise<DeckEntry> {
  const { deck } = await http<{ deck: DeckEntry }>(`/api/decks/${deckId}?name=${encodeURIComponent(name)}`, {
    method: 'PUT', body: JSON.stringify(patch),
  });
  return deck;
}

export async function deleteDeckApi(name: string, deckId: number): Promise<void> {
  await http<{ ok: true }>(`/api/decks/${deckId}?name=${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

export async function activateDeckApi(name: string, deckId: number): Promise<DeckEntry> {
  const { deck } = await http<{ deck: DeckEntry }>(`/api/decks/${deckId}/activate?name=${encodeURIComponent(name)}`, {
    method: 'POST',
  });
  return deck;
}

// ── Challenges ────────────────────────────────────────────────────────────────

export type Challenge = {
  id: string;
  fromName: string;
  toName: string;
  matchId: string;
  wagerKind: 'free' | 'master';
  wagerAmount: number | null;
  message: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';
  createdAt: number;
  expiresAt: number;
};

export async function createChallengeApi(args: {
  fromName: string;
  toName: string;
  matchId: string;
  wagerKind: 'free' | 'master';
  wagerAmount?: number | null;
  message?: string | null;
}): Promise<Challenge> {
  const { challenge } = await http<{ challenge: Challenge }>('/api/challenges', {
    method: 'POST', body: JSON.stringify(args),
  });
  return challenge;
}

export async function listIncomingChallengesApi(name: string): Promise<Challenge[]> {
  const { challenges } = await http<{ challenges: Challenge[] }>(`/api/challenges/in/${encodeURIComponent(name)}`);
  return challenges;
}
export async function listOutgoingChallengesApi(name: string): Promise<Challenge[]> {
  const { challenges } = await http<{ challenges: Challenge[] }>(`/api/challenges/out/${encodeURIComponent(name)}`);
  return challenges;
}
export async function respondChallengeApi(
  id: string, action: 'accept' | 'decline' | 'cancel', actorName: string,
): Promise<Challenge> {
  const { challenge } = await http<{ challenge: Challenge }>(
    `/api/challenges/${encodeURIComponent(id)}/${action}`,
    { method: 'POST', body: JSON.stringify({ actorName }) },
  );
  return challenge;
}

export function formatRecord(p: Profile | null | undefined): string {
  if (!p) return '0-0';
  return p.draws > 0 ? `${p.wins}-${p.losses}-${p.draws}` : `${p.wins}-${p.losses}`;
}

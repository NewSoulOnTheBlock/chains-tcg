// src/ranked-client.ts — typed client for /api/ranked/*
import type { Tier, Division } from './ranked/ranks';

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export type PublicRankedProfile = {
  playerId: string;
  visibleRank: Tier;
  division: Division;
  rankedPoints: number;
  wins: number;
  losses: number;
  placementMatchesRemaining: number;
  seasonId: string;
  createdAt: number;
  updatedAt: number;
};

export type LeaderboardEntry = {
  rank: number;
  playerId: string;
  visibleRank: Tier;
  division: Division;
  rankedPoints: number;
  wins: number;
  losses: number;
};

export type SeasonInfo = {
  id: string; name: string;
  startedAt: number; endsAt: number;
  active: boolean;
  rewardDefinitions: any;
};

export type RankedQueueStatus = {
  queued: boolean;
  queuedAt: number | null;
  match: { matchId: string; opponent: string; seat: '0' | '1' } | null;
};

export const RankedAPI = {
  profile: (name: string) =>
    http<{ profile: PublicRankedProfile }>(`/api/ranked/profile/${encodeURIComponent(name)}`)
      .then(r => r.profile),
  leaderboard: (limit = 50) =>
    http<{ entries: LeaderboardEntry[] }>(`/api/ranked/leaderboard?scope=season&limit=${limit}`)
      .then(r => r.entries),
  season: () =>
    http<{ season: SeasonInfo }>(`/api/ranked/season`).then(r => r.season),
  queueJoin: (name: string, region: string, deckId?: string) =>
    http<{ ok: boolean; queuedAt?: number; seasonId?: string; error?: string }>(`/api/ranked/queue/join`, {
      method: 'POST', body: JSON.stringify({ name, region, deckId }),
    }),
  queueLeave: (name: string) =>
    http<{ ok: boolean }>(`/api/ranked/queue/leave`, {
      method: 'POST', body: JSON.stringify({ name }),
    }),
  queueStatus: (name: string) =>
    http<RankedQueueStatus>(`/api/ranked/queue/status?name=${encodeURIComponent(name)}`),
};

// ── Visual helpers ──────────────────────────────────────────────────────────
const TIER_COLORS: Record<Tier, { fg: string; bg: string; glow: string }> = {
  Bronze:      { fg: '#fff1d6', bg: 'linear-gradient(135deg,#7a4f24,#a86a32)', glow: '#a86a32' },
  Silver:      { fg: '#f4f4f4', bg: 'linear-gradient(135deg,#7d7d7d,#c2c2c2)', glow: '#c2c2c2' },
  Gold:        { fg: '#3a2900', bg: 'linear-gradient(135deg,#c79a2a,#ffd86a)', glow: '#ffd86a' },
  Platinum:    { fg: '#06343a', bg: 'linear-gradient(135deg,#26b8c9,#7debf6)', glow: '#7debf6' },
  Diamond:     { fg: '#06223a', bg: 'linear-gradient(135deg,#3a7dff,#a3c8ff)', glow: '#a3c8ff' },
  Master:      { fg: '#fff', bg: 'linear-gradient(135deg,#7b2cbf,#c084fc)', glow: '#c084fc' },
  Grandmaster: { fg: '#fff', bg: 'linear-gradient(135deg,#a30000,#ff5757)', glow: '#ff5757' },
  Mythic:      { fg: '#fff', bg: 'linear-gradient(135deg,#ff7e1a,#ffd86a,#ff5757)', glow: '#ffaa55' },
};

export function tierColors(t: Tier) { return TIER_COLORS[t]; }

const ROMAN: Record<Division | 0, string> = { 4: 'IV', 3: 'III', 2: 'II', 1: 'I', 0: '' };
export function rankLabel(p: { visibleRank: Tier; division: Division; rankedPoints: number }) {
  if (p.visibleRank === 'Mythic') return `Mythic ${p.rankedPoints} LP`;
  return `${p.visibleRank} ${ROMAN[p.division]} · ${p.rankedPoints} LP`;
}

// src/ranked/types.ts
import type { Tier, Division } from './ranks';

export type RankedProfile = {
  playerId: string;             // we use the existing profile name as id (no UUIDs in this app)
  hiddenMmr: number;
  ratingDeviation: number;
  volatility: number;
  visibleRank: Tier;
  division: Division;
  rankedPoints: number;
  wins: number;
  losses: number;
  placementMatchesRemaining: number;
  seasonId: string;
  smurfFlagged: boolean;
  mmrMultiplier: number;        // 1.0 default; raised by anti-smurf
  createdAt: number;
  updatedAt: number;
};

export type Season = {
  id: string;
  name: string;
  startedAt: number;
  endsAt: number;
  active: boolean;
  softResetFactor: number;      // newMMR = 1500 + (oldMMR-1500)*factor
  rewardDefinitions: any;       // JSONB blob — cosmetics only per spec
  balancePatch: string | null;
};

export type RankedQueueEntry = {
  playerId: string;
  hiddenMmr: number;
  region: string;
  queuedAt: number;
  selectedDeckId: string;       // stringified deck list, must validate
  seasonId: string;
};

export type RankedMatchOutcome = {
  matchId: string;
  seasonId: string;
  player0: string;              // names (existing profile.id surrogate)
  player1: string;
  winner: string | null;        // null if draw
  draw: boolean;
  startedAt: number;
  endedAt: number;
  replaySeed: string;
  disconnectedPlayer: string | null;
};

export type ReplayEvent = {
  matchId: string;
  seq: number;
  ts: number;
  type: string;                 // 'move' | 'turn_end' | 'gameover' | etc.
  actor: string | null;         // playerId or null for system events
  payload: any;
};

export type TelemetryEvent = {
  ts: number;
  type:
    | 'match_started' | 'turn_played' | 'match_ended' | 'disconnect'
    | 'card_drawn' | 'card_played' | 'mulligan_kept' | 'surrender'
    | 'rank_up' | 'demotion' | 'promotion_series' | 'queue_time'
    | 'smurf_flagged';
  playerId: string | null;
  matchId: string | null;
  payload: any;
};

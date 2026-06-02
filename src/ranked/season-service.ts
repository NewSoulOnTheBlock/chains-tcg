// src/ranked/season-service.ts
// Season lifecycle: bootstrap, soft reset, rollover.
import * as RDB from './db';
import type { Season } from './types';
import { TIERS } from './ranks';

const DEFAULT_DURATION_DAYS = 60;
const DEFAULT_SOFT_RESET = 0.5;     // newMMR = 1500 + (oldMMR-1500)*0.5

export function defaultSeason(now = Date.now(), durationDays = DEFAULT_DURATION_DAYS): Season {
  const id = `season-${new Date(now).toISOString().slice(0,10)}`;
  return {
    id, name: 'Genesis Season',
    startedAt: now,
    endsAt: now + durationDays * 86400 * 1000,
    active: true,
    softResetFactor: DEFAULT_SOFT_RESET,
    rewardDefinitions: {
      tiers: Object.fromEntries(TIERS.map(t => [t, { cardback: `cardback_${t.toLowerCase()}`, title: `${t} Memer` }])),
    },
    balancePatch: null,
  };
}

/** Ensure exactly one active season. Bootstraps one on first boot. */
export async function ensureActiveSeason(): Promise<Season> {
  const cur = await RDB.getActiveSeason();
  if (cur && cur.endsAt > Date.now()) return cur;
  if (cur && cur.endsAt <= Date.now()) {
    await rollSeason(cur);
  }
  const fresh = defaultSeason();
  await RDB.upsertSeason(fresh);
  await RDB.setActiveSeason(fresh.id);
  return fresh;
}

/**
 * Roll the current season: archive standings, soft-reset every profile's MMR,
 * reset placements to 10, and demote the visible rank floor.
 *
 *   newMMR = 1500 + (oldMMR - 1500) * softResetFactor
 */
export async function rollSeason(prev: Season): Promise<Season> {
  const profiles = await RDB.listAllProfilesForSeason(prev.id);
  const next = defaultSeason(Date.now());
  await RDB.upsertSeason(next);
  await RDB.setActiveSeason(next.id);

  // Soft-reset every profile into the new season.
  for (const p of profiles) {
    const newMmr = 1500 + (p.hiddenMmr - 1500) * prev.softResetFactor;
    // RD widens slightly because the system has less recent data.
    const newRd = Math.min(350, p.ratingDeviation + 50);
    await RDB.upsertRankedProfile({
      ...p,
      hiddenMmr: newMmr,
      ratingDeviation: newRd,
      visibleRank: 'Bronze',
      division: 4,
      rankedPoints: 0,
      placementMatchesRemaining: 10,
      seasonId: next.id,
      mmrMultiplier: 1.0,
      smurfFlagged: false,
      updatedAt: Date.now(),
    });
  }
  return next;
}

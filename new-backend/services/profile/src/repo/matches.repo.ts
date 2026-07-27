import { query } from '@chains/shared';

export interface MatchHistoryEntry {
  matchId: string;
  mode: string;
  seat: 0 | 1;
  outcome: 'win' | 'loss' | 'draw';
  reason: string;
  opponentDisplayName: string | null;
  finishedAt: string;
}

/**
 * Recent finished matches for a profile, read from the authoritative
 * `game.match_results` rows the game service writes. Joined to `core.profiles`
 * for the opponent's DISPLAY NAME only — `address` is never selected (H-2).
 */
export async function listMatchHistory(
  profileId: string,
  limit: number,
): Promise<MatchHistoryEntry[]> {
  const { rows } = await query<{
    match_id: string;
    mode: string;
    winner_seat: number | null;
    reason: string;
    finished_at: Date;
    seat0_profile: string | null;
    seat1_profile: string | null;
    seat0_name: string | null;
    seat1_name: string | null;
  }>(
    `SELECT r.match_id,
            m.mode,
            r.winner_seat,
            r.reason,
            r.finished_at,
            m.seat0_profile::text,
            m.seat1_profile::text,
            p0.display_name AS seat0_name,
            p1.display_name AS seat1_name
       FROM game.match_results r
       JOIN game.matches       m  ON m.id  = r.match_id
       LEFT JOIN core.profiles p0 ON p0.id = m.seat0_profile
       LEFT JOIN core.profiles p1 ON p1.id = m.seat1_profile
      WHERE m.seat0_profile = $1 OR m.seat1_profile = $1
      ORDER BY r.finished_at DESC
      LIMIT $2`,
    [profileId, limit],
  );

  return rows.map((r) => {
    const seat: 0 | 1 = r.seat0_profile === profileId ? 0 : 1;
    const outcome: MatchHistoryEntry['outcome'] =
      r.winner_seat === null ? 'draw' : r.winner_seat === seat ? 'win' : 'loss';
    return {
      matchId: r.match_id,
      mode: r.mode,
      seat,
      outcome,
      reason: r.reason,
      opponentDisplayName: seat === 0 ? r.seat1_name : r.seat0_name,
      finishedAt: r.finished_at.toISOString(),
    };
  });
}

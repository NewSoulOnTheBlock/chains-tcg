// src/dailyChallenge.ts
// ─────────────────────────────────────────────────────────────────────────────
// Daily Bot Challenge — same RNG seed + same bot color for every player who
// plays on a given UTC date. Tracks personal bests locally; the server-side
// global leaderboard is a follow-up (see notes in App.tsx). Result records:
//
//   { date: '2026-06-04', win: true, turns: 9, ms: 142_000, difficulty: 'normal' }
// ─────────────────────────────────────────────────────────────────────────────

import type { Color } from './cards';

export function todayKey(now: Date = new Date()): string {
  // YYYY-MM-DD in UTC so the day rolls over at the same moment for everyone.
  return now.toISOString().slice(0, 10);
}

export function dailySeed(date: string): string {
  return `mmtcg-daily-${date}`;
}

// Deterministic colour pick for the bot per day: hash the date string into one
// of the 5 chains. The player still picks their own deck before the match.
export function dailyBotColor(date: string): Color {
  const colors: Color[] = ['bnb', 'sol', 'hl', 'eth', 'xrp'];
  let h = 0;
  for (let i = 0; i < date.length; i++) h = (h * 31 + date.charCodeAt(i)) | 0;
  return colors[Math.abs(h) % colors.length];
}

export type DailyRecord = {
  date: string;
  win: boolean;
  turns: number;
  ms: number;
  difficulty: 'easy' | 'normal' | 'hard';
};

const KEY = 'mmtcg.dailyResults';

export function loadDailyResults(): DailyRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DailyRecord[]) : [];
  } catch { return []; }
}

export function saveDailyResult(rec: DailyRecord): void {
  try {
    const all = loadDailyResults();
    // Keep the player's best (fastest win) for each date+difficulty combo.
    const same = all.filter(r => !(r.date === rec.date && r.difficulty === rec.difficulty));
    const prior = all.find(r => r.date === rec.date && r.difficulty === rec.difficulty);
    const keep = prior && prior.win && (!rec.win || prior.ms < rec.ms) ? prior : rec;
    same.push(keep);
    localStorage.setItem(KEY, JSON.stringify(same.slice(-200)));
  } catch { /* swallow */ }
}

export function todayBest(difficulty: 'easy' | 'normal' | 'hard' = 'normal'): DailyRecord | null {
  const t = todayKey();
  return loadDailyResults().find(r => r.date === t && r.difficulty === difficulty) ?? null;
}

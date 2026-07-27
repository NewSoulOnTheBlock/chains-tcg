// Level/XP math (ported from the legacy profile page) + client-side
// achievements computed from wins/losses and recent match history.

import {
  Trophy,
  Star,
  Crown,
  Shield,
  Medal,
  Flame,
  Zap,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { MatchSummary } from "@/lib/profileApi";

// ── Level / XP (legacy formulas) ─────────────────────────────────────────────
// games = wins + losses; XP is simply games played.

export function levelFromGames(games: number): number {
  return Math.max(1, Math.floor(Math.sqrt((games + 1) * 2.2)));
}

export function xpForNextLevel(lvl: number): number {
  return Math.round(((lvl + 1) * (lvl + 1)) / 2.2);
}

export interface LevelProgress {
  level: number;
  /** XP earned inside the current level. */
  xpInto: number;
  /** XP span of the current level. */
  xpRange: number;
  /** 0–100 fill percentage for the bar. */
  pct: number;
}

export function levelProgress(games: number): LevelProgress {
  const level = levelFromGames(games);
  const xpPrev = xpForNextLevel(level - 1);
  const xpNext = xpForNextLevel(level);
  const xpRange = Math.max(1, xpNext - xpPrev);
  const xpInto = Math.max(0, games - xpPrev);
  const pct = Math.max(0, Math.min(100, Math.round((xpInto / xpRange) * 100)));
  return { level, xpInto, xpRange, pct };
}

// ── Achievements ─────────────────────────────────────────────────────────────

export interface Achievement {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  earned: boolean;
}

/** Longest win streak inside the (newest-first) recent match history. */
function bestRecentStreak(matches: MatchSummary[]): number {
  let best = 0;
  let run = 0;
  for (const m of matches) {
    run = m.result === "win" ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

export function computeAchievements(
  wins: number,
  losses: number,
  matches: MatchSummary[],
): Achievement[] {
  const games = wins + losses;
  const winPct = games ? wins / games : 0;
  const level = levelFromGames(games);
  const streak = bestRecentStreak(matches);
  return [
    {
      id: "first-victory",
      icon: Trophy,
      title: "First Victory",
      description: "Win your first match.",
      earned: wins >= 1,
    },
    {
      id: "rising-star",
      icon: Star,
      title: "Rising Star",
      description: "Win 5 matches.",
      earned: wins >= 5,
    },
    {
      id: "chain-master",
      icon: Crown,
      title: "Chain Master",
      description: "Win 25 matches.",
      earned: wins >= 25,
    },
    {
      id: "initiate",
      icon: Shield,
      title: "Initiate",
      description: "Play 10 matches.",
      earned: games >= 10,
    },
    {
      id: "veteran",
      icon: Medal,
      title: "Veteran",
      description: "Play 50 matches.",
      earned: games >= 50,
    },
    {
      id: "dominator",
      icon: Flame,
      title: "Dominator",
      description: "Hold a 60%+ win rate over 10+ games.",
      earned: games >= 10 && winPct >= 0.6,
    },
    {
      id: "on-a-roll",
      icon: Zap,
      title: "On a Roll",
      description: "Win 3 matches in a row.",
      earned: streak >= 3,
    },
    {
      id: "seasoned",
      icon: Sparkles,
      title: "Seasoned",
      description: "Reach level 5.",
      earned: level >= 5,
    },
  ];
}

// ── Misc helpers ─────────────────────────────────────────────────────────────

/** Compact relative timestamp, e.g. "3h ago". */
export function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// REST helpers for the profile / leaderboard API (see backend gateway /api).

import { toast } from "sonner";
import { API_BASE } from "@/lib/config";

export interface LeaderboardEntry {
  id: number;
  name: string;
  wins: number;
  losses: number;
}

/**
 * Upsert the profile on the server (idempotent — the server returns the
 * existing row for an already-registered name). Fire-and-forget.
 */
export function registerProfile(name: string) {
  const n = name.trim();
  if (!n) return;
  fetch(`${API_BASE}/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: n }),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    })
    .catch(() => {
      toast.error("Could not sync your profile to the server");
    });
}

/** Top-50 leaderboard, sorted by the server. */
export async function fetchLeaderboard(): Promise<LeaderboardEntry[]> {
  const res = await fetch(`${API_BASE}/leaderboard`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ── Match result reporting (multiplayer only, winner's client only) ──────────

const REPORTED_KEY = (matchID: string) => `chains:reported:${matchID}`;

/** True when this device already reported (or attempted to report) the match. */
export function hasReportedMatch(matchID: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(REPORTED_KEY(matchID)) === "1";
  } catch {
    return true;
  }
}

export function markMatchReported(matchID: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REPORTED_KEY(matchID), "1");
  } catch {
    /* ignore quota / privacy errors */
  }
}

/** POST the result (profile names). Returns true on success. */
export async function reportMatchResult(winner: string, loser: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/matches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ winner, loser, mode: "casual" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

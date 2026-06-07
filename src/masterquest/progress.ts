// src/masterquest/progress.ts
// ─────────────────────────────────────────────────────────────────────────────
// Memetic Masterquest — campaign progress, persisted to localStorage.
//
// Tracks which of the 15 Sacred Sites Sorendo has cleared, which is currently
// available, and which read-throughs of the interludes have been completed.
// ─────────────────────────────────────────────────────────────────────────────

import { SITES, TOTAL_SITES, type SiteId } from './lore';

const KEY = 'mmtcg:masterquest:v1';

export interface Progress {
  /** Site ids the player has beaten, in clear-order. */
  cleared: SiteId[];
  /** Whether the epilogue has been displayed at least once. */
  epilogueSeen: boolean;
  /** ISO timestamp of the latest write — used for debugging. */
  updatedAt: string;
}

function emptyProgress(): Progress {
  return { cleared: [], epilogueSeen: false, updatedAt: new Date().toISOString() };
}

export function loadProgress(): Progress {
  if (typeof window === 'undefined') return emptyProgress();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return emptyProgress();
    const p = JSON.parse(raw) as Progress;
    // Defensive: drop any unknown site ids that may have crept in across versions.
    const valid = new Set<SiteId>(SITES.map(s => s.id));
    p.cleared = (p.cleared ?? []).filter(id => valid.has(id));
    p.epilogueSeen = !!p.epilogueSeen;
    return p;
  } catch {
    return emptyProgress();
  }
}

export function saveProgress(p: Progress): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...p, updatedAt: new Date().toISOString() }));
  } catch {
    // localStorage full / disabled — silently drop.
  }
}

export function clearProgress(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(KEY); } catch { /* */ }
}

/** Mark a site as cleared. Idempotent. Returns the updated progress. */
export function recordClear(siteId: SiteId): Progress {
  const p = loadProgress();
  if (!p.cleared.includes(siteId)) {
    p.cleared = [...p.cleared, siteId];
  }
  saveProgress(p);
  return p;
}

/** Mark the epilogue as displayed. Called after Site 15 is shown. */
export function markEpilogueSeen(): Progress {
  const p = loadProgress();
  p.epilogueSeen = true;
  saveProgress(p);
  return p;
}

/**
 * The next site the player can attempt. Returns undefined if the quest is
 * fully cleared. Sites unlock in strict `index` order: the next site is the
 * one with index = clearedCount + 1.
 */
export function currentSiteId(p: Progress = loadProgress()): SiteId | undefined {
  const nextIndex = p.cleared.length + 1;
  if (nextIndex > TOTAL_SITES) return undefined;
  return SITES.find(s => s.index === nextIndex)?.id;
}

/** True if the site is the *next* one the player can attempt. */
export function isUnlocked(siteId: SiteId, p: Progress = loadProgress()): boolean {
  return currentSiteId(p) === siteId;
}

/** True if the player has already beaten this site. */
export function isCleared(siteId: SiteId, p: Progress = loadProgress()): boolean {
  return p.cleared.includes(siteId);
}

/** True if all 15 sites are cleared. */
export function isQuestComplete(p: Progress = loadProgress()): boolean {
  return p.cleared.length >= TOTAL_SITES;
}

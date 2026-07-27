// Local profile + per-match credential persistence (localStorage).

const NAME_KEY = "chains:profileName";
const MATCH_KEY = (matchID: string) => `chains:match:${matchID}`;

export interface MatchCreds {
  playerID: string;
  credentials: string;
}

function safeGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore quota / privacy errors */
  }
}

// Tiny subscription so React can consume the profile name via
// useSyncExternalStore (see useProfileName).
const profileListeners = new Set<() => void>();

export function subscribeProfile(cb: () => void): () => void {
  profileListeners.add(cb);
  return () => {
    profileListeners.delete(cb);
  };
}

export function getProfileName(): string {
  return safeGet(NAME_KEY) ?? "";
}

export function setProfileName(name: string) {
  safeSet(NAME_KEY, name.trim());
  profileListeners.forEach((l) => l());
}

export function getMatchCreds(matchID: string): MatchCreds | null {
  const raw = safeGet(MATCH_KEY(matchID));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.playerID === "string" && typeof parsed?.credentials === "string") {
      return parsed as MatchCreds;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function setMatchCreds(matchID: string, creds: MatchCreds) {
  safeSet(MATCH_KEY(matchID), JSON.stringify(creds));
}

export function clearMatchCreds(matchID: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(MATCH_KEY(matchID));
  } catch {
    /* ignore */
  }
}

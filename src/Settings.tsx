// src/Settings.tsx
// Settings screen for On-Chain Virtual Arena.
//
// Ground rule for this page: every control here is wired to state that already
// exists somewhere in the app. Nothing is a placeholder. Where a preference had
// no backing store before (UI click sound, vibration, reduce motion) the store
// was added at the point of use — src/ui.tsx for the click SFX and the
// reduce-motion CSS guard, src/haptics.ts for vibration — so flipping the
// switch here changes real behaviour rather than just a saved flag.
//
// Registered as the 'settings' View in src/App.tsx; reached from the hub
// NavDock / PlayerHUD gear and from the profile hub top nav.

import React, { useCallback, useEffect, useState } from 'react';
import { getMyProfileApi, type Profile } from './profiles';
import { RANKED_UNAVAILABLE_MESSAGE } from './ranked-client';
import { color as C, font as F, surface as SURF, edge as EDGE, depth as DEPTH } from './theme';
import { engravedPanel } from './ui';
import { hapticsSupported, HAPTICS_KEY, Haptics } from './haptics';
import {
  ArrowLeft, Check, Copy, Book, Warning, Trash, User, Globe, Swords,
  Settings as SettingsIcon, SoundOn, Monitor,
} from './icons';

// ── Preference keys ─────────────────────────────────────────────────────────
// These are the exact localStorage keys the rest of the app already reads. The
// settings page is a second writer, never a new source of truth.
export const PREF_KEYS = {
  /** Master mute. Written by the hub HUD / rulebook mute buttons; mutes every
   *  <audio>/<video> on those screens and gates the UI click SFX. */
  masterMute: 'ocva.muted',
  /** Menu background track (BgMusic storageKey for <MenuMusic />). */
  menuMusic: 'musicMuted',
  /** Battle background track (BgMusic storageKey for <BattleMusic />). */
  battleMusic: 'battleMuted',
  /** UI click sound, consumed by the global pointerdown handler in src/ui.tsx. */
  clickSfx: 'ocva.clickSfx',
  /** Vibration, consumed by src/haptics.ts. */
  haptics: HAPTICS_KEY,
  /** In-app reduce-motion, applied as data-reduced-motion on <html>. */
  reduceMotion: 'ocva.reduceMotion',
  /** Default matchmaking mode on the hub. */
  /** Kept only so "clear local data" still removes the legacy ranked prefs. */
  queueMode: 'ocva.queueMode',
  rankedRegion: 'rankedRegion',
  /** "Install the app" prompt snooze (7 days). */
  installDismissed: 'mmtcg.installDismissedUntil',
} as const;

/** Fired whenever a preference changes so live components can re-read it. */
export const PREFS_EVENT = 'ocva:prefs-changed';

// Flags are stored as '1' / '0' strings to match how the app already writes
// them (BgMusic, the hub mute button, etc.), NOT as JSON.
function readFlag(key: string, whenMissing: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return whenMissing;
    return v === '1';
  } catch { return whenMissing; }
}
function writeFlag(key: string, on: boolean): void {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* storage blocked */ }
}
function readStr(key: string, fallback: string): string {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

function announce(): void {
  try { window.dispatchEvent(new CustomEvent(PREFS_EVENT)); } catch { /* noop */ }
}

/**
 * Stamp the in-app reduce-motion preference onto <html>. The CSS guard lives in
 * src/ui.tsx keyed on `:root[data-reduced-motion="1"]` and mirrors the
 * `prefers-reduced-motion: reduce` block already in index.html, so the two
 * paths (OS setting / in-app setting) neutralise exactly the same declarations.
 */
export function applyReducedMotion(): void {
  if (typeof document === 'undefined') return;
  const on = readFlag(PREF_KEYS.reduceMotion, false);
  if (on) document.documentElement.setAttribute('data-reduced-motion', '1');
  else document.documentElement.removeAttribute('data-reduced-motion');
}

// Apply at import time so the flag is live from the first paint, not only once
// the settings screen has been visited.
applyReducedMotion();

// Mirrors package.json "version". Kept as a literal because the dev server is
// long-running and changing vite.config.ts (define:) would force a restart.
const APP_VERSION = '0.1.0';
const APP_DOMAIN = 'ocva.online';

const S = {
  bg: '#07060f',
  text: C.textHi,
  text2: C.textMid,
  muted: C.textLo,
  gold: C.gold,
  goldHi: C.goldHi,
  danger: '#FF616F',
  ok: '#4ad58e',
  hair: 'rgba(217,180,90,0.18)',
};
const SERIF = '"Cinzel", "Times New Roman", serif';

// ── Primitives ──────────────────────────────────────────────────────────────

/** Small-caps section eyebrow + engraved rule. */
function SectionHead({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '22px 2px 10px' }}>
      <span aria-hidden style={{ color: S.gold, display: 'inline-flex' }}>{icon}</span>
      <h2 style={{
        margin: 0, fontFamily: SERIF, fontWeight: 800, fontSize: 13,
        letterSpacing: '0.24em', textTransform: 'uppercase', color: S.goldHi,
      }}>{label}</h2>
      <span aria-hidden style={{
        flex: 1, height: 1,
        background: `linear-gradient(90deg, ${S.hair}, transparent)`,
      }} />
    </div>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ ...engravedPanel(), overflow: 'hidden' }}>
      {children}
    </div>
  );
}

/** One settings row: title + helper copy on the left, control on the right. */
function Row({
  title, hint, control, last, danger,
}: {
  title: string; hint?: React.ReactNode; control: React.ReactNode; last?: boolean; danger?: boolean;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      padding: '13px 15px', minHeight: 56,
      borderBottom: last ? 'none' : `1px solid rgba(217,180,90,0.10)`,
    }}>
      <div style={{ flex: '1 1 190px', minWidth: 0 }}>
        <div style={{
          fontFamily: F.body, fontWeight: 700, fontSize: 14,
          color: danger ? S.danger : S.text, letterSpacing: '0.01em',
        }}>{title}</div>
        {hint && <div style={{ fontSize: 12, lineHeight: 1.45, color: S.text2, marginTop: 3 }}>{hint}</div>}
      </div>
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 }}>{control}</div>
    </div>
  );
}

/** Forged toggle switch. 44px tall hit area on every pointer type. */
function Switch({ on, onChange, label }: { on: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} title={label}
      onClick={() => { Haptics.tap(); onChange(!on); }}
      style={{
        display: 'grid', placeItems: 'center',
        width: 66, height: 44, minHeight: 44, padding: 0,
        background: 'none', border: 'none', cursor: 'pointer',
      }}
    >
      <span aria-hidden style={{
        position: 'relative', display: 'block', width: 54, height: 30, borderRadius: 999,
        background: on ? SURF.goldPlate : SURF.obsidianWell,
        border: `1px solid ${on ? EDGE.bronze : 'rgba(217,180,90,0.22)'}`,
        boxShadow: on
          ? `${EDGE.bevel}, ${DEPTH.goldGlow}`
          : 'inset 0 2px 5px rgba(0,0,0,0.55)',
        transition: 'background 180ms ease, border-color 180ms ease, box-shadow 180ms ease',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: on ? 26 : 2,
          width: 24, height: 24, borderRadius: '50%',
          background: on
            ? 'linear-gradient(180deg,#fffaf0,#e8dcc0)'
            : 'linear-gradient(180deg,#3a3550,#232036)',
          boxShadow: '0 2px 5px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.35)',
          transition: 'left 180ms cubic-bezier(0.2,0.8,0.2,1), background 180ms ease',
        }} />
      </span>
    </button>
  );
}

/** Segmented two/three-way choice, forged-plate styling. */
function Segmented<T extends string>({
  value, options, onChange, label,
}: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} style={{
      display: 'flex', gap: 3, padding: 3, borderRadius: 10,
      background: SURF.obsidianWell, border: `1px solid rgba(217,180,90,0.20)`,
      boxShadow: 'inset 0 2px 5px rgba(0,0,0,0.5)',
    }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value} type="button" role="radio" aria-checked={active}
            onClick={() => { Haptics.tap(); onChange(o.value); }}
            style={{
              minHeight: 44, padding: '0 14px', borderRadius: 8, cursor: 'pointer',
              fontFamily: F.body, fontWeight: 800, fontSize: 12, letterSpacing: '0.08em',
              textTransform: 'uppercase', whiteSpace: 'nowrap',
              background: active ? SURF.goldPlate : 'transparent',
              color: active ? '#22190a' : S.text2,
              border: `1px solid ${active ? EDGE.bronze : 'transparent'}`,
              boxShadow: active ? EDGE.bevel : 'none',
              transition: 'background 160ms ease, color 160ms ease',
            }}
          >{o.label}</button>
        );
      })}
    </div>
  );
}

/** Obsidian action button used for the non-toggle rows. */
function RowButton({
  children, onClick, tone = 'neutral', title,
}: { children: React.ReactNode; onClick: () => void; tone?: 'neutral' | 'danger'; title?: string }) {
  const danger = tone === 'danger';
  return (
    <button
      type="button" onClick={onClick} title={title}
      className="ova-plate ova-plate--obsidian"
      style={{
        minHeight: 44, padding: '10px 16px', fontSize: 12, letterSpacing: '0.1em',
        fontFamily: F.body, borderRadius: 10,
        ...(danger ? { color: S.danger, borderColor: 'rgba(255,97,111,0.45)' } : {}),
      }}
    >{children}</button>
  );
}

// ── Destructive confirmation ────────────────────────────────────────────────
// Two deliberate steps: open the dialog, then tick "I understand" before the
// confirm button is enabled. A stray tap cannot wipe anything.
function ClearDataDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const [ack, setAck] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 120, padding: 18,
        background: 'rgba(4,4,12,0.72)', backdropFilter: 'blur(5px)',
        display: 'grid', placeItems: 'center', overflowY: 'auto',
      }}
    >
      <div
        role="dialog" aria-modal="true" aria-labelledby="ocva-cleardata-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          ...engravedPanel(true), width: 'min(440px, 100%)', padding: 20,
          borderColor: 'rgba(255,97,111,0.35)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span aria-hidden style={{ color: S.danger, display: 'inline-flex' }}><Warning size={18} /></span>
          <h2 id="ocva-cleardata-title" style={{
            margin: 0, fontFamily: SERIF, fontWeight: 800, fontSize: 19, color: S.danger,
          }}>Clear local data?</h2>
        </div>
        <p style={{ margin: '0 0 10px', fontSize: 13.5, lineHeight: 1.55, color: S.text2 }}>
          This erases everything this browser has stored for the Arena and reloads the page.
          It removes:
        </p>
        <ul style={{ margin: '0 0 12px', paddingLeft: 20, fontSize: 13, lineHeight: 1.7, color: S.text2 }}>
          <li>your signed-in identity on this device (you will need to sign in again);</li>
          <li>cached match credentials for any match you are seated in;</li>
          <li>every preference on this page — mute flags, reduce motion;</li>
          <li>dismissed prompts and locally-stored daily-challenge results.</li>
        </ul>
        <p style={{ margin: '0 0 14px', fontSize: 12.5, lineHeight: 1.55, color: S.muted }}>
          Your profile, saved decks and match history live on the server and are
          <strong style={{ color: S.text2 }}> not</strong> affected.
        </p>

        <label style={{
          display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, cursor: 'pointer',
          padding: '8px 10px', borderRadius: 10, background: SURF.obsidianWell,
          border: `1px solid ${S.hair}`, fontSize: 13, color: S.text,
        }}>
          <input
            type="checkbox" checked={ack} onChange={(e) => setAck(e.currentTarget.checked)}
            style={{ width: 18, height: 18, accentColor: S.danger, cursor: 'pointer' }}
          />
          I understand this cannot be undone.
        </label>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16, flexWrap: 'wrap' }}>
          <button
            type="button" onClick={onCancel} className="ova-plate ova-plate--obsidian"
            style={{ minHeight: 44, padding: '11px 18px', fontSize: 12.5, fontFamily: F.body }}
          >CANCEL</button>
          <button
            type="button" onClick={onConfirm} disabled={!ack}
            style={{
              minHeight: 44, padding: '11px 20px', borderRadius: 10, cursor: ack ? 'pointer' : 'not-allowed',
              fontFamily: F.body, fontWeight: 800, fontSize: 12.5, letterSpacing: '0.1em',
              background: ack ? 'linear-gradient(180deg,#ff8a94,#e04452)' : 'rgba(90,60,66,0.4)',
              color: ack ? '#2a0508' : 'rgba(255,255,255,0.35)',
              border: `1px solid ${ack ? '#b8323f' : 'rgba(255,255,255,0.08)'}`,
              boxShadow: ack ? EDGE.bevel : 'none',
            }}
          >CLEAR EVERYTHING</button>
        </div>
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export function SettingsPage({
  myName, onBack, onRules, onLogout, onEditProfile,
}: {
  myName: string;
  onBack: () => void;
  onRules: () => void;
  onLogout: () => void;
  onEditProfile: () => void;
}) {
  // Audio
  const [masterMute, setMasterMute] = useState(() => readFlag(PREF_KEYS.masterMute, false));
  const [menuMusic, setMenuMusic] = useState(() => !readFlag(PREF_KEYS.menuMusic, false));
  const [battleMusic, setBattleMusic] = useState(() => !readFlag(PREF_KEYS.battleMusic, false));
  const [clickSfx, setClickSfx] = useState(() => readFlag(PREF_KEYS.clickSfx, true));
  const [haptics, setHaptics] = useState(() => readFlag(PREF_KEYS.haptics, true));
  // Display
  const [reduceMotion, setReduceMotion] = useState(() => readFlag(PREF_KEYS.reduceMotion, false));
  // Gameplay
  // Account
  const [prof, setProf] = useState<Profile | null>(null);
  const [copied, setCopied] = useState(false);
  // Data
  const [confirmClear, setConfirmClear] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const canVibrate = hapticsSupported();
  const osReducedMotion = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Settings always shows the SIGNED-IN player, and the wallet row needs an
  // address — `GET /api/profiles/me` is the only route that returns one.
  useEffect(() => {
    let alive = true;
    getMyProfileApi().then((p) => { if (alive) setProf(p); }).catch(() => {});
    return () => { alive = false; };
  }, [myName]);

  // The floating mute stud writes musicMuted/battleMuted directly, and another
  // tab can write any of these. Re-read so the switches never show a stale value.
  useEffect(() => {
    const sync = () => {
      setMasterMute(readFlag(PREF_KEYS.masterMute, false));
      setMenuMusic(!readFlag(PREF_KEYS.menuMusic, false));
      setBattleMusic(!readFlag(PREF_KEYS.battleMusic, false));
      setClickSfx(readFlag(PREF_KEYS.clickSfx, true));
      setHaptics(readFlag(PREF_KEYS.haptics, true));
      setReduceMotion(readFlag(PREF_KEYS.reduceMotion, false));
    };
    window.addEventListener(PREFS_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(PREFS_EVENT, sync); window.removeEventListener('storage', sync); };
  }, []);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2200);
  }, []);

  // ── Writers. Each one persists, then tells live listeners to re-read. ──
  const setFlagPref = useCallback((key: string, on: boolean) => {
    writeFlag(key, on);
    announce();
  }, []);

  function toggleMasterMute(next: boolean) {
    setMasterMute(next);
    setFlagPref(PREF_KEYS.masterMute, next);
    // Match what the hub / rulebook mute buttons already do so the effect is
    // immediate on whatever media is mounted right now.
    try {
      document.querySelectorAll('audio,video').forEach((a) => { (a as HTMLMediaElement).muted = next; });
    } catch { /* noop */ }
  }
  function toggleMenuMusic(next: boolean) {
    setMenuMusic(next);
    setFlagPref(PREF_KEYS.menuMusic, !next); // stored as *muted*
  }
  function toggleBattleMusic(next: boolean) {
    setBattleMusic(next);
    setFlagPref(PREF_KEYS.battleMusic, !next); // stored as *muted*
  }
  function toggleClickSfx(next: boolean) { setClickSfx(next); setFlagPref(PREF_KEYS.clickSfx, next); }
  function toggleHaptics(next: boolean) {
    setHaptics(next);
    setFlagPref(PREF_KEYS.haptics, next);
    if (next) Haptics.play();
  }
  function toggleReduceMotion(next: boolean) {
    setReduceMotion(next);
    writeFlag(PREF_KEYS.reduceMotion, next);
    applyReducedMotion();
    announce();
  }
  async function copyWallet() {
    if (!prof?.walletAddress) return;
    try {
      await navigator.clipboard.writeText(prof.walletAddress);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { flash('Could not copy — long-press the address instead.'); }
  }

  function resetHints() {
    try { localStorage.removeItem(PREF_KEYS.installDismissed); } catch {}
    announce();
    flash('Dismissed prompts will show again.');
  }

  function clearLocalData() {
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
    try { window.location.hash = ''; } catch {}
    window.location.reload();
  }

  const walletAddr = prof?.walletAddress ?? null;
  const walletNet = walletAddr ? (walletAddr.startsWith('0x') ? 'Robinhood Chain' : 'Solana') : null;

  return (
    <div style={{
      position: 'fixed', inset: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch',
      background: S.bg, color: S.text, fontFamily: F.body,
    }}>
      {/* Atmosphere */}
      <div aria-hidden style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0,
        background:
          'radial-gradient(70% 45% at 50% 0%, rgba(124,92,255,0.10), transparent 68%),'
          + 'radial-gradient(90% 60% at 50% 108%, rgba(217,180,90,0.07), transparent 66%)',
      }} />

      {/* Header */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 3,
        display: 'flex', alignItems: 'center', gap: 12,
        padding: 'calc(10px + env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) 10px max(12px, env(safe-area-inset-left))',
        background: 'linear-gradient(180deg, rgba(7,6,15,0.97) 60%, rgba(7,6,15,0.0))',
        borderBottom: `1px solid ${S.hair}`,
      }}>
        <button
          type="button" onClick={onBack} aria-label="Back" title="Back"
          className="ova-plate ova-plate--obsidian"
          style={{ minHeight: 44, minWidth: 44, padding: '10px 14px', fontSize: 12, fontFamily: F.body }}
        ><ArrowLeft size={16} /></button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <span aria-hidden style={{ color: S.gold, display: 'inline-flex' }}><SettingsIcon size={18} /></span>
          <h1 style={{
            margin: 0, fontFamily: SERIF, fontWeight: 800, fontSize: 19,
            letterSpacing: '0.16em', textTransform: 'uppercase', color: S.goldHi,
            textShadow: '0 0 18px rgba(217,180,90,0.35)',
          }}>Settings</h1>
        </div>
      </header>

      <main style={{
        position: 'relative', zIndex: 1,
        maxWidth: 760, margin: '0 auto',
        padding: '4px max(12px, env(safe-area-inset-right)) calc(48px + env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left))',
      }}>
        {/* ── Audio ─────────────────────────────────────────────────────── */}
        <SectionHead icon={<SoundOn size={15} />} label="Audio & Feel" />
        <Section>
          <Row
            title="All sound"
            hint="Master switch. Silences music and effects everywhere."
            control={<Switch label="All sound" on={!masterMute} onChange={(on) => toggleMasterMute(!on)} />}
          />
          <Row
            title="Menu music"
            hint="The background track on the hub, lobby, rulebook and boosters."
            control={<Switch label="Menu music" on={menuMusic} onChange={toggleMenuMusic} />}
          />
          <Row
            title="Battle music"
            hint="The background track that plays once a match begins."
            control={<Switch label="Battle music" on={battleMusic} onChange={toggleBattleMusic} />}
          />
          <Row
            title="UI click sound"
            hint="Short click when you press a menu button."
            control={<Switch label="UI click sound" on={clickSfx} onChange={toggleClickSfx} />}
            last={!canVibrate}
          />
          {canVibrate && (
            <Row
              title="Vibration"
              hint="Haptic feedback for card plays, attacks and turn changes."
              control={<Switch label="Vibration" on={haptics} onChange={toggleHaptics} />}
              last
            />
          )}
        </Section>

        {/* ── Display ───────────────────────────────────────────────────── */}
        <SectionHead icon={<Monitor size={15} />} label="Display" />
        <Section>
          <Row
            title="Reduce motion"
            hint={osReducedMotion
              ? 'Your device already requests reduced motion, so this is on regardless.'
              : 'Neutralises card-flight, glow pulses, hover lifts and screen transitions.'}
            control={<Switch label="Reduce motion" on={reduceMotion} onChange={toggleReduceMotion} />}
            last
          />
        </Section>

        {/* ── Gameplay ──────────────────────────────────────────────────── */}
        <SectionHead icon={<Swords size={15} />} label="Gameplay" />
        <Section>
          {/* The queue-mode and region preferences configured `/api/ranked/*`,
              which does not exist on this backend. Rather than keep dead
              switches that quietly do nothing, say what is actually true. */}
          <Row
            title="Ranked ladder"
            hint={RANKED_UNAVAILABLE_MESSAGE}
            control={<span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1, color: S.muted }}>COMING SOON</span>}
          />

          <Row
            title="Replay the tutorial"
            hint="Opens the interactive rulebook, including the tutorial video."
            control={<RowButton onClick={onRules}><Book size={14} /> RULEBOOK</RowButton>}
          />
          <Row
            title="Reset dismissed prompts"
            hint="Brings back the “install the app” prompt you snoozed."
            control={<RowButton onClick={resetHints}>RESET</RowButton>}
            last
          />
        </Section>

        {/* ── Account ───────────────────────────────────────────────────── */}
        <SectionHead icon={<User size={15} />} label="Account" />
        <Section>
          <Row
            title="Display name"
            hint={
              <>
                <span style={{ color: S.text, fontWeight: 700 }}>{prof?.name ?? myName}</span>
                <span style={{ display: 'block', marginTop: 2 }}>
                  Your account is your wallet; this is just how other players see you.
                  Edit opens your profile, where you can change your name, avatar and bio.
                </span>
              </>
            }
            control={<RowButton onClick={onEditProfile}>EDIT PROFILE</RowButton>}
          />
          <Row
            title="Wallet"
            hint={walletAddr
              ? (
                <span style={{
                  fontFamily: F.mono, fontSize: 12, color: S.text,
                  wordBreak: 'break-all', display: 'block',
                }}>
                  {walletAddr}
                  <span style={{ color: S.muted, fontFamily: F.body }}> · {walletNet}</span>
                </span>
              )
              : 'No wallet linked to this profile.'}
            control={walletAddr
              ? (
                <RowButton onClick={copyWallet} title="Copy address">
                  {copied ? <><Check size={14} /> COPIED</> : <><Copy size={14} /> COPY</>}
                </RowButton>
              )
              : <span style={{ fontSize: 12, color: S.muted }}>—</span>}
          />
          <Row
            title="Sign out"
            hint="Disconnects this device and returns you to the sign-in screen."
            danger
            control={<RowButton tone="danger" onClick={onLogout}>SIGN OUT</RowButton>}
            last
          />
        </Section>

        {/* ── Data ──────────────────────────────────────────────────────── */}
        <SectionHead icon={<Trash size={15} />} label="Data" />
        <Section>
          <Row
            title="Clear local data"
            danger
            hint="Wipes this browser's stored identity, cached match credentials, preferences and dismissed prompts. Decks, collection and rank are stored on the server and stay untouched."
            control={<RowButton tone="danger" onClick={() => setConfirmClear(true)}>CLEAR…</RowButton>}
            last
          />
        </Section>

        {/* ── About ─────────────────────────────────────────────────────── */}
        <SectionHead icon={<Globe size={15} />} label="About" />
        <Section>
          <Row
            title="On-Chain Virtual Arena"
            hint={<a
              href={`https://${APP_DOMAIN}`} target="_blank" rel="noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', minHeight: 44,
                color: S.goldHi, textDecoration: 'none',
                borderBottom: `1px solid ${S.hair}`,
              }}
            >{APP_DOMAIN}</a>}
            control={<span style={{
              fontFamily: F.mono, fontSize: 12, color: S.muted,
              padding: '6px 10px', borderRadius: 8,
              background: SURF.obsidianWell, border: `1px solid ${S.hair}`,
            }}>v{APP_VERSION} · {import.meta.env.MODE}</span>}
          />
          <Row
            title="Rulebook"
            hint="Every rule, keyword and turn structure in one place."
            control={<RowButton onClick={onRules}><Book size={14} /> OPEN</RowButton>}
            last
          />
        </Section>

        <p style={{
          margin: '20px 2px 0', fontSize: 11.5, lineHeight: 1.6, color: S.muted, textAlign: 'center',
        }}>
          Preferences are stored on this device only.
        </p>
      </main>

      {toast && (
        <div role="status" style={{
          position: 'fixed', left: '50%', transform: 'translateX(-50%)',
          bottom: 'calc(18px + env(safe-area-inset-bottom))', zIndex: 130,
          padding: '11px 16px', borderRadius: 10, maxWidth: 'calc(100vw - 32px)',
          background: SURF.obsidianRaised, border: `1px solid ${S.hair}`,
          boxShadow: DEPTH.panel, fontSize: 13, color: S.text,
        }}>{toast}</div>
      )}

      {confirmClear && (
        <ClearDataDialog onCancel={() => setConfirmClear(false)} onConfirm={clearLocalData} />
      )}
    </div>
  );
}

export default SettingsPage;

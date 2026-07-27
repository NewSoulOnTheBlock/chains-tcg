// src/App.tsx
// Online lobby + multiplayer client for Chains TCG.
// Flow: Login -> Lobby (create/join match) -> Waiting room -> Game.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Client } from 'boardgame.io/react';
import { SocketIO } from 'boardgame.io/multiplayer';
import { LobbyClient } from 'boardgame.io/client';
import { Plaza } from './Plaza';
import { ChainsTCG } from './Game';
import { ChainsBoard } from './Board';
import { CARDS, COLOR_META, COLORS, BUILDABLE_CARDS, validateDeck, DECK_SIZE, MAX_COPIES_NONBASIC, isBasicNode, type Color, type CardType, type CardDef, type DeckIssue, type DeckValidation } from './cards';
import {
  listProfilesApi, getProfileApi, getProfileByWalletApi, upsertProfileApi, updateProfileApi, getLibraryApi,
  getDeckApi, saveDeckApi, formatRecord, type Profile, type LibraryCard,
  listDecksApi, createDeckApi, updateDeckApi, deleteDeckApi, activateDeckApi, type DeckEntry,
  createChallengeApi, listIncomingChallengesApi, listOutgoingChallengesApi, respondChallengeApi, type Challenge,
} from './profiles';
import { connectSolanaWith, connectSolana, getSolanaWallet, detectSolanaWallets, connectRobinhoodChain, detectEvmWallet, shortAddr, type ConnectedWallet, type SolanaWalletKind } from './wallet';
import { color as C, font as F } from './theme';
import { Button as UIButton } from './ui';
import { CardHover, CardPreview } from './CardPreview';
import { RankedAPI, tierColors, rankLabel, type PublicRankedProfile, type LeaderboardEntry } from './ranked-client';
import { Connection } from '@solana/web3.js';
import { newMatchId, matchIdToHex } from './wager-program';
import {
  requestWagerIntent, depositCustodialWager,
} from './wager-custodial';
import { SoloClient } from './SoloClient';
import type { Difficulty } from './bot';
import type { SoloMode } from './SoloClient';
import { saveDailyResult, todayKey, todayBest } from './dailyChallenge';
import { BoostersPage } from './Boosters';
import { MasterquestPage } from './masterquest/MasterquestPage';
import { listOwnedSprotoGremlins, SPROTO_COLLECTION_MINT, type OwnedNft } from './nft-showcase';
import ShinyText, { ShinyBrand, ShinyButtonLabel } from './ShinyText';
// PixelTrail is lazy-loaded — it pulls in three + r3f + drei (~240KB
// gzipped), which we don't want in the in-game bundle. Loaded on demand
// only when the Landing screen mounts.
const PixelTrail = React.lazy(() => import('./PixelTrail'));
import SideRays from './SideRays';
import Iridescence from './Iridescence';

// ── Config ──────────────────────────────────────────────────────────────────
// Server base: in dev Vite proxies /games (lobby) and /socket.io to :8000.
// In prod the React build is served by the same Node server, so use same origin.
const SERVER_BASE = (import.meta.env.VITE_SERVER_BASE as string | undefined) ?? '';
const GAME_NAME = ChainsTCG.name!;
const COLOR_ORDER: Color[] = ['bnb', 'sol', 'eth', 'robinhood', 'base'];

const lobby = new LobbyClient({ server: SERVER_BASE || undefined });

// Lazy-init Solana connection (only used for wagered matches).
// We build a wrapper that transparently fails over to a public-RPC pool when
// the primary endpoint 403s or rate-limits — common when the build did not
// inject VITE_SOLANA_RPC (e.g. HELIUS_API_KEY unset in the deploy env).
let _solConn: Connection | null = null;
function solConn(): Connection {
  if (!_solConn) {
    const env = (import.meta.env.VITE_SOLANA_RPC as string | undefined) || '';
    const fallbacks = [
      'https://solana-rpc.publicnode.com',
      'https://solana-mainnet.public.blastapi.io',
      'https://solana.drpc.org',
      'https://api.mainnet-beta.solana.com',
    ];
    const candidates = [env, ...fallbacks].filter(Boolean) as string[];
    const conns = candidates.map(u => new Connection(u, 'confirmed'));
    const primary = conns[0];
    // Patch _rpcRequest on the primary so any 403/429/5xx auto-rotates.
    let idx = 0;
    const tryNext = async (method: string, args: any[]): Promise<any> => {
      let lastErr: any;
      for (let i = 0; i < conns.length; i++) {
        const c = conns[(idx + i) % conns.length];
        try {
          const res = await (c as any)._rpcRequestOriginal(method, args);
          if (res?.error && /401|403|forbidden|429|rate|invalid api key|unauthor/i.test(JSON.stringify(res.error))) {
            lastErr = new Error(JSON.stringify(res.error));
            continue;
          }
          if (i > 0) {
            idx = (idx + i) % conns.length;
            try { console.warn('[rpc] failover →', candidates[idx]); } catch {}
          }
          return res;
        } catch (e: any) {
          lastErr = e;
          if (!/401|403|forbidden|429|rate|invalid api key|unauthor|fetch|network|timeout/i.test(String(e?.message))) throw e;
        }
      }
      throw lastErr ?? new Error('all RPC endpoints failed');
    };
    for (const c of conns) {
      (c as any)._rpcRequestOriginal = (c as any)._rpcRequest.bind(c);
    }
    (primary as any)._rpcRequest = tryNext;
    _solConn = primary;
  }
  return _solConn;
}

// ── Responsive helper ──────────────────────────────────────────────────────
function useIsMobile(breakpoint = 720) {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.innerWidth <= breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = () => setM(mq.matches);
    onChange();
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, [breakpoint]);
  return m;
}

// ── Persistence helpers (sessionStorage so each tab can be a different player) ─
const sess = {
  get<T>(k: string, def: T): T { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) as T : def; } catch { return def; } },
  set(k: string, v: any) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k: string) { try { sessionStorage.removeItem(k); } catch {} },
};
/** Local (cross-tab, survives tab close) storage — used for identity + active seat
 *  so a player can rejoin an in-progress match after accidentally closing the tab. */
const local = {
  get<T>(k: string, def: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : def; } catch { return def; } },
  set(k: string, v: any) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k: string) { try { localStorage.removeItem(k); } catch {} },
};

type Seat = { matchID: string; playerID: string; credentials: string; playerName: string };

// ── Login screen ────────────────────────────────────────────────────────────
// ── Login screen (premium fantasy gateway) ──────────────────────────────────
const LOGIN_NAMES = [
  'MoonPepe', 'GasWizard', 'RuneKnight', 'ChainLord', 'SnowMage',
  'DegenPaladin', 'VoidPepe', 'CryptoWarden', 'ArcaneBull', 'MemeKing',
  'NodeShaman', 'AlphaSeer', 'PixelOracle', 'ShardSorcerer', 'FrogLord',
];

/** Gold interlocking geometric emblem for the login hero. */
function LoginEmblem({ size = 92 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden
      style={{ filter: 'drop-shadow(0 4px 16px rgba(0,0,0,0.65))' }}>
      <defs>
        <linearGradient id="ova-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe9a8" />
          <stop offset="0.5" stopColor="#d9b24a" />
          <stop offset="1" stopColor="#8a6a16" />
        </linearGradient>
      </defs>
      <path d="M50 6 L86 34 L86 50 L50 22 L14 50 L14 34 Z" fill="url(#ova-gold)" />
      <path d="M50 44 L86 72 L86 88 L50 60 L14 88 L14 72 Z" fill="url(#ova-gold)" opacity="0.9" />
      <path d="M50 33 L59 44 L50 55 L41 44 Z" fill="#a855f7" />
      <path d="M50 33 L59 44 L50 55 L41 44 Z" fill="none" stroke="#e9d5ff" strokeWidth="0.9" />
    </svg>
  );
}

/** Decorative, non-interactive TCG card used to frame the login hero (desktop only). */
function LoginDecoCard({ cardName, klass, cost, atk, def, hue, style }: {
  cardName: string; klass: string; cost: number; atk: number; def: number; hue: number;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{
      width: 150, height: 214, borderRadius: 12, padding: 8, position: 'relative',
      background: `linear-gradient(160deg, hsl(${hue} 45% 16%), hsl(${hue} 55% 8%))`,
      border: '1px solid rgba(212,175,55,0.55)',
      boxShadow: '0 26px 60px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)',
      color: '#e8e2d0', fontFamily: 'inherit',
      ...style,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{
          width: 22, height: 22, borderRadius: '50%', fontWeight: 900, fontSize: 12,
          background: 'linear-gradient(180deg,#ffe9a8,#b98f2b)', color: '#1a1408',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{cost}</div>
      </div>
      <div style={{ marginTop: 6, fontSize: 10, fontWeight: 800, letterSpacing: 1, textAlign: 'center', color: '#f0e6c8' }}>{cardName}</div>
      <div style={{
        marginTop: 6, height: 96, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)',
        background: `radial-gradient(circle at 50% 38%, hsl(${hue} 70% 48% / .55), transparent 70%), linear-gradient(180deg, hsl(${hue} 40% 24%), hsl(${hue} 40% 10%))`,
      }} />
      <div style={{ marginTop: 6, fontSize: 8, fontWeight: 800, letterSpacing: 2, textAlign: 'center', color: '#c9a94a', textTransform: 'uppercase' }}>{klass}</div>
      <div style={{ position: 'absolute', left: 9, bottom: 6, fontSize: 12, fontWeight: 900, color: '#8fd0ff' }}>{atk}</div>
      <div style={{ position: 'absolute', right: 9, bottom: 6, fontSize: 12, fontWeight: 900, color: '#ff9a6a' }}>{def}</div>
    </div>
  );
}

function Login({ onLogin, onFirstTime }: {
  onLogin: (name: string) => void;
  onFirstTime: (wallet: ConnectedWallet) => void;
}) {
  const [name, setName] = useState(local.get<string>('lastName', '') || sess.get<string>('lastName', ''));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<'wallet' | 'email' | 'guest'>('wallet');
  const [notice, setNotice] = useState('');

  async function doConnect(kind: SolanaWalletKind) {
    setErr(''); setBusy(kind);
    try {
      const w = await connectSolanaWith(kind);
      const existing = await getProfileByWalletApi(w.address);
      if (existing) onLogin(existing.name);
      else onFirstTime(w);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setBusy(null); }
  }

  // Sign in with MetaMask on Robinhood Chain (EVM).
  async function doConnectRobinhood() {
    setErr(''); setBusy('robinhood');
    try {
      const w = await connectRobinhoodChain();
      const existing = await getProfileByWalletApi(w.address);
      if (existing) onLogin(existing.name);
      else onFirstTime(w);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setBusy(null); }
  }

  function randomName() {
    const pick = LOGIN_NAMES[Math.floor(Math.random() * LOGIN_NAMES.length)];
    const suffix = Math.floor(Math.random() * 9000) + 1000;
    setName(`${pick}${suffix}`);
  }

  // ── Login-screen theme music ─────────────────────────────────────────────
  // Browsers block autoplay-with-sound until the user interacts. Strategy:
  //   1. Mount the <audio>, attempt to play() immediately.
  //   2. If the promise rejects (autoplay policy), wait for the first
  //      pointerdown anywhere on the screen and retry.
  //   3. Always render a 🔊 / 🔇 toggle in the corner so the user can mute.
  // Mute preference persists across sessions via localStorage.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [muted, setMuted] = useState<boolean>(() => local.get<boolean>('loginMuted', false));
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.volume = 0.35;
    a.muted = muted;
    const tryPlay = () => {
      const p = a.play();
      if (p && typeof p.then === 'function') {
        p.then(() => setPlaying(true)).catch(() => {
          // autoplay blocked — arm a one-shot listener for the first
          // user interaction anywhere on the document.
          const unlock = () => {
            a.play().then(() => setPlaying(true)).catch(() => {});
            window.removeEventListener('pointerdown', unlock);
            window.removeEventListener('keydown', unlock);
          };
          window.addEventListener('pointerdown', unlock, { once: true });
          window.addEventListener('keydown', unlock, { once: true });
        });
      }
    };
    tryPlay();
    return () => {
      a.pause();
      setPlaying(false);
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = muted;
    local.set('loginMuted', muted);
  }, [muted]);

  const GOLD = '#D4AF37';
  const PURPLE = '#8A2BE2';
  const CYAN = '#4FD1C5';
  const mobile = useIsMobile();

  // ── Sign-in ───────────────────────────────────────────────────────────────
  // The splash art is a clean arena scene, so real controls sit on top: a
  // centered card on desktop, a bottom sheet on mobile (both over a cover image).
  {
    const evm = detectEvmWallet();
    const connecting = busy === 'robinhood';
    return (
      <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#07060f', fontFamily: F.body, color: '#F8F8F8' }}>
        <audio ref={audioRef} src="/login-theme.mp3" loop preload="auto" style={{ display: 'none' }} />
        <img src="/login-splash.png?v=2" alt="" draggable={false}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center', userSelect: 'none', zIndex: 0 }} />
        <div aria-hidden style={{ position: 'absolute', inset: 0, zIndex: 1, background: mobile
          ? 'linear-gradient(180deg, rgba(7,6,15,0.10) 0%, rgba(7,6,15,0.55) 55%, rgba(7,6,15,0.96) 100%)'
          : 'radial-gradient(55% 55% at 50% 66%, rgba(7,6,15,0.72), transparent 72%), linear-gradient(180deg, rgba(7,6,15,0.28), rgba(7,6,15,0.5))' }} />
        <button onClick={() => setMuted(m => !m)} aria-label={muted ? 'Unmute' : 'Mute'} style={{
          position: 'fixed', top: 'calc(12px + env(safe-area-inset-top))', right: 14, zIndex: 5, width: 40, height: 40, borderRadius: 20,
          background: 'rgba(10,5,30,0.6)', border: '1px solid rgba(212,175,55,0.45)', color: '#D4AF37', fontSize: 17, cursor: 'pointer',
        }}>{muted ? '🔇' : (playing ? '🔊' : '🎵')}</button>

        <div style={mobile ? {
          position: 'absolute', zIndex: 2, left: 0, right: 0, bottom: 0,
          padding: '18px 16px calc(20px + env(safe-area-inset-bottom))',
          display: 'flex', flexDirection: 'column', gap: 10,
        } : {
          position: 'absolute', zIndex: 2, left: '50%', top: '64%', transform: 'translate(-50%,-50%)',
          width: 'min(440px, calc(100vw - 40px))', display: 'flex', flexDirection: 'column', gap: 12,
          background: 'rgba(12,10,26,0.72)', border: '1px solid rgba(150,120,255,0.22)', borderRadius: 18,
          padding: 26, backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', boxShadow: '0 24px 70px rgba(0,0,0,0.55)',
        }}>
          <div style={{ textAlign: 'center', marginBottom: 2 }}>
            <div style={{ color: '#b794f6', letterSpacing: 3, fontWeight: 800, fontSize: 14 }}>‹ WELCOME BACK, CHAMPION ›</div>
            <div style={{ color: '#9a94ad', fontSize: 12, marginTop: 4 }}>Enter the Arena. Claim your victory.</div>
          </div>

          <button className="ocva-btn" disabled={!!busy}
            onClick={() => evm.installed ? doConnectRobinhood() : window.open('https://metamask.io/download/', '_blank', 'noopener')}
            style={{ width: '100%', padding: '15px', fontSize: 15, background: 'linear-gradient(135deg,#F6851B,#E2761B)', color: '#1a1408' }}>
            🦊 {connecting ? 'Connecting…' : (evm.installed ? `Sign in with ${evm.label}` : 'Install MetaMask')}
          </button>

          <div style={{ display: 'flex', gap: 8 }}>
            <input value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onLogin(name.trim()); }}
              placeholder="Guest name" inputMode="text"
              style={{ flex: 1, padding: '13px 14px', fontSize: 16, background: 'rgba(10,10,20,0.85)', color: '#fff', border: '1px solid rgba(150,120,255,0.35)', borderRadius: 12, outline: 'none' }} />
            <button className="ocva-btn ocva-btn--primary" onClick={() => name.trim() && onLogin(name.trim())} disabled={!name.trim()}
              style={{ padding: '0 18px', fontSize: 15 }}>Play</button>
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', gap: 18, marginTop: 2 }}>
            {(['Discord', 'Google', 'Apple', 'X'] as const).map(s => (
              <button key={s} onClick={() => setNotice(`${s} login is coming soon.`)}
                style={{ background: 'none', border: 'none', color: '#8f89a3', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}>{s}</button>
            ))}
          </div>
          {(err || notice) && (
            <div style={{ textAlign: 'center', fontSize: 12, color: err ? '#ffb8b8' : '#c9a94a', marginTop: 2 }}>{err || notice}</div>
          )}
        </div>
      </div>
    );
  }


}

function LoginStat(_: { label: string; value: string; color: string }) { return null; }
void LoginStat;

// ── First-time profile creation (after wallet connect with no existing profile) ─
const OVP = {
  bg: '#060711', panel: 'rgba(10,12,26,0.90)', input: '#090D19',
  gold: '#E5B84B', goldHi: '#FFD86A', purple: '#8E4DFF', violet: '#C45CFF',
  cyan: '#19D3D2', green: '#39E879', text: '#F4F2EA', muted: '#989BB0',
  border: 'rgba(229,184,75,0.35)',
};

/** One node in the Connect Wallet → Create Profile → Enter Arena stepper. */
function ProfileStep({ n, label, state }: { n: React.ReactNode; label: string; state: 'done' | 'active' | 'todo' }) {
  const ring = state === 'done' ? OVP.gold : state === 'active' ? OVP.purple : '#3a3f55';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <span aria-hidden style={{
        flex: '0 0 auto', width: 34, height: 34, borderRadius: '50%', display: 'grid', placeItems: 'center',
        border: `2px solid ${ring}`, background: state === 'active' ? OVP.purple : 'transparent',
        color: state === 'todo' ? OVP.muted : '#fff', fontWeight: 800, fontSize: 14,
        boxShadow: state === 'active' ? `0 0 16px ${OVP.purple}88` : 'none',
      }}>{n}</span>
      <span style={{ fontSize: 12, letterSpacing: 1.4, fontWeight: 700, color: state === 'todo' ? OVP.muted : OVP.text, whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  );
}

function FirstTimeProfile({ wallet, onCreated, onCancel }: {
  wallet: ConnectedWallet;
  onCreated: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [nameStatus, setNameStatus] = useState<'idle' | 'checking' | 'ok' | 'taken'>('idle');

  async function checkName() {
    const t = name.trim();
    if (t.length < 3) { setNameStatus('idle'); return; }
    setNameStatus('checking');
    try {
      const taken = await getProfileApi(t);
      setNameStatus(taken && (taken.walletAddress || '').toLowerCase() !== wallet.address.toLowerCase() ? 'taken' : 'ok');
    } catch { setNameStatus('idle'); }
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) { setErr('Image too large — must be under 5 MB.'); return; }
    const reader = new FileReader();
    reader.onload = () => setAvatarUrl(String(reader.result || ''));
    reader.readAsDataURL(f);
  }

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) { setErr('Pick a display name.'); return; }
    setErr(''); setSaving(true);
    try {
      // Make sure the name isn't already in use.
      const taken = await getProfileApi(trimmed);
      if (taken && (taken.walletAddress || '').toLowerCase() !== wallet.address.toLowerCase()) {
        setErr(`The name "${trimmed}" is already taken. Pick another.`);
        setSaving(false); return;
      }
      await upsertProfileApi(trimmed);
      await updateProfileApi(trimmed, {
        walletAddress: wallet.address,
        walletChain: wallet.chain,
        bio: bio.trim() || null,
        avatarUrl: avatarUrl.trim() || null,
      });
      onCreated(trimmed);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setSaving(false); }
  }

  const nameOk = name.trim().length >= 3 && name.trim().length <= 20;
  const canSubmit = nameOk && !saving;
  const FIELD: React.CSSProperties = {
    width: '100%', padding: '13px 14px', fontSize: 14, fontFamily: F.body,
    color: OVP.text, background: OVP.input, border: '1px solid #2a3350', borderRadius: 10,
  };
  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'auto', background: OVP.bg, color: OVP.text, fontFamily: F.body }}>
      <style>{`
        .ovp-field { transition: border-color .15s ease, box-shadow .15s ease; }
        .ovp-field:focus { outline: none; border-color: ${OVP.purple}; box-shadow: 0 0 0 3px rgba(142,77,255,0.28); }
        .ovp-field::placeholder { color: ${OVP.muted}; }
        .ovp-primary { transition: filter .15s ease, transform .1s ease, box-shadow .15s ease; }
        .ovp-primary:hover:not(:disabled) { filter: brightness(1.06); }
        .ovp-primary:active:not(:disabled) { transform: translateY(1px); }
        .ovp-link:hover { color: ${OVP.goldHi}; }
        .ovp-primary:focus-visible, .ovp-link:focus-visible, .ovp-upload:focus-within { outline: 2px solid ${OVP.goldHi}; outline-offset: 2px; }
        @media (max-width: 760px) { .ovp-grid { grid-template-columns: 1fr !important; } }
        @media (prefers-reduced-motion: reduce) { .ovp-field, .ovp-primary { transition: none; } }
      `}</style>

      {/* Arena backdrop */}
      <img src="/hub-bg.png?v=2" alt="" aria-hidden style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', objectFit: 'cover', zIndex: 0, filter: 'blur(2px)' }} />
      <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 1,
        background: 'radial-gradient(70% 60% at 50% 40%, rgba(6,7,17,0.72), rgba(6,7,17,0.94)), linear-gradient(180deg, rgba(6,7,17,0.6), rgba(6,7,17,0.92))' }} />

      <div style={{ position: 'relative', zIndex: 2, minHeight: '100dvh', display: 'flex', flexDirection: 'column', padding: '18px clamp(14px, 4vw, 40px) 28px' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <LoginEmblem size={38} />
            <div style={{ lineHeight: 1.05 }}>
              <div style={{ fontSize: 9, letterSpacing: 4, color: OVP.gold }}>ON-CHAIN</div>
              <div style={{ fontFamily: '"Cinzel", serif', fontWeight: 700, fontSize: 15, color: '#fff' }}>VIRTUAL ARENA</div>
            </div>
          </div>
          <button className="ovp-link" onClick={onCancel} style={{ background: 'none', border: 'none', color: OVP.muted, fontSize: 14, cursor: 'pointer', fontFamily: F.body }}>Cancel</button>
        </div>

        {/* stepper */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'clamp(8px,2vw,20px)', margin: '10px 0 22px', flexWrap: 'wrap' }}>
          <ProfileStep n="✓" label="CONNECT WALLET" state="done" />
          <span aria-hidden style={{ width: 'clamp(20px,6vw,80px)', height: 1, background: 'rgba(229,184,75,0.4)' }} />
          <ProfileStep n="2" label="CREATE PROFILE" state="active" />
          <span aria-hidden style={{ width: 'clamp(20px,6vw,80px)', height: 1, background: 'rgba(255,255,255,0.14)' }} />
          <ProfileStep n="3" label="ENTER ARENA" state="todo" />
        </div>

        {/* panel */}
        <div style={{
          position: 'relative', width: 'min(1100px, 100%)', margin: '0 auto',
          background: OVP.panel, border: `1px solid ${OVP.border}`, borderRadius: 16,
          padding: 'clamp(20px, 3vw, 34px)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
          boxShadow: '0 30px 90px rgba(0,0,0,0.6), 0 0 40px rgba(142,77,255,0.12)',
        }}>
          <div style={{ textAlign: 'center' }}>
            <h1 style={{ margin: 0, fontFamily: '"Cinzel", serif', fontWeight: 800, fontSize: 'clamp(26px, 4vw, 40px)', letterSpacing: 2,
              background: `linear-gradient(180deg, ${OVP.goldHi}, ${OVP.gold})`, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>CREATE YOUR PROFILE</h1>
            <div style={{ color: OVP.muted, fontSize: 14, marginTop: 8 }}>Choose how other players will see you in the arena.</div>
          </div>

          {/* wallet strip */}
          <div style={{ margin: '18px auto 0', maxWidth: 760, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, flexWrap: 'wrap',
            padding: '11px 18px', borderRadius: 10, background: 'rgba(25,211,210,0.06)', border: `1px solid ${OVP.cyan}55` }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span aria-hidden style={{ width: 9, height: 9, borderRadius: '50%', background: OVP.green, boxShadow: `0 0 8px ${OVP.green}` }} />
              <span style={{ color: '#cfe8df', fontSize: 13 }}>Wallet connected</span>
            </span>
            <b style={{ color: '#fff', fontFamily: 'ui-monospace, monospace', fontSize: 14 }}>{shortAddr(wallet.address)}</b>
            <span style={{ fontSize: 11, fontWeight: 800, color: OVP.cyan, background: 'rgba(25,211,210,0.12)', border: `1px solid ${OVP.cyan}66`, borderRadius: 6, padding: '2px 8px' }}>{wallet.chain.toUpperCase()}</span>
            <button className="ovp-link" onClick={onCancel} style={{ background: 'none', border: 'none', color: OVP.cyan, cursor: 'pointer', fontSize: 13, fontFamily: F.body }}>Change wallet</button>
          </div>

          {/* two-column form */}
          <div className="ovp-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) 1fr', gap: 'clamp(20px, 3vw, 40px)', marginTop: 26 }}>
            {/* left: avatar */}
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 12, letterSpacing: 3, color: OVP.gold, fontWeight: 800, marginBottom: 14 }}>PROFILE IMAGE</div>
              <div style={{ width: 180, height: 180, borderRadius: '50%', margin: '0 auto', overflow: 'hidden',
                border: `2px solid ${OVP.gold}`, boxShadow: '0 0 26px rgba(142,77,255,0.4)',
                background: 'radial-gradient(circle at 50% 38%, #3a2a6a, #14102a)', display: 'grid', placeItems: 'center' }}>
                {avatarUrl
                  ? <img src={avatarUrl} alt="Profile preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <span aria-hidden style={{ fontSize: 66, color: OVP.violet }}>👤</span>}
              </div>
              <label className="ovp-upload" style={{ display: 'block', marginTop: 16, padding: '12px', borderRadius: 9,
                background: 'rgba(9,13,25,0.85)', border: `1px solid ${OVP.gold}66`, color: OVP.text, fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>
                ⬆ UPLOAD IMAGE
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={onPickFile} style={{ display: 'none' }} aria-label="Upload profile image" />
              </label>
              {avatarUrl && (
                <button onClick={() => setAvatarUrl('')} style={{ marginTop: 8, background: 'none', border: 'none', color: OVP.muted, cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}>Remove image</button>
              )}
              <div style={{ color: OVP.muted, fontSize: 12, margin: '12px 0 6px' }}>or</div>
              <label htmlFor="ovp-img-url" style={{ display: 'block', fontSize: 11, letterSpacing: 2, color: OVP.muted, fontWeight: 700, marginBottom: 6 }}>IMAGE URL</label>
              <input id="ovp-img-url" className="ovp-field" value={avatarUrl} onChange={e => setAvatarUrl(e.target.value)} placeholder="Paste image URL" style={FIELD} />
              <div style={{ color: OVP.muted, fontSize: 11, marginTop: 8 }}>PNG, JPG or WebP · Max 5 MB</div>
            </div>

            {/* right: fields */}
            <div>
              <label htmlFor="ovp-name" style={{ display: 'block', fontSize: 12, letterSpacing: 2, color: '#cdd2e2', fontWeight: 800 }}>DISPLAY NAME <span style={{ color: OVP.violet }}>*</span></label>
              <input id="ovp-name" className="ovp-field" value={name} autoFocus maxLength={20}
                onChange={e => { setName(e.target.value); setNameStatus('idle'); }}
                onBlur={checkName}
                placeholder="Enter your display name" style={{ ...FIELD, fontSize: 16, marginTop: 6 }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                <span style={{ fontSize: 12, color: OVP.muted }}>3–20 characters</span>
                <button className="ovp-link" onClick={checkName} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontFamily: F.body,
                  color: nameStatus === 'ok' ? OVP.green : nameStatus === 'taken' ? '#ff6b6b' : OVP.muted }}>
                  {nameStatus === 'checking' ? '… Checking' : nameStatus === 'ok' ? '✓ Available' : nameStatus === 'taken' ? '✗ Taken' : '◇ Check availability'}
                </button>
              </div>

              <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
                <label htmlFor="ovp-bio" style={{ fontSize: 12, letterSpacing: 2, color: '#cdd2e2', fontWeight: 800 }}>BIO</label>
                <span style={{ fontSize: 10, color: OVP.muted, border: '1px solid #2a3350', borderRadius: 5, padding: '2px 7px', letterSpacing: 1 }}>OPTIONAL</span>
              </div>
              <textarea id="ovp-bio" className="ovp-field" value={bio} onChange={e => setBio(e.target.value.slice(0, 500))} rows={6}
                placeholder="Tell the arena about yourself..." style={{ ...FIELD, marginTop: 6, minHeight: 150, resize: 'vertical', fontFamily: F.body }} />
              <div style={{ textAlign: 'right', fontSize: 11, color: OVP.muted, marginTop: 2 }}>{bio.length} / 500</div>
            </div>
          </div>

          {err && (
            <div role="alert" style={{ marginTop: 16, padding: '10px 14px', borderRadius: 8,
              background: 'rgba(255,107,107,0.1)', border: '1px solid rgba(255,107,107,0.45)', color: '#ffb4b4', fontSize: 13 }}>{err}</div>
          )}

          {/* footer */}
          <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: OVP.muted, fontSize: 13 }}>
              <span aria-hidden style={{ color: OVP.purple }}>🛡</span> You can update your profile later in Settings.
            </div>
            <button className="ovp-primary" onClick={create} disabled={!canSubmit} style={{
              padding: '16px 30px', borderRadius: 10, border: '1px solid #8a6d24', cursor: canSubmit ? 'pointer' : 'not-allowed',
              background: canSubmit ? `linear-gradient(180deg, ${OVP.goldHi}, #c69533)` : 'rgba(120,100,40,0.4)',
              color: '#1a1408', fontWeight: 900, fontSize: 15, letterSpacing: 1, fontFamily: '"Cinzel", serif',
              boxShadow: canSubmit ? '0 8px 24px -6px rgba(229,184,75,0.6)' : 'none',
            }}>⚔ {saving ? 'CREATING PROFILE…' : 'CREATE PROFILE & ENTER ARENA'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Background music player (used for menu + battle tracks) ────────────────
function BgMusic({ src, storageKey }: { src: string; storageKey: string }) {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [muted, setMuted] = useState<boolean>(() => {
    try { return localStorage.getItem(storageKey) === '1'; } catch { return false; }
  });

  useEffect(() => {
    const a = audioRef.current; if (!a) return;
    a.volume = 0.35;
    a.muted = muted;
    a.play().catch(() => { /* autoplay blocked until user gesture */ });
  }, [muted]);

  useEffect(() => {
    const kick = () => { audioRef.current?.play().catch(() => {}); };
    window.addEventListener('pointerdown', kick, { once: true });
    return () => window.removeEventListener('pointerdown', kick);
  }, []);

  function toggle() {
    setMuted(m => {
      const next = !m;
      try { localStorage.setItem(storageKey, next ? '1' : '0'); } catch {}
      return next;
    });
  }

  return (
    <>
      <audio ref={audioRef} src={src} loop preload="auto" />
      <button
        onClick={toggle}
        title={muted ? 'Unmute music' : 'Mute music'}
        style={{
          position: 'fixed', right: 14, bottom: 14, zIndex: 1000,
          width: 44, height: 44, borderRadius: '50%',
          background: 'rgba(20,20,20,0.75)', color: '#fff',
          border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
          fontSize: 18, backdropFilter: 'blur(6px)',
          boxShadow: '0 4px 14px rgba(0,0,0,0.6)',
        }}
      >{muted ? '🔇' : '🔊'}</button>
    </>
  );
}

function MenuMusic()   { return <BgMusic src="/menu-music.mp3?v=2"   storageKey="musicMuted" />; }
function BattleMusic() { return <BgMusic src="/battle-music.mp3" storageKey="battleMuted" />; }

// ── Rules page (Interactive Rulebook) ──────────────────────────────────────
const RULES_TOKENS = {
  bg: '#050514',
  panel: 'rgba(20,20,40,0.85)',
  panelHi: 'rgba(28,22,58,0.92)',
  border: 'rgba(212,175,55,0.32)',
  borderSoft: 'rgba(255,255,255,0.08)',
  gold: '#D4AF37',
  goldGlow: 'rgba(212,175,55,0.55)',
  purple: '#8A2BE2',
  purpleSoft: 'rgba(138,43,226,0.55)',
  blue: '#4A90E2',
  red: '#D94B4B',
  green: '#4ad58e',
  text: '#ece1c7',
  mute: '#9e9382',
};
const RULES_FONT = "'Inter', 'Geist', 'Satoshi', system-ui, -apple-system, sans-serif";
const RULES_HEAD = '"Cinzel", "Times New Roman", serif';

type RulesSectionId = 'goal' | 'setup' | 'cards' | 'gas' | 'turn' | 'advanced' | 'example' | 'cheatsheet';

const RULES_NAV: { id: RulesSectionId; label: string; icon: string }[] = [
  { id: 'goal',       label: 'Goal',           icon: '🏆' },
  { id: 'setup',      label: 'Setup',          icon: '⚔️' },
  { id: 'cards',      label: 'Card Types',     icon: '🃏' },
  { id: 'gas',        label: 'Gas System',     icon: '⛽' },
  { id: 'turn',       label: 'Turn Order',     icon: '🔄' },
  { id: 'advanced',   label: 'Advanced',       icon: '📖' },
  { id: 'example',    label: 'Example Turn',   icon: '🎮' },
  { id: 'cheatsheet', label: 'UI Cheat-sheet', icon: '⌨️' },
];

const RULES_SEARCH_INDEX: { id: RulesSectionId; text: string }[] = [
  { id: 'goal',       text: 'goal life 20 reduce opponent zero win last player standing' },
  { id: 'setup',      text: 'setup chain bnb solana ethereum robinhood base 60 card deck draw 7 hand 20 life mulligan first player no draw' },
  { id: 'cards',      text: 'card types node meme machine move land creature artifact enchantment spell instant power toughness permanent one-shot' },
  { id: 'gas',        text: 'gas mana cost tap node color pool drain end of turn empty mixed' },
  { id: 'turn',       text: 'turn phase untap draw main combat attack block damage end discard summoning sick haste' },
  { id: 'advanced',   text: 'advanced summoning sickness haste blockers simultaneous damage graveyard discard max hand 7 discard down' },
  { id: 'example',    text: 'example turn 1 play purple node tap gain gas cast pepe warrior end' },
  { id: 'cheatsheet', text: 'ui click node tap card hand play meme attack blocker end turn button' },
];

function RulesPage({ onBack }: { onBack: () => void }) {
  const [openSection, setOpenSection] = useState<RulesSectionId>('goal');
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const sectionRefs = useRef<Record<RulesSectionId, HTMLDivElement | null>>({} as any);

  // Ctrl/Cmd+K to focus search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchRef.current?.focus(), 50);
      }
      if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filteredNav = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return RULES_NAV;
    const matches = new Set(RULES_SEARCH_INDEX.filter(s => s.text.includes(q)).map(s => s.id));
    return RULES_NAV.filter(n => matches.has(n.id) || n.label.toLowerCase().includes(q));
  }, [search]);

  const goSection = (id: RulesSectionId) => {
    setOpenSection(id);
    setTimeout(() => {
      const el = sectionRefs.current[id];
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  const highlight = (text: string) => {
    const q = search.trim();
    if (!q) return text;
    const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
    return text.split(re).map((part, i) =>
      part.toLowerCase() === q.toLowerCase()
        ? <mark key={i} style={{ background: 'rgba(212,175,55,0.45)', color: '#fff', padding: '0 2px', borderRadius: 2 }}>{part}</mark>
        : <React.Fragment key={i}>{part}</React.Fragment>
    );
  };

  return (
    <div style={{
      fontFamily: RULES_FONT,
      background: `radial-gradient(ellipse at top, #1a1240 0%, #0a0a1e 50%, ${RULES_TOKENS.bg} 100%)`,
      minHeight: '100vh', color: RULES_TOKENS.text, position: 'relative', overflow: 'hidden',
    }}>
      {/* Keyframes */}
      <style>{`
        @keyframes rulesGlow {
          0%, 100% { text-shadow: 0 0 22px rgba(212,175,55,0.45), 0 0 4px rgba(212,175,55,0.6); }
          50%      { text-shadow: 0 0 38px rgba(212,175,55,0.85), 0 0 8px rgba(212,175,55,0.9); }
        }
        @keyframes rulesFloat {
          0%   { transform: translateY(0) translateX(0); opacity: 0; }
          15%  { opacity: 0.6; }
          85%  { opacity: 0.5; }
          100% { transform: translateY(-120vh) translateX(20px); opacity: 0; }
        }
        @keyframes rulesFade {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes rulesPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(212,175,55,0.45); }
          50%      { box-shadow: 0 0 0 8px rgba(212,175,55,0); }
        }
        @keyframes rulesEnergy {
          0%   { transform: translateY(-100%); opacity: 0; }
          30%  { opacity: 1; }
          100% { transform: translateY(100%); opacity: 0; }
        }
        @keyframes rulesArrow {
          0%, 100% { opacity: 0.4; transform: translateY(0); }
          50%      { opacity: 1;   transform: translateY(3px); }
        }
        @keyframes rulesFog {
          0%   { transform: translateX(-10%); }
          100% { transform: translateX(10%); }
        }
      `}</style>

      {/* Floating embers */}
      <div aria-hidden style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        {Array.from({ length: 18 }).map((_, i) => {
          const left = (i * 53) % 100;
          const dur = 14 + (i % 7) * 2;
          const delay = (i % 9) * 1.4;
          const size = 2 + (i % 4);
          const tint = i % 3 === 0 ? RULES_TOKENS.purple : RULES_TOKENS.gold;
          return (
            <span key={i} style={{
              position: 'absolute', bottom: -10, left: `${left}%`,
              width: size, height: size, borderRadius: '50%',
              background: tint,
              boxShadow: `0 0 ${size * 3}px ${tint}`,
              animation: `rulesFloat ${dur}s linear ${delay}s infinite`,
            }} />
          );
        })}
      </div>

      {/* Drifting fog */}
      <div aria-hidden style={{
        position: 'fixed', inset: '-10%',
        background: 'radial-gradient(circle at 20% 30%, rgba(138,43,226,0.10), transparent 40%), radial-gradient(circle at 80% 70%, rgba(212,175,55,0.08), transparent 45%)',
        pointerEvents: 'none', zIndex: 0,
        animation: 'rulesFog 24s ease-in-out infinite alternate',
      }} />

      {/* Sticky header */}
      <div style={{
        padding: '14px 22px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        borderBottom: `1px solid ${RULES_TOKENS.border}`, position: 'sticky', top: 0,
        background: 'linear-gradient(180deg, rgba(5,5,20,0.95) 0%, rgba(10,10,30,0.85) 100%)',
        backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
        zIndex: 10,
      }}>
        <button onClick={onBack} style={ghostBtn}>← Back</button>
        <div style={{
          fontFamily: RULES_HEAD, fontWeight: 800, letterSpacing: 4, fontSize: 18,
          color: RULES_TOKENS.gold,
          animation: 'rulesGlow 3.6s ease-in-out infinite',
        }}>RULEBOOK</div>
        <button
          onClick={() => { setSearchOpen(v => !v); setTimeout(() => searchRef.current?.focus(), 50); }}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 14px', background: 'rgba(212,175,55,0.10)',
            border: `1px solid ${RULES_TOKENS.border}`, borderRadius: 8,
            color: RULES_TOKENS.gold, cursor: 'pointer', fontSize: 13, fontWeight: 600,
          }}
          title="Search rules (Ctrl+K)"
        >🔍 <span style={{ opacity: 0.85 }}>Search</span><kbd style={{
          marginLeft: 4, padding: '2px 6px', fontSize: 10,
          background: 'rgba(0,0,0,0.4)', borderRadius: 4, color: RULES_TOKENS.mute,
        }}>Ctrl K</kbd></button>
      </div>

      {/* Search bar */}
      {searchOpen && (
        <div style={{
          position: 'sticky', top: 58, zIndex: 9,
          padding: '10px 22px',
          background: 'rgba(5,5,20,0.85)', backdropFilter: 'blur(8px)',
          borderBottom: `1px solid ${RULES_TOKENS.borderSoft}`,
          animation: 'rulesFade 200ms ease',
        }}>
          <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              ref={searchRef}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search rules… (e.g. combat, summoning sickness, gas)"
              style={{
                flex: 1, padding: '10px 14px', fontSize: 14,
                background: RULES_TOKENS.panel, color: '#fff',
                border: `1px solid ${RULES_TOKENS.border}`, borderRadius: 8,
                outline: 'none', fontFamily: RULES_FONT,
              }}
            />
            <button onClick={() => { setSearch(''); setSearchOpen(false); }} style={ghostBtn}>Close</button>
          </div>
        </div>
      )}

      {/* Intro video */}
      <div style={{
        position: 'relative', zIndex: 1,
        maxWidth: 1100, margin: '20px auto 0', padding: '0 22px',
      }}>
        <div style={{
          borderRadius: 14, overflow: 'hidden',
          border: `1px solid ${RULES_TOKENS.border}`,
          boxShadow: `0 0 40px rgba(212,175,55,0.18), 0 8px 28px rgba(0,0,0,0.5)`,
          background: '#000',
        }}>
          <video
            src="/rules-intro.mp4"
            controls
            playsInline
            preload="metadata"
            style={{ display: 'block', width: '100%', height: 'auto' }}
          />
        </div>
      </div>

      {/* Hero */}
      <div style={{
        position: 'relative', zIndex: 1,
        maxWidth: 1100, margin: '0 auto', padding: '50px 22px 14px', textAlign: 'center',
      }}>
        <div style={{
          fontFamily: RULES_HEAD, fontWeight: 900, fontSize: 'clamp(34px, 5.5vw, 56px)',
          letterSpacing: 6, color: RULES_TOKENS.gold,
          animation: 'rulesGlow 3.6s ease-in-out infinite',
          background: 'linear-gradient(180deg, #ffe28a 0%, #d4af37 55%, #8a6a16 100%)',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.6))',
        }}>ON-CHAIN VIRTUAL ARENA</div>
        <div style={{
          fontFamily: RULES_HEAD, fontWeight: 600, fontSize: 20,
          letterSpacing: 12, color: RULES_TOKENS.purple, marginTop: 4,
          textShadow: '0 0 18px rgba(138,43,226,0.55)',
        }}>RULEBOOK</div>
        <div style={{
          height: 2, width: 220, margin: '14px auto 0',
          background: `linear-gradient(90deg, transparent, ${RULES_TOKENS.gold}, transparent)`,
        }} />
      </div>

      {/* Quick start panel */}
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1100, margin: '24px auto 0', padding: '0 22px' }}>
        <div style={{
          background: 'linear-gradient(135deg, rgba(138,43,226,0.20) 0%, rgba(212,175,55,0.12) 100%)',
          border: `1px solid ${RULES_TOKENS.border}`, borderRadius: 14,
          padding: '22px 26px', backdropFilter: 'blur(10px)',
          boxShadow: '0 14px 40px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04)',
        }}>
          <div style={{
            fontFamily: RULES_HEAD, fontSize: 18, letterSpacing: 4, fontWeight: 700,
            color: RULES_TOKENS.gold, textAlign: 'center', marginBottom: 14,
          }}>⚡ LEARN IN 30 SECONDS</div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12,
          }}>
            {[
              { n: 1, t: 'Play Nodes',           c: RULES_TOKENS.gold },
              { n: 2, t: 'Nodes make Gas',       c: RULES_TOKENS.purple },
              { n: 3, t: 'Cast Memes',           c: RULES_TOKENS.blue },
              { n: 4, t: 'Attack Opponent',      c: RULES_TOKENS.red },
              { n: 5, t: 'Reduce Life 20 → 0',   c: RULES_TOKENS.green },
            ].map(s => (
              <div key={s.n} style={{
                background: 'rgba(0,0,0,0.35)', borderRadius: 10,
                border: `1px solid ${s.c}55`, padding: '14px 12px', textAlign: 'center',
                animation: 'rulesFade 360ms ease both',
              }}>
                <div style={{
                  width: 34, height: 34, borderRadius: '50%', margin: '0 auto 8px',
                  background: `radial-gradient(circle, ${s.c}, ${s.c}66)`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 900, color: '#0a0a14', fontSize: 16,
                  boxShadow: `0 0 18px ${s.c}77`,
                }}>{s.n}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{s.t}</div>
              </div>
            ))}
          </div>
          <div style={{
            marginTop: 14, textAlign: 'center', fontSize: 13, color: RULES_TOKENS.mute, fontStyle: 'italic',
          }}>Last player standing wins.</div>
        </div>
      </div>

      {/* Body: sticky nav + sections */}
      <div style={{
        position: 'relative', zIndex: 1,
        maxWidth: 1100, margin: '24px auto 0', padding: '0 22px 80px',
        display: 'grid', gridTemplateColumns: 'minmax(0, 220px) minmax(0, 1fr)', gap: 22,
      }}>
        {/* Sticky nav */}
        <nav style={{
          position: 'sticky', top: searchOpen ? 130 : 78, alignSelf: 'start',
          background: RULES_TOKENS.panel, backdropFilter: 'blur(8px)',
          border: `1px solid ${RULES_TOKENS.borderSoft}`, borderRadius: 12,
          padding: 10, maxHeight: 'calc(100vh - 120px)', overflowY: 'auto',
        }}>
          <div style={{
            fontFamily: RULES_HEAD, fontSize: 11, letterSpacing: 3, fontWeight: 700,
            color: RULES_TOKENS.gold, padding: '6px 8px 10px', borderBottom: `1px solid ${RULES_TOKENS.borderSoft}`,
            marginBottom: 6,
          }}>CHAPTERS</div>
          {filteredNav.length === 0 && (
            <div style={{ padding: 10, fontSize: 12, color: RULES_TOKENS.mute }}>No matches.</div>
          )}
          {filteredNav.map(n => {
            const active = openSection === n.id;
            return (
              <button key={n.id} onClick={() => goSection(n.id)} style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '9px 10px', marginBottom: 2,
                background: active ? 'linear-gradient(90deg, rgba(212,175,55,0.18), transparent)' : 'transparent',
                color: active ? RULES_TOKENS.gold : RULES_TOKENS.text,
                border: 'none', borderLeft: `3px solid ${active ? RULES_TOKENS.gold : 'transparent'}`,
                borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: active ? 700 : 500,
                fontFamily: RULES_FONT, textAlign: 'left', transition: 'all 200ms ease',
              }}>
                <span style={{ fontSize: 15 }}>{n.icon}</span>
                <span>{n.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Sections */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {RULES_NAV.map(n => {
            const open = openSection === n.id;
            const visible = !search.trim() || filteredNav.some(f => f.id === n.id);
            if (!visible) return null;
            return (
              <RuleSection
                key={n.id}
                _ref={(el) => { sectionRefs.current[n.id] = el; }}
                id={n.id} icon={n.icon} title={n.label}
                open={open}
                onToggle={() => setOpenSection(open ? n.id : n.id)}
                onHeaderClick={() => setOpenSection(prev => prev === n.id ? n.id : n.id)}
                summary={SECTION_SUMMARY[n.id]}
                onClickHeader={() => setOpenSection(open ? ('goal' as RulesSectionId) : n.id)}
              >
                {renderSectionBody(n.id, highlight)}
              </RuleSection>
            );
          })}

          <div style={{
            marginTop: 12, textAlign: 'center', fontSize: 13, color: RULES_TOKENS.mute, fontStyle: 'italic',
          }}>
            That's the whole game. Have fun.
          </div>
        </div>
      </div>
    </div>
  );
}

const SECTION_SUMMARY: Record<RulesSectionId, string> = {
  goal:       'Reduce your opponent\'s life from 20 → 0. Last player standing wins.',
  setup:      '5 chains. 60-card deck. Start at 20 life with 7 cards.',
  cards:      'Nodes, Memes, Machines, Moves — your full toolkit.',
  gas:        'Tap Nodes to fuel your spells. Gas drains every turn.',
  turn:       'Untap → Draw → Main → Combat → End.',
  advanced:   'Summoning sickness, blockers, simultaneous damage, hand size.',
  example:    'Walk through Turn 1 step-by-step.',
  cheatsheet: 'Quick clicks for the in-match UI.',
};

function RuleSection({
  id, icon, title, summary, open, onClickHeader, children, _ref,
}: {
  id: RulesSectionId; icon: string; title: string; summary: string;
  open: boolean; onClickHeader: () => void; children: React.ReactNode;
  _ref?: (el: HTMLDivElement | null) => void;
  // unused props kept for API stability
  onToggle?: () => void; onHeaderClick?: () => void;
}) {
  return (
    <div
      ref={_ref}
      id={`rule-${id}`}
      style={{
        background: open ? RULES_TOKENS.panelHi : RULES_TOKENS.panel,
        border: `1px solid ${open ? RULES_TOKENS.border : RULES_TOKENS.borderSoft}`,
        borderRadius: 12, overflow: 'hidden',
        boxShadow: open
          ? `0 14px 36px rgba(0,0,0,0.55), 0 0 0 1px ${RULES_TOKENS.goldGlow}44`
          : '0 8px 22px rgba(0,0,0,0.4)',
        transition: 'all 250ms ease',
      }}>
      <button onClick={onClickHeader} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 14,
        padding: '16px 18px', background: 'transparent', border: 'none',
        cursor: 'pointer', textAlign: 'left', fontFamily: RULES_FONT,
      }}>
        <span style={{
          width: 40, height: 40, borderRadius: 10, flexShrink: 0,
          background: `linear-gradient(135deg, rgba(212,175,55,0.20), rgba(138,43,226,0.20))`,
          border: `1px solid ${RULES_TOKENS.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 20,
        }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: RULES_HEAD, fontWeight: 700, fontSize: 18,
            letterSpacing: 2, color: RULES_TOKENS.gold,
          }}>{title.toUpperCase()}</div>
          <div style={{ fontSize: 12, color: RULES_TOKENS.mute, marginTop: 2 }}>{summary}</div>
        </div>
        <span style={{
          color: RULES_TOKENS.gold, fontSize: 16, transition: 'transform 250ms ease',
          transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        }}>▾</span>
      </button>
      {open && (
        <div style={{
          padding: '4px 22px 22px', animation: 'rulesFade 280ms ease both',
          color: RULES_TOKENS.text, fontSize: 14.5, lineHeight: 1.65,
        }}>{children}</div>
      )}
    </div>
  );
}

function renderSectionBody(id: RulesSectionId, highlight: (s: string) => React.ReactNode) {
  switch (id) {
    case 'goal':
      return (
        <div>
          <p>{highlight('Reduce your opponent\'s life from 20 to 0. Last player standing wins.')}</p>
          <div style={{
            marginTop: 14, display: 'flex', justifyContent: 'center', gap: 18, flexWrap: 'wrap',
          }}>
            <LifeOrb label="Start" value={20} color={RULES_TOKENS.green} />
            <div style={{
              alignSelf: 'center', fontSize: 22, color: RULES_TOKENS.gold, fontWeight: 900,
              animation: 'rulesArrow 1.6s ease-in-out infinite',
            }}>➜</div>
            <LifeOrb label="Win" value={0} color={RULES_TOKENS.red} />
          </div>
        </div>
      );
    case 'setup':
      return (
        <div>
          <p>{highlight('Each player picks one of 5 chains, shuffles their 60-card deck, draws 7 cards, and starts at 20 life.')}</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '14px 0' }}>
            {[
              { n: 'BnB',        c: '#f3ba2f' },
              { n: 'Solana',     c: '#9945ff' },
              { n: 'Avalanche',  c: '#e84142' },
              { n: 'Ethereum',   c: '#cfd8dc' },
              { n: 'XRP',        c: '#8a8a8a' },
            ].map(x => (
              <div key={x.n} style={{
                padding: '8px 14px', borderRadius: 999,
                background: `${x.c}22`, color: x.c, border: `1px solid ${x.c}66`,
                fontWeight: 700, fontSize: 13,
              }}>{x.n}</div>
            ))}
          </div>
          <ul style={{ marginLeft: 18 }}>
            <li>{highlight('60-card deck in your chain color.')}</li>
            <li>{highlight('Draw 7 cards. Start at 20 life.')}</li>
            <li>{highlight('Max hand size 7 — discard down at end of turn.')}</li>
            <li>{highlight('The first player skips their turn-1 draw.')}</li>
          </ul>
        </div>
      );
    case 'cards':
      return <CardTypesGrid highlight={highlight} />;
    case 'gas':
      return (
        <div>
          <p>{highlight('Nodes generate Gas. Cards cost Gas. Gas drains at end of your turn — spend it or lose it.')}</p>
          <GasFlowViz />
          <ul style={{ marginLeft: 18, marginTop: 10 }}>
            <li>{highlight('Tap a Node → +1 Gas of its color.')}</li>
            <li>{highlight('A cost can be one color or mixed.')}</li>
            <li>{highlight('Unspent Gas evaporates when your turn ends.')}</li>
          </ul>
        </div>
      );
    case 'turn':
      return <TurnTimeline highlight={highlight} />;
    case 'advanced':
      return (
        <div>
          <ul style={{ marginLeft: 18 }}>
            <li><b style={{ color: RULES_TOKENS.gold }}>Summoning sickness</b> — {highlight('Memes can\'t attack the turn they enter (unless they have haste).')}</li>
            <li><b style={{ color: RULES_TOKENS.gold }}>Blocking</b> — {highlight('Defender chooses blockers from untapped Memes. Unblocked attackers hit life directly.')}</li>
            <li><b style={{ color: RULES_TOKENS.gold }}>Simultaneous damage</b> — {highlight('Attacker and blocker deal Power to each other. Damage ≥ toughness destroys it.')}</li>
            <li><b style={{ color: RULES_TOKENS.gold }}>Graveyard</b> — {highlight('Destroyed Memes, used Moves go here. Some cards interact with the graveyard.')}</li>
            <li><b style={{ color: RULES_TOKENS.gold }}>Max hand 7</b> — {highlight('Discard down at end of turn.')}</li>
          </ul>
        </div>
      );
    case 'example':
      return <ExampleTurn highlight={highlight} />;
    case 'cheatsheet':
      return (
        <div>
          <ul style={{ marginLeft: 18 }}>
            <li>{highlight('Click an untapped Node → tap for Gas.')}</li>
            <li>{highlight('Click a card in hand → play it (Moves then ask for a target).')}</li>
            <li>{highlight('Click your own untapped Meme → mark attacker. Press "Attack with N".')}</li>
            <li>{highlight('During declare blockers → click your Meme, then click the attacker to block.')}</li>
            <li>{highlight('Press End Turn to pass.')}</li>
          </ul>
        </div>
      );
  }
}

function LifeOrb({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{
        width: 92, height: 92, borderRadius: '50%',
        background: `radial-gradient(circle at 35% 30%, ${color}, ${color}33 65%, transparent 80%)`,
        border: `2px solid ${color}aa`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: RULES_HEAD, fontSize: 36, fontWeight: 900, color: '#fff',
        textShadow: '0 2px 8px rgba(0,0,0,0.8)',
        boxShadow: `0 0 28px ${color}66, inset 0 0 18px rgba(0,0,0,0.4)`,
      }}>{value}</div>
      <div style={{ fontSize: 12, color: RULES_TOKENS.mute, marginTop: 6, letterSpacing: 2 }}>{label.toUpperCase()}</div>
    </div>
  );
}

function CardTypesGrid({ highlight }: { highlight: (s: string) => React.ReactNode }) {
  const types = [
    { name: 'NODE',    icon: '⛓️', color: RULES_TOKENS.gold,   short: 'Produces Gas',        details: 'Your "land". Free to play, but only 1 per turn. Tap on a later turn to add 1 Gas of its color to your pool.' },
    { name: 'MEME',    icon: '🐸', color: RULES_TOKENS.purple, short: 'Creature Card',       details: 'Your fighters. Each has Power / Toughness. Attack to deal damage to the opponent. Summoning sick the turn they enter.' },
    { name: 'MACHINE', icon: '⚙️', color: RULES_TOKENS.blue,   short: 'Permanent Effect',    details: 'Artifact / enchantment. Stays in play with an ongoing effect until destroyed.' },
    { name: 'AURA',    icon: '🔮', color: RULES_TOKENS.purple, short: 'Enchant a Meme',      details: 'A spell that attaches to a single Meme. Buffs its stats or grants a keyword (haste, lifelink, etc). If the enchanted Meme dies or is bounced, the Aura is destroyed too.' },
    { name: 'MOVE',    icon: '⚡', color: RULES_TOKENS.red,    short: 'Instant Action',      details: 'A one-shot spell. Resolves immediately, then goes to the graveyard.' },
  ];
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 10,
    }}>
      {types.map(t => {
        const isOpen = expanded === t.name;
        return (
          <button key={t.name} onClick={() => setExpanded(isOpen ? null : t.name)} style={{
            background: `linear-gradient(160deg, ${t.color}22 0%, rgba(0,0,0,0.55) 70%)`,
            border: `1px solid ${t.color}66`, borderRadius: 12,
            padding: '18px 16px', cursor: 'pointer', color: RULES_TOKENS.text,
            textAlign: 'left', fontFamily: RULES_FONT,
            transition: 'transform 220ms ease, box-shadow 220ms ease',
            boxShadow: isOpen ? `0 0 28px ${t.color}66` : '0 4px 14px rgba(0,0,0,0.4)',
            transform: isOpen ? 'translateY(-3px) scale(1.02)' : 'none',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-3px) scale(1.02)'; }}
          onMouseLeave={(e) => { if (!isOpen) (e.currentTarget as HTMLButtonElement).style.transform = 'none'; }}
          >
            <div style={{
              fontSize: 38, lineHeight: 1, marginBottom: 8,
              filter: `drop-shadow(0 0 10px ${t.color})`,
            }}>{t.icon}</div>
            <div style={{
              fontFamily: RULES_HEAD, fontWeight: 800, letterSpacing: 4,
              color: t.color, fontSize: 16, marginBottom: 4,
            }}>{t.name}</div>
            <div style={{ fontSize: 12, color: RULES_TOKENS.mute, marginBottom: 6 }}>{t.short}</div>
            {isOpen && (
              <div style={{
                marginTop: 8, paddingTop: 10, fontSize: 13,
                borderTop: `1px solid ${t.color}44`, lineHeight: 1.55,
                animation: 'rulesFade 220ms ease both',
              }}>{highlight(t.details)}</div>
            )}
          </button>
        );
      })}
    </div>
  );
}

function GasFlowViz() {
  return (
    <div style={{
      margin: '14px 0', padding: '18px 12px',
      background: 'rgba(138,43,226,0.08)', border: `1px solid ${RULES_TOKENS.purple}33`,
      borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap: 18, flexWrap: 'wrap',
    }}>
      <FlowNode icon="⛓️" label="NODE" color={RULES_TOKENS.gold} />
      <FlowArrow />
      <div style={{
        position: 'relative', padding: '10px 16px',
        border: `1px solid ${RULES_TOKENS.purple}88`, borderRadius: 8,
        background: 'rgba(138,43,226,0.18)',
        fontFamily: RULES_HEAD, letterSpacing: 2, fontWeight: 800,
        color: RULES_TOKENS.purple, fontSize: 14,
        boxShadow: `0 0 18px ${RULES_TOKENS.purpleSoft}`,
        overflow: 'hidden',
      }}>
        +1 GAS
        <div style={{
          position: 'absolute', inset: 0,
          background: `linear-gradient(180deg, transparent, ${RULES_TOKENS.purple}55, transparent)`,
          animation: 'rulesEnergy 1.8s ease-in-out infinite', pointerEvents: 'none',
        }} />
      </div>
      <FlowArrow />
      <FlowNode icon="🐸" label="CAST MEME" color={RULES_TOKENS.purple} />
    </div>
  );
}

function FlowNode({ icon, label, color }: { icon: string; label: string; color: string }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 80 }}>
      <div style={{
        width: 60, height: 60, borderRadius: 12, margin: '0 auto 6px',
        background: `radial-gradient(circle, ${color}33, transparent 75%)`,
        border: `1px solid ${color}77`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28,
        boxShadow: `0 0 20px ${color}55`,
      }}>{icon}</div>
      <div style={{
        fontFamily: RULES_HEAD, fontSize: 11, letterSpacing: 2, fontWeight: 700, color,
      }}>{label}</div>
    </div>
  );
}

function FlowArrow() {
  return (
    <span style={{
      fontSize: 24, color: RULES_TOKENS.gold,
      animation: 'rulesArrow 1.6s ease-in-out infinite',
    }}>➜</span>
  );
}

function TurnTimeline({ highlight }: { highlight: (s: string) => React.ReactNode }) {
  const phases = [
    { id: 'untap',  name: 'UNTAP',  icon: '🔄', color: RULES_TOKENS.blue,   desc: 'Untap your Nodes, Memes, and Machines. Summoning sickness wears off.' },
    { id: 'draw',   name: 'DRAW',   icon: '🃏', color: RULES_TOKENS.green,  desc: 'Draw 1 card (skipped on the very first turn of the game).' },
    { id: 'main',   name: 'MAIN',   icon: '⚙️', color: RULES_TOKENS.gold,   desc: 'Play 1 Node, tap for Gas, cast Memes, Machines, and Moves in any order.' },
    { id: 'combat', name: 'COMBAT', icon: '⚔️', color: RULES_TOKENS.red,    desc: 'Click Memes to attack. Opponent blocks. Damage resolves simultaneously.' },
    { id: 'end',    name: 'END',    icon: '🌙', color: RULES_TOKENS.purple, desc: 'Unspent Gas evaporates. Discard down to 7 cards.' },
  ];
  const [active, setActive] = useState<string>('untap');
  const cur = phases.find(p => p.id === active)!;
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 6, margin: '10px 0 16px', flexWrap: 'wrap',
      }}>
        {phases.map((p, i) => (
          <React.Fragment key={p.id}>
            <button onClick={() => setActive(p.id)} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              padding: '6px 4px', background: 'transparent', border: 'none', cursor: 'pointer',
              fontFamily: RULES_FONT,
            }} title={p.desc}>
              <span style={{
                width: 48, height: 48, borderRadius: '50%',
                background: active === p.id
                  ? `radial-gradient(circle, ${p.color}, ${p.color}55 65%, transparent 80%)`
                  : `radial-gradient(circle, ${p.color}55, ${p.color}11 65%, transparent 80%)`,
                border: `2px solid ${active === p.id ? p.color : `${p.color}66`}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
                boxShadow: active === p.id ? `0 0 20px ${p.color}aa` : 'none',
                animation: active === p.id ? 'rulesPulse 2s ease-out infinite' : 'none',
                transition: 'all 250ms ease',
              }}>{p.icon}</span>
              <span style={{
                fontFamily: RULES_HEAD, fontSize: 10, letterSpacing: 2, fontWeight: 800,
                color: active === p.id ? p.color : RULES_TOKENS.mute,
              }}>{p.name}</span>
            </button>
            {i < phases.length - 1 && (
              <span style={{
                fontSize: 18, color: RULES_TOKENS.gold, opacity: 0.55,
              }}>→</span>
            )}
          </React.Fragment>
        ))}
      </div>
      <div style={{
        background: `linear-gradient(135deg, ${cur.color}22, transparent)`,
        border: `1px solid ${cur.color}55`, borderRadius: 10,
        padding: '14px 16px', animation: 'rulesFade 240ms ease both',
      }}>
        <div style={{
          fontFamily: RULES_HEAD, letterSpacing: 3, fontWeight: 800, color: cur.color, marginBottom: 4,
        }}>{cur.name} PHASE</div>
        <div style={{ fontSize: 13.5, color: RULES_TOKENS.text }}>{highlight(cur.desc)}</div>
      </div>
    </div>
  );
}

function ExampleTurn({ highlight }: { highlight: (s: string) => React.ReactNode }) {
  const steps = [
    { t: 'Play Purple Node',         d: 'You start your turn. You spend your free Node drop and play a Solana Node onto the battlefield.' },
    { t: 'Tap Node for 1 Purple Gas',d: 'Click your untapped Node. It rotates and adds 1 Purple Gas to your pool.' },
    { t: 'Cast a Meme',              d: 'You spend 1 Purple Gas to cast a cheap Meme like Pepe Warrior. It enters summoning sick — it can\'t attack this turn.' },
    { t: 'End Turn',                 d: 'No combat this turn. Unspent Gas evaporates, and you pass to the opponent.' },
  ];
  const [i, setI] = useState(0);
  const s = steps[i];
  return (
    <div>
      <div style={{
        background: 'rgba(0,0,0,0.4)', border: `1px solid ${RULES_TOKENS.borderSoft}`,
        borderRadius: 10, padding: '16px 18px',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8,
        }}>
          <div style={{
            fontFamily: RULES_HEAD, letterSpacing: 3, fontSize: 12, fontWeight: 800, color: RULES_TOKENS.gold,
          }}>TURN 1 — STEP {i + 1} / {steps.length}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {steps.map((_, idx) => (
              <span key={idx} style={{
                width: 8, height: 8, borderRadius: '50%',
                background: idx === i ? RULES_TOKENS.gold : 'rgba(255,255,255,0.18)',
                boxShadow: idx === i ? `0 0 8px ${RULES_TOKENS.goldGlow}` : 'none',
                transition: 'all 200ms ease',
              }} />
            ))}
          </div>
        </div>
        <div style={{
          fontFamily: RULES_HEAD, fontSize: 18, fontWeight: 700, color: '#fff', marginBottom: 6,
        }}>{s.t}</div>
        <div style={{ fontSize: 13.5, color: RULES_TOKENS.text, lineHeight: 1.6, animation: 'rulesFade 220ms ease both' }}>
          {highlight(s.d)}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 12 }}>
        <button onClick={() => setI(v => Math.max(0, v - 1))} disabled={i === 0} style={{
          ...ghostBtn, opacity: i === 0 ? 0.4 : 1, cursor: i === 0 ? 'not-allowed' : 'pointer',
        }}>← Previous</button>
        <button onClick={() => setI(v => Math.min(steps.length - 1, v + 1))} disabled={i === steps.length - 1} style={{
          padding: '8px 18px', background: `linear-gradient(180deg, ${RULES_TOKENS.gold}, #8a6a16)`,
          color: '#1a1408', border: 'none', borderRadius: 6,
          fontWeight: 800, fontSize: 13, letterSpacing: 1,
          cursor: i === steps.length - 1 ? 'not-allowed' : 'pointer',
          opacity: i === steps.length - 1 ? 0.4 : 1,
          boxShadow: `0 0 14px ${RULES_TOKENS.goldGlow}`,
        }}>Next →</button>
      </div>
    </div>
  );
}

// ── Rulebook (redesigned, data-driven) ─────────────────────────────────────
const RB = {
  bg: '#09081A', bgEl: '#0E0D21', panel: '#17142D', panelActive: '#211744', panelHover: '#262047',
  border: 'rgba(230,196,92,0.22)', borderStrong: 'rgba(230,196,92,0.55)',
  gold: '#E6C45C', goldBright: '#FFD875', violet: '#8B5CF6',
  text: '#F4F1E8', text2: '#AAA4BC', success: '#55E58B', danger: '#FF616F', blue: '#57A8FF',
};

type RBId = 'goal' | 'setup' | 'card-types' | 'gas-system' | 'turn-order' | 'combat' | 'advanced-rules' | 'example-turn' | 'ui-cheat-sheet';
type HL = (s: string) => React.ReactNode;

function rbHighlight(q: string): HL {
  return (text) => {
    const query = q.trim();
    if (!query) return text;
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
    return String(text).split(re).map((part, i) =>
      part.toLowerCase() === query.toLowerCase()
        ? <mark key={i} style={{ background: 'rgba(230,196,92,0.4)', color: '#fff', borderRadius: 2, padding: '0 2px' }}>{part}</mark>
        : <React.Fragment key={i}>{part}</React.Fragment>);
  };
}

interface RBChapter { id: RBId; num: string; title: string; icon: string; accent: string; summary: string; keywords: string[]; search: string; content: (h: HL) => React.ReactNode; }

const RB_CHAPTERS: RBChapter[] = [
  { id: 'goal', num: '01', title: 'Goal', icon: '🏆', accent: RB.gold,
    summary: 'Reduce your opponent’s life from 20 → 0. Last player standing wins.',
    keywords: ['life', 'win', 'victory', '20'], search: 'goal life 20 reduce opponent zero win last player standing victory check',
    content: (h) => (
      <div>
        <p style={{ fontSize: 18, fontWeight: 600, color: RB.text, margin: '0 0 8px' }}>
          {h('Reduce your opponent’s life from 20 to 0.')}<br />{h('Last player standing wins.')}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 26, flexWrap: 'wrap', margin: '18px 0 6px' }}>
          <LifeOrb label="Start" value={20} color={RB.success} />
          <div aria-hidden style={{ fontSize: 30, color: RB.goldBright, fontWeight: 900 }}>➜</div>
          <LifeOrb label="Win" value={0} color={RB.danger} />
        </div>
        <RuleCallout title="Victory Check" text="If every opponent is at 0 life, the match ends immediately." />
      </div>
    ) },
  { id: 'setup', num: '02', title: 'Setup', icon: '⚔️', accent: RB.violet,
    summary: 'Choose a 60-card deck, draw 7 cards, and begin at 20 life.',
    keywords: ['deck', '60', 'draw', 'hand', 'mulligan', 'chain'], search: 'setup chain bnb solana ethereum robinhood base 60 card deck draw 7 hand 20 life first player no draw',
    content: (h) => (
      <div>
        <p>{h('Each player picks one of 5 chains, shuffles their 60-card deck, draws 7 cards, and starts at 20 life.')}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '14px 0' }}>
          {COLORS.map((c) => (
            <span key={c} style={{ padding: '7px 14px', borderRadius: 999, background: `${COLOR_META[c].hex}22`, color: COLOR_META[c].hex, border: `1px solid ${COLOR_META[c].hex}66`, fontWeight: 700, fontSize: 13 }}>{COLOR_META[c].name}</span>
          ))}
        </div>
        <ul style={{ marginLeft: 18, lineHeight: 1.8 }}>
          <li>{h('60-card deck in your chain color.')}</li>
          <li>{h('Draw 7 cards. Start at 20 life.')}</li>
          <li>{h('Max hand size 7 — discard down at end of turn.')}</li>
          <li>{h('The first player skips their turn-1 draw.')}</li>
        </ul>
      </div>
    ) },
  { id: 'card-types', num: '03', title: 'Card Types', icon: '🃏', accent: RB.blue,
    summary: 'Nodes, Memes, Machines, and Moves make up your toolkit.',
    keywords: ['node', 'meme', 'machine', 'aura', 'move'], search: 'card types node meme machine aura move creature power toughness permanent one-shot instant enchant',
    content: (h) => <CardTypesGrid highlight={h} /> },
  { id: 'gas-system', num: '04', title: 'Gas System', icon: '⛽', accent: RB.violet,
    summary: 'Tap Nodes to fuel your cards. Unspent Gas drains every turn.',
    keywords: ['gas', 'mana', 'cost', 'tap', 'node'], search: 'gas mana cost tap node color pool drain end of turn empty mixed fuel',
    content: (h) => (
      <div>
        <p>{h('Nodes generate Gas. Cards cost Gas. Gas drains at end of your turn — spend it or lose it.')}</p>
        <GasFlowViz />
        <ul style={{ marginLeft: 18, marginTop: 10, lineHeight: 1.8 }}>
          <li>{h('Tap a Node → +1 Gas of its color.')}</li>
          <li>{h('A cost can be one color or mixed.')}</li>
          <li>{h('Unspent Gas evaporates when your turn ends.')}</li>
        </ul>
      </div>
    ) },
  { id: 'turn-order', num: '05', title: 'Turn Order', icon: '🔄', accent: RB.gold,
    summary: 'Untap → Draw → Main → Combat → End.',
    keywords: ['turn', 'phase', 'untap', 'draw', 'main', 'combat', 'end'], search: 'turn phase untap draw main combat attack block damage end discard summoning sick haste',
    content: (h) => (
      <div>
        <p style={{ marginTop: 0 }}>{h('Every turn moves through five phases in order.')}</p>
        <TurnTimeline highlight={h} />
      </div>
    ) },
  { id: 'combat', num: '06', title: 'Combat', icon: '⚔️', accent: RB.danger,
    summary: 'Declare attackers, let the defender block, then resolve damage.',
    keywords: ['combat', 'attack', 'block', 'damage', 'blocker'], search: 'combat attack declare attackers blockers unblocked hits life simultaneous damage power toughness destroy',
    content: (h) => (
      <div>
        <ul style={{ marginLeft: 18, lineHeight: 1.85 }}>
          <li><b style={{ color: RB.gold }}>Declare attackers</b> — {h('Tap your untapped, non-summoning-sick Memes to attack.')}</li>
          <li><b style={{ color: RB.gold }}>Blocking</b> — {h('The defender assigns blockers from untapped Memes. Unblocked attackers hit life directly.')}</li>
          <li><b style={{ color: RB.gold }}>Simultaneous damage</b> — {h('Attacker and blocker deal their Power to each other at the same time. Damage ≥ toughness destroys a Meme.')}</li>
          <li><b style={{ color: RB.gold }}>To the graveyard</b> — {h('Destroyed Memes go to the graveyard.')}</li>
        </ul>
      </div>
    ) },
  { id: 'advanced-rules', num: '07', title: 'Advanced Rules', icon: '📖', accent: RB.violet,
    summary: 'Summoning sickness, blockers, simultaneous damage, hand size.',
    keywords: ['summoning', 'sickness', 'haste', 'graveyard', 'hand'], search: 'advanced summoning sickness haste blockers simultaneous damage graveyard discard max hand 7 discard down',
    content: (h) => (
      <div>
        <ul style={{ marginLeft: 18, lineHeight: 1.85 }}>
          <li><b style={{ color: RB.gold }}>Summoning sickness</b> — {h('Memes can’t attack the turn they enter (unless they have haste).')}</li>
          <li><b style={{ color: RB.gold }}>Blocking</b> — {h('Defender chooses blockers from untapped Memes. Unblocked attackers hit life directly.')}</li>
          <li><b style={{ color: RB.gold }}>Simultaneous damage</b> — {h('Attacker and blocker deal Power to each other. Damage ≥ toughness destroys it.')}</li>
          <li><b style={{ color: RB.gold }}>Graveyard</b> — {h('Destroyed Memes, used Moves go here. Some cards interact with the graveyard.')}</li>
          <li><b style={{ color: RB.gold }}>Max hand 7</b> — {h('Discard down at end of turn.')}</li>
        </ul>
      </div>
    ) },
  { id: 'example-turn', num: '08', title: 'Example Turn', icon: '🎮', accent: RB.blue,
    summary: 'Walk through Turn 1 step-by-step.',
    keywords: ['example', 'walkthrough', 'turn 1'], search: 'example turn 1 play purple node tap gain gas cast pepe warrior end walkthrough',
    content: (h) => <ExampleTurn highlight={h} /> },
  { id: 'ui-cheat-sheet', num: '09', title: 'UI Cheat Sheet', icon: '🖥️', accent: RB.gold,
    summary: 'Quick clicks for the in-match UI.',
    keywords: ['ui', 'click', 'controls', 'buttons'], search: 'ui click node tap card hand play meme attack blocker end turn button cheat sheet controls',
    content: (h) => (
      <div>
        <ul style={{ marginLeft: 18, lineHeight: 1.85 }}>
          <li>{h('Click an untapped Node → tap for Gas.')}</li>
          <li>{h('Click a card in hand → play it (Moves then ask for a target).')}</li>
          <li>{h('Click your own untapped Meme → mark attacker. Press "Attack with N".')}</li>
          <li>{h('During declare blockers → click your Meme, then click the attacker to block.')}</li>
          <li>{h('Press End Turn to pass.')}</li>
        </ul>
      </div>
    ) },
];

const RB_KEY_TERMS: { term: string; to: RBId; color: string }[] = [
  { term: 'Node', to: 'card-types', color: RB.gold },
  { term: 'Gas', to: 'gas-system', color: RB.violet },
  { term: 'Meme', to: 'card-types', color: RB.blue },
  { term: 'Machine', to: 'card-types', color: RB.danger },
  { term: 'Move', to: 'card-types', color: RB.success },
];

const RB_QUICKSTART: { n: number; title: string; sub: string; color: string; to: RBId }[] = [
  { n: 1, title: 'Play Nodes', sub: 'Build your board', color: RB.gold, to: 'card-types' },
  { n: 2, title: 'Generate Gas', sub: 'Fuel your cards', color: RB.violet, to: 'gas-system' },
  { n: 3, title: 'Cast Memes', sub: 'Deploy your units', color: RB.blue, to: 'card-types' },
  { n: 4, title: 'Attack', sub: 'Pressure your rival', color: RB.danger, to: 'combat' },
  { n: 5, title: 'Reduce 20 → 0', sub: 'Last player standing', color: RB.success, to: 'goal' },
];

function readRbHash(): RBId {
  const h = (typeof window !== 'undefined' ? window.location.hash : '').replace('#', '');
  return RB_CHAPTERS.some((c) => c.id === h) ? (h as RBId) : 'goal';
}

function RulebookPage({ onBack }: { onBack: () => void }) {
  const narrow = useIsMobile(1279);
  const phone = useIsMobile(767);
  const [activeId, setActiveId] = useState<RBId>(readRbHash);
  const [searchOpen, setSearchOpen] = useState(false);
  const [hlQuery, setHlQuery] = useState('');
  const [muted, setMuted] = useState<boolean>(() => { try { return localStorage.getItem('ocva.muted') === '1'; } catch { return false; } });
  const mainRef = useRef<HTMLDivElement | null>(null);
  const activeIdx = RB_CHAPTERS.findIndex((c) => c.id === activeId);
  const active = RB_CHAPTERS[activeIdx];
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  const go = useCallback((id: RBId, opts?: { hl?: string; scroll?: boolean }) => {
    setActiveId(id);
    setHlQuery(opts?.hl ?? '');
    try { window.history.replaceState(null, '', `#${id}`); } catch {}
    if (opts?.scroll !== false) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      setTimeout(() => mainRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }), 40);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(true); }
      if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', onKey);
    const onHash = () => setActiveId(readRbHash());
    window.addEventListener('hashchange', onHash);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', onHash); };
  }, []);

  useEffect(() => {
    try { localStorage.setItem('ocva.muted', muted ? '1' : '0'); } catch {}
    document.querySelectorAll('audio,video').forEach((a) => { (a as HTMLMediaElement).muted = muted; });
  }, [muted]);

  const h = rbHighlight(hlQuery);
  const below = RB_CHAPTERS.filter((_, i) => i > activeIdx);

  return (
    <div style={{ minHeight: '100dvh', background: RB.bg, color: RB.text, fontFamily: RULES_FONT, position: 'relative' }}>
      <style>{`
        @media (prefers-reduced-motion: reduce){ .rb-anim{ transition:none !important; animation:none !important; } }
        .rb-scroll::-webkit-scrollbar{ width:8px; } .rb-scroll::-webkit-scrollbar-thumb{ background:${RB.panelHover}; border-radius:4px; }
        .rb-snap{ scroll-snap-type:x mandatory; } .rb-snap > *{ scroll-snap-align:start; }
      `}</style>
      <RBParticles />

      <RulebookHeader onBack={onBack} onOpenSearch={() => setSearchOpen(true)} isMac={isMac} narrow={narrow} />

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1520, margin: '0 auto', padding: phone ? '14px 14px 60px' : '20px 24px 60px' }}>
        {/* Hero */}
        <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '1.15fr 0.85fr', gap: 22, alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.22em', color: RB.gold }}>ON-CHAIN VIRTUAL ARENA</div>
            <h1 style={{ fontFamily: RULES_HEAD, fontWeight: 800, fontSize: phone ? 40 : 'clamp(44px, 5vw, 68px)', lineHeight: 1.02, margin: '6px 0 10px',
              background: `linear-gradient(180deg, #ffe9a8, ${RB.gold} 55%, #a6802f)`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>
              Master the Arena
            </h1>
            <p style={{ fontSize: 17, color: RB.text2, margin: '0 0 14px' }}>Everything you need to play, build, and win.</p>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderRadius: 999, background: RB.panel, border: `1px solid ${RB.border}`, fontSize: 13, fontWeight: 600 }}>
              <span aria-hidden>📖</span> {RB_CHAPTERS.length} chapters · 8 min read
            </span>
          </div>
          <TutorialPreview muted={muted} />
        </div>

        {/* Quick start */}
        <QuickStartPath onGo={(id) => go(id)} phone={phone} />

        {/* Workspace */}
        <div style={{ display: 'grid', gap: 18, marginTop: 20,
          gridTemplateColumns: narrow ? '1fr' : '230px minmax(0, 1fr) 288px', alignItems: 'start' }}>
          {!narrow ? (
            <ChapterNavigation chapters={RB_CHAPTERS} activeId={activeId} activeIdx={activeIdx} onGo={(id) => go(id)} />
          ) : (
            <ChapterDropdown chapters={RB_CHAPTERS} activeId={activeId} onGo={(id) => go(id)} />
          )}

          <div ref={mainRef}>
            <RuleChapter chapter={active} idx={activeIdx} total={RB_CHAPTERS.length} h={h}
              onPrev={() => go(RB_CHAPTERS[Math.max(0, activeIdx - 1)].id)}
              onNext={() => go(RB_CHAPTERS[Math.min(RB_CHAPTERS.length - 1, activeIdx + 1)].id)} />
            {below.map((c) => <RuleAccordion key={c.id} chapter={c} onOpen={() => go(c.id)} />)}
            <div style={{ textAlign: 'center', fontSize: 13, color: RB.text2, fontStyle: 'italic', marginTop: 16 }}>That’s the whole game. Have fun.</div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <AtAGlance />
            <KeywordGlossary onGo={(id) => go(id)} />
            <StillStuck onGo={() => go('example-turn')} />
          </div>
        </div>
      </div>

      {/* Floating mute */}
      <button onClick={() => setMuted((m) => !m)} aria-label={muted ? 'Unmute' : 'Mute'} className="rb-anim"
        style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 20, width: 48, height: 48, borderRadius: '50%', display: 'grid', placeItems: 'center',
          background: RB.panel, border: `1px solid ${RB.borderStrong}`, color: RB.goldBright, cursor: 'pointer', fontSize: 18, boxShadow: '0 6px 20px rgba(0,0,0,0.5)' }}>
        {muted ? '🔇' : '🔊'}
      </button>

      {searchOpen && <RuleSearch onClose={() => setSearchOpen(false)} onSelect={(id, q) => { go(id, { hl: q }); setSearchOpen(false); }} />}
    </div>
  );
}

function RBParticles() {
  return (
    <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, background:
        `radial-gradient(60% 40% at 50% 0%, rgba(139,92,246,0.10), transparent 70%), radial-gradient(120% 90% at 50% 0%, ${RB.bgEl} 0%, ${RB.bg} 60%)` }} />
      {Array.from({ length: 12 }).map((_, i) => (
        <span key={i} className="rb-anim" style={{ position: 'absolute', left: `${(i * 61) % 100}%`, top: `${(i * 37) % 100}%`,
          width: 2 + (i % 3), height: 2 + (i % 3), borderRadius: '50%', background: i % 3 === 0 ? RB.violet : RB.gold, opacity: 0.35,
          boxShadow: `0 0 6px ${i % 3 === 0 ? RB.violet : RB.gold}` }} />
      ))}
    </div>
  );
}

function RulebookHeader({ onBack, onOpenSearch, isMac, narrow }: { onBack: () => void; onOpenSearch: () => void; isMac: boolean; narrow: boolean }) {
  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 12, height: 62, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      padding: '0 20px', background: 'rgba(9,8,26,0.82)', backdropFilter: 'blur(10px)', borderBottom: `1px solid ${RB.border}` }}>
      <button onClick={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderRadius: 9,
        background: RB.panel, border: `1px solid ${RB.border}`, color: RB.text, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>← Back</button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden style={{ color: RB.gold, opacity: 0.6 }}>◇</span>
        <span style={{ fontFamily: RULES_HEAD, fontWeight: 800, letterSpacing: '0.28em', fontSize: 15, color: RB.gold }}>RULEBOOK</span>
        <span aria-hidden style={{ color: RB.gold, opacity: 0.6 }}>◇</span>
      </div>
      <button onClick={onOpenSearch} aria-label="Search rules" style={{ display: 'flex', alignItems: 'center', gap: 8, width: narrow ? 'auto' : 300,
        padding: '9px 12px', borderRadius: 9, background: RB.panel, border: `1px solid ${RB.border}`, color: RB.text2, cursor: 'pointer', fontSize: 13 }}>
        <span aria-hidden>🔍</span>
        {!narrow && <span style={{ flex: 1, textAlign: 'left' }}>Search rules…</span>}
        <kbd style={{ padding: '2px 7px', fontSize: 11, background: 'rgba(0,0,0,0.4)', borderRadius: 5, color: RB.text2, border: `1px solid ${RB.border}` }}>{isMac ? '⌘ K' : 'Ctrl K'}</kbd>
      </button>
    </div>
  );
}

function TutorialPreview({ muted }: { muted: boolean }) {
  const vidRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState('');
  const play = () => { const v = vidRef.current; if (!v) return; v.play().then(() => setPlaying(true)).catch(() => {}); };
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', borderRadius: 14, overflow: 'hidden',
      border: `1px solid ${RB.border}`, boxShadow: '0 14px 40px rgba(0,0,0,0.5), 0 0 30px rgba(139,92,246,0.12)', background: '#000' }}>
      <video ref={vidRef} src="/rules-intro.mp4" poster="/intro.png" preload="metadata" playsInline controls={playing} muted={muted}
        aria-label="On-Chain Virtual Arena tutorial video" onLoadedMetadata={(e) => setDuration(fmt((e.currentTarget as HTMLVideoElement).duration || 0))}
        onPause={() => setPlaying(false)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      {!playing && (
        <button onClick={play} aria-label="Play tutorial" className="rb-anim" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
          background: 'linear-gradient(180deg, rgba(9,8,26,0.15), rgba(9,8,26,0.55))', border: 'none', cursor: 'pointer' }}>
          <span style={{ width: 74, height: 74, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'rgba(9,8,26,0.5)',
            border: `2px solid ${RB.goldBright}`, boxShadow: `0 0 26px ${RB.gold}88`, color: RB.goldBright, fontSize: 26, paddingLeft: 6 }}>▶</span>
          <div style={{ position: 'absolute', left: 14, bottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.14em', color: RB.gold }}>60-SECOND OVERVIEW</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>Watch tutorial</div>
          </div>
          {duration && <div style={{ position: 'absolute', right: 12, bottom: 12, padding: '3px 9px', borderRadius: 6, background: 'rgba(0,0,0,0.6)', border: `1px solid ${RB.border}`, fontSize: 12, color: RB.text }}>{duration}</div>}
        </button>
      )}
    </div>
  );
}

function QuickStartPath({ onGo, phone }: { onGo: (id: RBId) => void; phone: boolean }) {
  return (
    <div style={{ marginTop: 20, padding: phone ? '16px 12px' : '18px 22px', borderRadius: 16, background: RB.panel, border: `1px solid ${RB.border}` }}>
      <div style={{ textAlign: 'center', fontFamily: RULES_HEAD, fontWeight: 700, letterSpacing: '0.26em', fontSize: 14, color: RB.gold, marginBottom: 14 }}>◇ LEARN IN 30 SECONDS ◇</div>
      <div className={phone ? 'rb-snap rb-scroll' : ''} style={{ display: 'flex', alignItems: 'stretch', gap: phone ? 10 : 8, overflowX: phone ? 'auto' : 'visible' }}>
        {RB_QUICKSTART.map((s, i) => (
          <React.Fragment key={s.n}>
            <button onClick={() => onGo(s.to)} className="rb-anim" style={{ flex: phone ? '0 0 78%' : '1 1 0', minWidth: phone ? 220 : 0,
              display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 12, cursor: 'pointer', textAlign: 'left',
              background: RB.bgEl, border: `1px solid ${s.color}44`, color: RB.text, transition: 'transform .18s ease, box-shadow .18s ease' }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = `0 8px 20px -8px ${s.color}`; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}>
              <span style={{ width: 42, height: 42, flex: 'none', borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 900, fontSize: 17,
                color: '#0a0a14', background: `radial-gradient(circle at 35% 30%, ${s.color}, ${s.color}99)`, boxShadow: `0 0 16px ${s.color}66` }}>{s.n}</span>
              <span>
                <div style={{ fontSize: 14, fontWeight: 800, color: s.color }}>{s.title}</div>
                <div style={{ fontSize: 12, color: RB.text2 }}>{s.sub}</div>
              </span>
            </button>
            {i < RB_QUICKSTART.length - 1 && !phone && <span aria-hidden style={{ alignSelf: 'center', color: RB.gold, opacity: 0.5, fontSize: 16, flex: 'none' }}>→</span>}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function ChapterNavigation({ chapters, activeId, activeIdx, onGo }: { chapters: RBChapter[]; activeId: RBId; activeIdx: number; onGo: (id: RBId) => void }) {
  return (
    <nav aria-label="Chapters" style={{ position: 'sticky', top: 78, alignSelf: 'start', padding: 12, borderRadius: 14, background: RB.panel, border: `1px solid ${RB.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px 10px', borderBottom: `1px solid ${RB.border}`, marginBottom: 8 }}>
        <span style={{ fontFamily: RULES_HEAD, fontSize: 12, letterSpacing: '0.2em', fontWeight: 700, color: RB.gold }}>CHAPTERS</span>
        <span style={{ fontSize: 11, color: RB.text2 }}>{activeIdx + 1} of {chapters.length}</span>
      </div>
      <div style={{ position: 'relative' }}>
        <div aria-hidden style={{ position: 'absolute', left: 15, top: 8, bottom: 8, width: 2, background: RB.border }} />
        {chapters.map((c, i) => {
          const active = c.id === activeId;
          return (
            <button key={c.id} onClick={() => onGo(c.id)} aria-current={active ? 'true' : undefined} className="rb-anim"
              style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', marginBottom: 2,
                borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontFamily: RULES_FONT, fontSize: 13.5, fontWeight: active ? 700 : 500,
                color: active ? RB.goldBright : RB.text, background: active ? RB.panelActive : 'transparent',
                border: `1px solid ${active ? RB.borderStrong : 'transparent'}`, boxShadow: active ? `0 0 14px rgba(230,196,92,0.18)` : 'none', transition: 'all .18s ease' }}>
              <span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', flex: 'none', zIndex: 1,
                background: active ? RB.gold : (i < activeIdx ? RB.gold : RB.bgEl), border: `2px solid ${active || i < activeIdx ? RB.gold : RB.border}`,
                boxShadow: active ? `0 0 10px ${RB.gold}` : 'none' }} />
              <span aria-hidden style={{ fontSize: 15 }}>{c.icon}</span>
              <span>{c.title}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function ChapterDropdown({ chapters, activeId, onGo }: { chapters: RBChapter[]; activeId: RBId; onGo: (id: RBId) => void }) {
  return (
    <div style={{ padding: 12, borderRadius: 14, background: RB.panel, border: `1px solid ${RB.border}` }}>
      <label htmlFor="rb-chapter-select" style={{ display: 'block', fontFamily: RULES_HEAD, fontSize: 12, letterSpacing: '0.2em', fontWeight: 700, color: RB.gold, marginBottom: 8 }}>CHAPTERS</label>
      <select id="rb-chapter-select" value={activeId} onChange={(e) => onGo(e.target.value as RBId)}
        style={{ width: '100%', padding: '12px 12px', borderRadius: 9, background: RB.bgEl, border: `1px solid ${RB.border}`, color: RB.text, fontSize: 15, minHeight: 44 }}>
        {chapters.map((c) => <option key={c.id} value={c.id}>{c.num} · {c.title}</option>)}
      </select>
    </div>
  );
}

function RuleChapter({ chapter, idx, total, h, onPrev, onNext }: { chapter: RBChapter; idx: number; total: number; h: HL; onPrev: () => void; onNext: () => void }) {
  return (
    <section aria-labelledby={`rb-${chapter.id}-title`} style={{ padding: 22, borderRadius: 14, background: RB.panelActive, border: `1px solid ${RB.borderStrong}`, boxShadow: '0 14px 40px rgba(0,0,0,0.5)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
        <span aria-hidden style={{ width: 46, height: 46, flex: 'none', borderRadius: 11, display: 'grid', placeItems: 'center', fontSize: 22,
          background: 'linear-gradient(135deg, rgba(230,196,92,0.2), rgba(139,92,246,0.2))', border: `1px solid ${RB.border}` }}>{chapter.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.16em', color: RB.gold }}>CHAPTER {chapter.num}</div>
          <h2 id={`rb-${chapter.id}-title`} style={{ margin: 0, fontFamily: RULES_HEAD, fontWeight: 700, fontSize: 28, color: RB.text }}>{chapter.title}</h2>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onPrev} disabled={idx === 0} className="rb-anim" style={navBtn(idx === 0)}>← Previous</button>
          <button onClick={onNext} disabled={idx === total - 1} className="rb-anim" style={navBtn(idx === total - 1, true)}>Next →</button>
        </div>
      </div>
      <div style={{ fontSize: 15, lineHeight: 1.7, color: RB.text }}>{chapter.content(h)}</div>
    </section>
  );
}
function navBtn(disabled: boolean, primary?: boolean): React.CSSProperties {
  return { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 9, whiteSpace: 'nowrap',
    background: primary ? RB.bgEl : 'transparent', border: `1px solid ${RB.border}`, color: disabled ? RB.text2 : RB.text,
    cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: 12.5, opacity: disabled ? 0.5 : 1 };
}

function RuleAccordion({ chapter, onOpen }: { chapter: RBChapter; onOpen: () => void }) {
  return (
    <button onClick={onOpen} aria-expanded={false} aria-controls={`rb-${chapter.id}-title`} className="rb-anim"
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px', marginTop: 12, borderRadius: 12, cursor: 'pointer',
        background: RB.panel, border: `1px solid ${RB.border}`, color: RB.text, textAlign: 'left', minHeight: 44, transition: 'background .18s ease, border-color .18s ease' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = RB.panelHover; e.currentTarget.style.borderColor = RB.borderStrong; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = RB.panel; e.currentTarget.style.borderColor = RB.border; }}>
      <span style={{ fontFamily: RULES_HEAD, fontWeight: 800, fontSize: 22, color: RB.gold, flex: 'none' }}>{chapter.num}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontFamily: RULES_HEAD, fontWeight: 700, fontSize: 18, color: RB.text }}>{chapter.title}</span>
        <span style={{ display: 'block', fontSize: 13, color: RB.text2, marginTop: 2 }}>{chapter.summary}</span>
      </span>
      <span aria-hidden style={{ color: RB.gold, fontSize: 16, flex: 'none' }}>▾</span>
    </button>
  );
}

function RuleCallout({ title, text }: { title: string; text: string }) {
  return (
    <div style={{ marginTop: 16, display: 'flex', gap: 12, padding: '14px 16px', borderRadius: 12, background: 'rgba(230,196,92,0.06)', border: `1px solid ${RB.borderStrong}` }}>
      <span aria-hidden style={{ fontSize: 20, color: RB.gold }}>🛡️</span>
      <div>
        <div style={{ fontWeight: 800, color: RB.goldBright, fontSize: 14 }}>{title}</div>
        <div style={{ fontSize: 13.5, color: RB.text2, marginTop: 3 }}>{text}</div>
      </div>
    </div>
  );
}

function AtAGlance() {
  const rows = [
    { icon: '❤️', label: 'Starting Life', value: '20', color: RB.success },
    { icon: '🃏', label: 'Opening Hand', value: '7', color: RB.violet },
    { icon: '📚', label: 'Deck Size', value: '60', color: RB.blue },
  ];
  return (
    <div style={{ padding: 16, borderRadius: 14, background: RB.panel, border: `1px solid ${RB.border}` }}>
      <div style={{ fontFamily: RULES_HEAD, fontSize: 12, letterSpacing: '0.18em', fontWeight: 700, color: RB.gold, marginBottom: 12 }}>AT A GLANCE</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 8, borderBottom: `1px solid ${RB.border}` }}>
            <span aria-hidden style={{ fontSize: 16 }}>{r.icon}</span>
            <span style={{ flex: 1, fontSize: 13.5, color: RB.text2 }}>{r.label}</span>
            <span style={{ fontSize: 20, fontWeight: 800, color: r.color }}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function KeywordGlossary({ onGo }: { onGo: (id: RBId) => void }) {
  return (
    <div style={{ padding: 16, borderRadius: 14, background: RB.panel, border: `1px solid ${RB.border}` }}>
      <div style={{ fontFamily: RULES_HEAD, fontSize: 12, letterSpacing: '0.18em', fontWeight: 700, color: RB.gold, marginBottom: 12 }}>KEY TERMS</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {RB_KEY_TERMS.map((t) => (
          <button key={t.term} onClick={() => onGo(t.to)} className="rb-anim" style={{ padding: '7px 12px', borderRadius: 8, cursor: 'pointer',
            background: `${t.color}18`, border: `1px solid ${t.color}66`, color: t.color, fontWeight: 700, fontSize: 13 }}>{t.term}</button>
        ))}
      </div>
    </div>
  );
}

function StillStuck({ onGo }: { onGo: () => void }) {
  return (
    <div style={{ padding: 16, borderRadius: 14, background: 'linear-gradient(160deg, rgba(139,92,246,0.14), rgba(23,20,45,0.6))', border: `1px solid ${RB.border}` }}>
      <div style={{ fontFamily: RULES_HEAD, fontSize: 18, fontWeight: 700, color: RB.goldBright }}>Still stuck?</div>
      <div style={{ fontSize: 13.5, color: RB.text2, margin: '6px 0 14px' }}>See a full turn walkthrough.</div>
      <button onClick={onGo} className="rb-anim" style={{ width: '100%', padding: '12px', borderRadius: 10, cursor: 'pointer', minHeight: 44,
        background: 'transparent', border: `1px solid ${RB.borderStrong}`, color: RB.goldBright, fontWeight: 800, letterSpacing: '0.04em', fontSize: 13,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>View Example Turn →</button>
    </div>
  );
}

function RuleSearch({ onClose, onSelect }: { onClose: () => void; onSelect: (id: RBId, q: string) => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return RB_CHAPTERS.map((c) => ({ c, snippet: c.summary }));
    return RB_CHAPTERS.map((c) => {
      const hay = `${c.title} ${c.summary} ${c.search} ${c.keywords.join(' ')}`.toLowerCase();
      if (!hay.includes(query)) return null;
      const src = `${c.summary} ${c.search}`;
      const at = src.toLowerCase().indexOf(query);
      const snippet = at >= 0 ? '…' + src.slice(Math.max(0, at - 24), at + query.length + 30).trim() + '…' : c.summary;
      return { c, snippet };
    }).filter(Boolean) as { c: RBChapter; snippet: string }[];
  }, [q]);

  useEffect(() => { setSel(0); }, [q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[sel]) onSelect(results[sel].c.id, q); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };
  const hl = rbHighlight(q);

  return (
    <div onClick={onClose} role="dialog" aria-modal="true" aria-label="Search rules"
      style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(4,4,12,0.72)', backdropFilter: 'blur(4px)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '10vh 16px 16px' }}>
      <div onClick={(e) => e.stopPropagation()} onKeyDown={onKey} style={{ width: 'min(640px, 100%)', maxHeight: '76vh', display: 'flex', flexDirection: 'column',
        borderRadius: 14, background: RB.bgEl, border: `1px solid ${RB.borderStrong}`, boxShadow: '0 30px 80px rgba(0,0,0,0.6)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: `1px solid ${RB.border}` }}>
          <span aria-hidden style={{ color: RB.gold }}>🔍</span>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search rules… (combat, gas, summoning sickness)" aria-label="Search rules"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: RB.text, fontSize: 16, fontFamily: RULES_FONT }} />
          <kbd style={{ padding: '2px 7px', fontSize: 11, background: 'rgba(0,0,0,0.4)', borderRadius: 5, color: RB.text2 }}>Esc</kbd>
        </div>
        <div className="rb-scroll" role="listbox" style={{ overflowY: 'auto', padding: 8 }}>
          {results.length === 0 ? (
            <div style={{ padding: 26, textAlign: 'center', color: RB.text2 }}>
              <div style={{ fontSize: 26, marginBottom: 6 }} aria-hidden>🔎</div>
              No rules found for “{q}”. Try “combat”, “gas”, or “setup”.
            </div>
          ) : results.map((r, i) => (
            <button key={r.c.id} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => onSelect(r.c.id, q)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                background: i === sel ? RB.panelActive : 'transparent', border: `1px solid ${i === sel ? RB.borderStrong : 'transparent'}`, color: RB.text, marginBottom: 2 }}>
              <span aria-hidden style={{ fontSize: 18, flex: 'none' }}>{r.c.icon}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{hl(r.c.title)}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: RB.gold }}>CH {r.c.num}</span>
                </span>
                <span style={{ display: 'block', fontSize: 12.5, color: RB.text2, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hl(r.snippet)}</span>
              </span>
              <span aria-hidden style={{ color: RB.text2, fontSize: 12, flex: 'none' }}>↵</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Landing screen (post-login hub) ─────────────────────────────────────────
// ── Main menu hub design tokens (per concept palette) ───────────────────────
const MENU = {
  bg: '#080817', bgEl: '#0E1022', panel: 'rgba(17,19,40,0.88)', panelPurple: 'rgba(26,21,53,0.90)',
  gold: '#E6C45C', goldHi: '#FFD875', violet: '#8B5CF6', cyan: '#55D8FF', success: '#39E6B0',
  text: '#F6F3EB', text2: '#AAA5BA', border: 'rgba(230,196,92,0.22)', borderStrong: 'rgba(230,196,92,0.5)',
};
const MENU_SERIF = "'Cinzel', 'EB Garamond', Georgia, serif";

function mIco(p: React.ReactNode, size = 18) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{p}</svg>;
}
function nextUtcMidnight() { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); }
function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}
function fmtCountdown(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
type QueueMode = 'ranked' | 'casual';

function Landing({
  myName, onPlay, onMasterquest, onBoosters, onProfile, onRules, onLogout,
}: { myName: string; onPlay: () => void; onMasterquest: () => void; onBoosters: () => void; onProfile: () => void; onRules: () => void; onLogout: () => void }) {
  const mobile = useIsMobile(767);
  const tablet = useIsMobile(1279);
  const [prof, setProf] = useState<Profile | null>(null);
  const [ranked, setRanked] = useState<PublicRankedProfile | null>(null);
  const [season, setSeason] = useState<{ id: string; name: string; endsAt: number } | null>(null);
  const [players, setPlayers] = useState<number | null>(null);
  const [activeDeck, setActiveDeck] = useState<DeckEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<QueueMode>(() => (localStorage.getItem('ocva.queueMode') as QueueMode) || 'ranked');
  const [muted, setMuted] = useState<boolean>(() => { try { return localStorage.getItem('ocva.muted') === '1'; } catch { return false; } });
  const [copied, setCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const liveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const [p, r, s, all, decks] = await Promise.all([
        getProfileApi(myName).catch(() => null),
        RankedAPI.profile(myName).catch(() => null),
        RankedAPI.season().catch(() => null),
        listProfilesApi().catch(() => [] as Profile[]),
        listDecksApi(myName).catch(() => [] as DeckEntry[]),
      ]);
      if (!alive) return;
      setProf(p); setRanked(r);
      if (s) setSeason({ id: s.id, name: s.name, endsAt: s.endsAt });
      setPlayers(all.length);
      setActiveDeck(decks.find((d) => d.isActive) ?? decks[0] ?? null);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [myName]);

  useEffect(() => { try { localStorage.setItem('ocva.queueMode', mode); } catch {} }, [mode]);
  useEffect(() => {
    try { localStorage.setItem('ocva.muted', muted ? '1' : '0'); } catch {}
    document.querySelectorAll('audio,video').forEach((a) => { (a as HTMLMediaElement).muted = muted; });
  }, [muted]);

  const games = prof ? prof.wins + prof.losses + prof.draws : 0;
  const level = Math.max(1, Math.floor(Math.sqrt((games + 1) * 2.2)));
  const xpForLvl = (l: number) => Math.round((l + 1) * (l + 1) / 2.2);
  const xpPrev = xpForLvl(level - 1), xpNext = xpForLvl(level);
  const xpInto = games - xpPrev, xpRange = Math.max(1, xpNext - xpPrev);
  const placement = ranked?.placementMatchesRemaining ?? 0;

  const deckCards = activeDeck?.cards ?? [];
  const deckValid = activeDeck ? validateDeck(deckCards) : null;
  const deckState: 'missing' | 'invalid' | 'valid' = !activeDeck ? 'missing' : deckValid!.ok ? 'valid' : 'invalid';
  const deckFaction = deriveFavoriteFaction(deckCards);

  const copyAddr = async () => {
    if (!prof?.walletAddress) return;
    try { await navigator.clipboard.writeText(prof.walletAddress); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };

  const goCollection = () => { try { window.location.hash = 'collection'; } catch {} onProfile(); };

  const play = () => {
    // Always enter the matchmaking lobby — that's where deck selection (incl.
    // chain Standard decks), create/join, challenges and the ranked queue live.
    // Ranked still can't be queued with an invalid deck (enforced in the lobby).
    if (liveRef.current) liveRef.current.textContent = `Entering ${mode} matchmaking.`;
    onPlay();
  };

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: mobile ? 'auto' : 'hidden', background: MENU.bg, fontFamily: F.body, color: MENU.text }}>
      <style>{`@media (prefers-reduced-motion: reduce){ .menu-anim{ transition:none!important; animation:none!important; } }`}</style>
      <img src="/hub-bg.png?v=2" alt="" draggable={false}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center', userSelect: 'none', zIndex: 0 }} />
      <div aria-hidden style={{ position: 'absolute', inset: 0, zIndex: 0, background: 'radial-gradient(120% 80% at 50% 100%, rgba(8,8,23,0.6), transparent 60%)' }} />
      <div aria-live="polite" ref={liveRef} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }} />

      <PlayerHUD
        name={prof?.name ?? myName} avatarUrl={prof?.avatarUrl ?? null} level={level}
        xpInto={xpInto} xpRange={xpRange} placement={placement}
        rankLabel={ranked && placement === 0 ? rankLabel(ranked) : null}
        walletAddress={prof?.walletAddress ?? null} copied={copied} onCopy={copyAddr}
        muted={muted} onToggleMute={() => setMuted((m) => !m)} onSettings={() => setSettingsOpen(true)}
        loading={loading} mobile={mobile}
      />

      {/* Body panels */}
      <div style={{ position: 'relative', zIndex: 3, height: mobile ? 'auto' : '100%',
        display: mobile ? 'flex' : 'block', flexDirection: 'column', gap: 12,
        padding: mobile ? '76px 12px 90px' : 0 }}>
        <div style={mobile ? {} : { position: 'absolute', left: tablet ? 20 : 'clamp(24px, 4vw, 64px)', bottom: mobile ? undefined : 108, width: 'min(380px, 42vw)' }}>
          <MatchmakingPanel mode={mode} setMode={setMode} deckState={deckState} deckName={activeDeck?.name ?? null}
            deckCount={deckCards.length} deckFaction={deckFaction} deckIssue={deckValid?.issues?.[0]?.message ?? null}
            players={players} onPlay={play} onChangeDeck={() => { try { window.location.hash = 'decks'; } catch {} onProfile(); }}
            loading={loading} mobile={mobile} />
        </div>

        <div style={mobile ? {} : { position: 'absolute', right: tablet ? 20 : 'clamp(24px, 4vw, 64px)', bottom: mobile ? undefined : 108, width: 'min(340px, 40vw)' }}>
          <ActivityPanel season={season} placement={placement} ranked={ranked} onViewEvent={onMasterquest} loading={loading} mobile={mobile} />
        </div>
      </div>

      <NavDock onCollection={goCollection} onBoosters={onBoosters} onMasters={onMasterquest} onProfile={onProfile} onRules={onRules} onSettings={() => setSettingsOpen(true)} mobile={mobile} />

      <img src="/built-on-robinhood.png?v=2" alt="Built on Robinhood" draggable={false}
        style={{ position: mobile ? 'static' : 'absolute', zIndex: 2, left: '50%', bottom: mobile ? undefined : 70,
          transform: mobile ? 'none' : 'translateX(-50%)', margin: mobile ? '10px auto 0' : undefined, display: 'block',
          width: mobile ? 120 : 150, height: 'auto', pointerEvents: 'none', userSelect: 'none', opacity: 0.9,
          filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.6))' }} />

      {settingsOpen && (
        <SettingsMenu muted={muted} onToggleMute={() => setMuted((m) => !m)} onClose={() => setSettingsOpen(false)}
          onSignOut={() => { setSettingsOpen(false); setConfirmSignOut(true); }} onRules={onRules} />
      )}
      {confirmSignOut && (
        <ConfirmDialog title="Sign out?" body="You'll return to the sign-in screen. Your progress is saved to your profile."
          confirmLabel="SIGN OUT" onConfirm={onLogout} onCancel={() => setConfirmSignOut(false)} />
      )}
    </div>
  );
}

function PlayerHUD({ name, avatarUrl, level, xpInto, xpRange, placement, rankLabel: rl, walletAddress, copied, onCopy, muted, onToggleMute, onSettings, loading, mobile }: {
  name: string; avatarUrl: string | null; level: number; xpInto: number; xpRange: number; placement: number; rankLabel: string | null;
  walletAddress: string | null; copied: boolean; onCopy: () => void; muted: boolean; onToggleMute: () => void; onSettings: () => void; loading: boolean; mobile: boolean;
}) {
  const [notifOpen, setNotifOpen] = useState(false);
  const notifs: string[] = [];
  if (placement > 0) notifs.push(`${placement} placement matches left to earn your rank.`);
  const xpPct = Math.max(0, Math.min(100, Math.round((xpInto / xpRange) * 100)));
  const connected = !!walletAddress;
  return (
    <header style={{ position: mobile ? 'fixed' : 'absolute', top: 0, left: 0, right: 0, zIndex: 6, height: 66,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '0 16px',
      background: 'linear-gradient(180deg, rgba(6,6,18,0.92), rgba(6,6,18,0.62))', borderBottom: `1px solid ${MENU.border}`, backdropFilter: 'blur(8px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <div style={{ width: 44, height: 44, borderRadius: '50%', flex: 'none', padding: 2, background: `conic-gradient(from 0deg, ${MENU.gold}, ${MENU.violet}, ${MENU.gold})` }}>
          <div style={{ width: '100%', height: '100%', borderRadius: '50%', overflow: 'hidden', background: MENU.bgEl, display: 'grid', placeItems: 'center' }}>
            {avatarUrl ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <span style={{ fontWeight: 800, color: MENU.violet }}>{name.slice(0, 1).toUpperCase()}</span>}
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 800, fontSize: 15, letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>{name.toUpperCase()}</span>
            {!mobile && <span style={{ fontSize: 11, fontWeight: 800, color: MENU.goldHi, letterSpacing: '0.06em' }}>LEVEL {level}</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
            <div style={{ width: mobile ? 90 : 150, height: 5, borderRadius: 999, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
              <div className="menu-anim" style={{ width: `${loading ? 0 : xpPct}%`, height: '100%', background: `linear-gradient(90deg, ${MENU.gold}, ${MENU.violet})`, transition: 'width .3s ease' }} />
            </div>
            {!mobile && <span style={{ fontSize: 11, color: MENU.text2 }}>{xpInto} / {xpRange} XP</span>}
            <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.05em', color: placement > 0 ? MENU.goldHi : MENU.cyan,
              padding: '2px 8px', borderRadius: 999, background: `${placement > 0 ? MENU.gold : MENU.cyan}1c`, border: `1px solid ${placement > 0 ? MENU.gold : MENU.cyan}55`, whiteSpace: 'nowrap' }}>
              {placement > 0 ? `PLACEMENT · ${placement} LEFT` : (rl ? rl.toUpperCase() : 'UNRANKED')}
            </span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ position: 'relative' }}>
          <button onClick={() => setNotifOpen((v) => !v)} aria-label="Notifications" aria-expanded={notifOpen} style={hudBtn()}>
            {mIco(<><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>)}
            {notifs.length > 0 && <span aria-hidden style={{ position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: '50%', background: MENU.goldHi, boxShadow: `0 0 6px ${MENU.goldHi}` }} />}
          </button>
          {notifOpen && (
            <div role="menu" style={{ position: 'absolute', right: 0, top: 44, width: 260, padding: 12, borderRadius: 12, background: MENU.panel, border: `1px solid ${MENU.border}`, backdropFilter: 'blur(10px)', zIndex: 10 }}>
              <div style={{ fontWeight: 800, fontSize: 12, letterSpacing: '0.1em', color: MENU.text2, marginBottom: 8 }}>NOTIFICATIONS</div>
              {notifs.length === 0 ? <div style={{ fontSize: 13, color: MENU.text2 }}>You're all caught up.</div>
                : notifs.map((n, i) => <div key={i} style={{ fontSize: 13, padding: '6px 0', borderTop: i ? `1px solid ${MENU.border}` : 'none' }}>{n}</div>)}
            </div>
          )}
        </div>
        {connected ? (
          <button onClick={onCopy} title="Copy wallet address" style={{ ...hudBtn(), width: 'auto', gap: 8, padding: '0 12px', fontFamily: F.mono, fontSize: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: MENU.success, boxShadow: `0 0 6px ${MENU.success}` }} />
            {shortAddr(walletAddress!)}<span style={{ color: copied ? MENU.success : MENU.text2 }}>{copied ? '✓' : '⧉'}</span>
          </button>
        ) : (
          <span style={{ ...hudBtn(), width: 'auto', padding: '0 12px', fontSize: 12, color: MENU.text2 }}>Not linked</span>
        )}
        <button onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'} style={hudBtn()}>{muted ? mIco(<><path d="M11 5 6 9H2v6h4l5 4V5Z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></>) : mIco(<><path d="M11 5 6 9H2v6h4l5 4V5Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /></>)}</button>
        <button onClick={onSettings} aria-label="Settings" style={hudBtn()}>{mIco(<><circle cx="12" cy="12" r="3.2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></>)}</button>
      </div>
    </header>
  );
}
function hudBtn(): React.CSSProperties {
  return { width: 38, height: 38, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10,
    background: 'rgba(20,22,44,0.7)', border: `1px solid ${MENU.border}`, color: MENU.text, cursor: 'pointer' };
}

function MatchmakingPanel({ mode, setMode, deckState, deckName, deckCount, deckFaction, deckIssue, players, onPlay, onChangeDeck, loading, mobile }: {
  mode: QueueMode; setMode: (m: QueueMode) => void; deckState: 'missing' | 'invalid' | 'valid';
  deckName: string | null; deckCount: number; deckFaction: { name: string; color: string } | null; deckIssue: string | null;
  players: number | null; onPlay: () => void; onChangeDeck: () => void; loading: boolean; mobile: boolean;
}) {
  const modeDesc = mode === 'ranked' ? 'Competitive ladder · Best-of-one' : 'Casual play · no rank at stake';
  // The button always opens the lobby (deck selection + matchmaking live there);
  // the label reflects the current deck so the next step is clear.
  const playLabel = deckState === 'missing' ? 'CHOOSE A DECK' : deckState === 'invalid' ? 'FIX DECK & PLAY' : `PLAY ${mode.toUpperCase()}`;
  const canPlay = true;
  return (
    <section aria-label="Matchmaking" style={{ padding: 18, borderRadius: 16, background: MENU.panelPurple, border: `1px solid ${MENU.border}`, backdropFilter: 'blur(12px)', boxShadow: '0 20px 50px rgba(0,0,0,0.5)' }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.18em', color: MENU.gold }}>MATCHMAKING</div>
      <h2 style={{ margin: '4px 0 14px', fontFamily: MENU_SERIF, fontWeight: 700, fontSize: mobile ? 26 : 30, color: MENU.text }}>ENTER THE ARENA</h2>

      <div role="tablist" aria-label="Match mode" style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 12, background: 'rgba(8,8,22,0.6)', border: `1px solid ${MENU.border}` }}>
        {(['ranked', 'casual'] as QueueMode[]).map((m) => {
          const on = mode === m;
          return (
            <button key={m} role="tab" aria-selected={on} onClick={() => setMode(m)} className="menu-anim"
              style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px', borderRadius: 9, cursor: 'pointer',
                fontWeight: 800, letterSpacing: '0.06em', fontSize: 13, transition: 'all .18s ease',
                color: on ? '#20170a' : MENU.text2, background: on ? `linear-gradient(180deg, ${MENU.goldHi}, ${MENU.gold})` : 'transparent', border: 'none' }}>
              {m === 'ranked' ? mIco(<><path d="m14.5 17.5 5-5" /><path d="M3 21l6-6" /><path d="M14 3l7 7-4 4-7-7z" /></>, 15) : mIco(<><circle cx="12" cy="12" r="9" /><path d="m9 12 2 2 4-4" /></>, 15)}
              {m.toUpperCase()}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 12.5, color: MENU.text2, margin: '10px 2px 12px' }}>{modeDesc}</div>

      {/* Selected deck */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 12, background: 'rgba(8,8,22,0.55)', border: `1px solid ${MENU.border}` }}>
        <span style={{ width: 30, height: 30, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 900,
          background: `${deckFaction?.color ?? MENU.violet}22`, border: `1px solid ${deckFaction?.color ?? MENU.violet}88`, color: deckFaction?.color ?? MENU.violet }}>
          {(deckFaction?.name ?? '?').slice(0, 1)}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {loading ? 'Loading…' : deckName ? deckName.toUpperCase() : 'NO DECK SELECTED'}
          </div>
          <div style={{ fontSize: 11.5, color: deckState === 'valid' ? MENU.success : deckState === 'invalid' ? '#FF616F' : MENU.text2 }}>
            {deckName ? `${deckCount} / ${DECK_SIZE} cards` : 'Pick a deck to play'}{deckState === 'valid' ? ' · ready' : deckState === 'invalid' ? ' · incomplete' : ''}
          </div>
        </div>
        <button onClick={onChangeDeck} style={{ background: 'none', border: 'none', color: MENU.violet, cursor: 'pointer', fontWeight: 800, fontSize: 11, letterSpacing: '0.06em' }}>CHANGE DECK</button>
      </div>
      {deckState === 'invalid' && deckIssue && <div style={{ fontSize: 11.5, color: '#FF616F', margin: '8px 2px 0' }}>⚠ {deckIssue}</div>}

      <button onClick={onPlay} disabled={!canPlay} aria-disabled={!canPlay} className="menu-anim"
        style={{ width: '100%', marginTop: 14, padding: '15px', borderRadius: 12, cursor: canPlay ? 'pointer' : 'not-allowed',
          fontFamily: MENU_SERIF, fontWeight: 800, fontSize: 17, letterSpacing: '0.06em', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          color: canPlay ? '#20170a' : '#efe6c9aa', background: canPlay ? `linear-gradient(180deg, ${MENU.goldHi}, ${MENU.gold} 55%, #b8912f)` : 'linear-gradient(180deg,#4a4028,#332b18)',
          border: `1px solid ${canPlay ? '#8a6d24' : '#5a4c30'}`, boxShadow: canPlay ? `0 8px 26px rgba(230,196,92,0.4)` : 'none', transition: 'transform .15s ease, box-shadow .2s ease' }}
        onMouseDown={(e) => { if (canPlay) e.currentTarget.style.transform = 'translateY(1px)'; }}
        onMouseUp={(e) => { e.currentTarget.style.transform = 'none'; }} onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; }}>
        {canPlay && mIco(<><path d="m14.5 17.5 5-5" /><path d="M3 21l6-6" /><path d="M14 3l7 7-4 4-7-7z" /></>, 18)}
        {playLabel}
      </button>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 12, fontSize: 12, color: MENU.text2 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: MENU.success, boxShadow: `0 0 6px ${MENU.success}` }} />
        {players == null ? '…' : players} player{players === 1 ? '' : 's'} online
      </div>
    </section>
  );
}

function ActivityPanel({ season, placement, ranked, onViewEvent, loading, mobile }: {
  season: { id: string; name: string; endsAt: number } | null; placement: number; ranked: PublicRankedProfile | null; onViewEvent: () => void; loading: boolean; mobile: boolean;
}) {
  const now = useNow(1000);
  const eventMs = nextUtcMidnight() - now;
  // Real daily-quest tracker: won a match today? (set by the match-result flow)
  const dayKey = todayKey();
  const [questDone, setQuestDone] = useState<boolean>(() => { try { return localStorage.getItem(`ocva.daily.${dayKey}.win`) === '1'; } catch { return false; } });
  useEffect(() => {
    const check = () => { try { setQuestDone(localStorage.getItem(`ocva.daily.${dayKey}.win`) === '1'); } catch {} };
    const t = setInterval(check, 5000); window.addEventListener('focus', check);
    return () => { clearInterval(t); window.removeEventListener('focus', check); };
  }, [dayKey]);
  const placementDone = Math.max(0, 10 - placement);

  return (
    <aside aria-label="Activity" style={{ display: 'flex', flexDirection: mobile ? 'row' : 'column', gap: 12, overflowX: mobile ? 'auto' : 'visible' }}>
      <ActCard title={`SEASON ${season ? String(season.name).replace(/\D/g, '') || '01' : '01'}`} mobile={mobile}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: MENU_SERIF, fontWeight: 700, fontSize: 16, color: MENU.goldHi }}>{placement > 0 ? 'PLACEMENT' : (ranked ? rankLabel(ranked) : 'UNRANKED')}</span>
        </div>
        {placement > 0 ? (
          <>
            <div style={{ fontSize: 12, color: MENU.text2, margin: '2px 0 8px' }}>{placement} matches left</div>
            <Bar pct={loading ? 0 : (placementDone / 10) * 100} />
            <div style={{ fontSize: 11, color: MENU.text2, marginTop: 4, textAlign: 'right' }}>{placementDone} / 10</div>
          </>
        ) : <div style={{ fontSize: 12, color: MENU.text2, marginTop: 4 }}>Ranked placement complete.</div>}
      </ActCard>

      <ActCard title="DAILY QUEST" mobile={mobile}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>Win 1 match</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }}>
          <Bar pct={questDone ? 100 : 0} />
          <span style={{ fontSize: 11, color: MENU.text2, whiteSpace: 'nowrap' }}>{questDone ? '1 / 1' : '0 / 1'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: MENU.cyan }}>+100 XP</span>
          {questDone && <span style={{ fontSize: 11, fontWeight: 800, color: MENU.success }}>✓ COMPLETE</span>}
        </div>
      </ActCard>

      <ActCard title="NEXT EVENT" mobile={mobile}>
        <div style={{ fontFamily: MENU_SERIF, fontWeight: 700, fontSize: 16, color: MENU.text }}>DAILY $MASTER CUP</div>
        <div style={{ fontFamily: F.mono, fontSize: 20, fontWeight: 700, color: MENU.cyan, margin: '4px 0 8px', letterSpacing: '0.04em' }}>{fmtCountdown(eventMs)}</div>
        <button onClick={onViewEvent} style={{ background: 'none', border: 'none', color: MENU.violet, cursor: 'pointer', fontWeight: 800, fontSize: 11.5, letterSpacing: '0.06em', display: 'inline-flex', alignItems: 'center', gap: 6 }}>VIEW EVENT →</button>
      </ActCard>
    </aside>
  );
}
function ActCard({ title, children, mobile }: { title: string; children: React.ReactNode; mobile: boolean }) {
  return (
    <div style={{ flex: mobile ? '0 0 78%' : 'none', minWidth: mobile ? 220 : 0, padding: 14, borderRadius: 14, background: MENU.panel, border: `1px solid ${MENU.border}`, backdropFilter: 'blur(10px)' }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.14em', color: MENU.gold, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}
function Bar({ pct }: { pct: number }) {
  return <div style={{ flex: 1, height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
    <div className="menu-anim" style={{ width: `${pct}%`, height: '100%', background: `linear-gradient(90deg, ${MENU.gold}, ${MENU.violet})`, transition: 'width .3s ease' }} />
  </div>;
}

function NavDock({ onCollection, onBoosters, onMasters, onProfile, onRules, onSettings, mobile }: {
  onCollection: () => void; onBoosters: () => void; onMasters: () => void; onProfile: () => void; onRules: () => void; onSettings: () => void; mobile: boolean;
}) {
  const primary = [
    { label: 'Collection', icon: mIco(<><path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" /><path d="m3 8 9 5 9-5" /><path d="M12 13v8" /></>, 20), onClick: onCollection },
    { label: 'Boosters', icon: mIco(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M4 9h16" /><path d="M12 3v18" /></>, 20), onClick: onBoosters },
    { label: 'Masters', icon: mIco(<><path d="M6 9a6 6 0 0 0 12 0V4H6Z" /><path d="M6 5H3v2a3 3 0 0 0 3 3" /><path d="M18 5h3v2a3 3 0 0 1-3 3" /><path d="M12 15v4" /><path d="M8 21h8" /></>, 20), onClick: onMasters },
    { label: 'Profile', icon: mIco(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>, 20), onClick: onProfile },
  ];
  const utils = [
    { label: 'Rulebook', icon: mIco(<><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2Z" /><path d="M4 19a2 2 0 0 1 2-2h13" /></>, 20), onClick: onRules },
    { label: 'Settings', icon: mIco(<><circle cx="12" cy="12" r="3.2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></>, 20), onClick: onSettings },
  ];
  const Item = ({ it }: { it: { label: string; icon: React.ReactNode; onClick: () => void } }) => (
    <button onClick={it.onClick} title={it.label} aria-label={it.label} className="menu-anim ova-dock-item"
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 14px', minWidth: 62, minHeight: 44, borderRadius: 10,
        background: 'none', border: 'none', color: MENU.text2, cursor: 'pointer', transition: 'color .18s ease, background .18s ease' }}
      onMouseEnter={(e) => { e.currentTarget.style.color = MENU.goldHi; e.currentTarget.style.background = 'rgba(230,196,92,0.08)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = MENU.text2; e.currentTarget.style.background = 'none'; }}>
      {it.icon}
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em' }}>{it.label.toUpperCase()}</span>
    </button>
  );
  return (
    <nav aria-label="Main navigation" style={{ position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: mobile ? 'calc(6px + env(safe-area-inset-bottom))' : 14, zIndex: 6,
      display: 'flex', alignItems: 'center', gap: 2, padding: '6px 10px', borderRadius: 16, maxWidth: 'calc(100vw - 16px)', overflowX: 'auto',
      background: 'rgba(10,11,26,0.9)', border: `1px solid ${MENU.border}`, backdropFilter: 'blur(12px)', boxShadow: '0 12px 30px rgba(0,0,0,0.5)' }}>
      {primary.map((it) => <Item key={it.label} it={it} />)}
      <span aria-hidden style={{ width: 1, height: 34, background: MENU.border, margin: '0 6px', flex: 'none' }} />
      {utils.map((it) => <Item key={it.label} it={it} />)}
    </nav>
  );
}

function SettingsMenu({ muted, onToggleMute, onClose, onSignOut, onRules }: { muted: boolean; onToggleMute: () => void; onClose: () => void; onSignOut: () => void; onRules: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 30, background: 'rgba(4,4,12,0.6)', backdropFilter: 'blur(4px)', display: 'grid', placeItems: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(360px, 100%)', borderRadius: 16, background: MENU.bgEl, border: `1px solid ${MENU.border}`, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <span style={{ fontFamily: MENU_SERIF, fontWeight: 700, fontSize: 18, color: MENU.goldHi }}>Settings</span>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: MENU.text2, fontSize: 22, cursor: 'pointer' }}>×</button>
        </div>
        <button onClick={onToggleMute} style={settingsRow()}><span>Sound</span><span style={{ color: muted ? MENU.text2 : MENU.success, fontWeight: 700 }}>{muted ? 'Off' : 'On'}</span></button>
        <button onClick={() => { onClose(); onRules(); }} style={settingsRow()}><span>Rulebook</span><span style={{ color: MENU.text2 }}>→</span></button>
        <button onClick={onSignOut} style={{ ...settingsRow(), color: '#FF616F' }}><span>Sign out</span><span>→</span></button>
      </div>
    </div>
  );
}
function settingsRow(): React.CSSProperties {
  return { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 14px', marginBottom: 8, minHeight: 44,
    borderRadius: 10, background: MENU.panel, border: `1px solid ${MENU.border}`, color: MENU.text, cursor: 'pointer', fontSize: 14, fontWeight: 600 };
}

function ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel }: { title: string; body: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(4,4,12,0.7)', backdropFilter: 'blur(4px)', display: 'grid', placeItems: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(400px, 100%)', borderRadius: 16, background: MENU.bgEl, border: `1px solid ${MENU.border}`, padding: 22 }}>
        <div style={{ fontFamily: MENU_SERIF, fontWeight: 700, fontSize: 20 }}>{title}</div>
        <div style={{ color: MENU.text2, fontSize: 13.5, marginTop: 8, lineHeight: 1.5 }}>{body}</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
          <button onClick={onCancel} style={{ padding: '10px 18px', borderRadius: 10, background: MENU.panel, border: `1px solid ${MENU.border}`, color: MENU.text, cursor: 'pointer', fontWeight: 700 }}>CANCEL</button>
          <button onClick={onConfirm} style={{ padding: '10px 18px', borderRadius: 10, background: '#FF616F', border: 'none', color: '#fff', cursor: 'pointer', fontWeight: 800 }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function ContractAddressFooter() {
  const mobile = useIsMobile();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(MASTER_TOKEN_ADDRESS);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  }
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 3,
      padding: mobile ? '6px 10px' : '8px 18px',
      background: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.85) 60%)',
      display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10,
      flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, color: '#ffb347', textShadow: '0 1px 4px #000' }}>
        $MASTER CA:
      </span>
      <button
        onClick={copy}
        title="Click to copy"
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: mobile ? 10 : 12, color: '#fff', fontWeight: 600,
          background: 'rgba(20,20,20,0.7)',
          border: '1px solid rgba(255,179,71,0.45)', borderRadius: 4,
          padding: mobile ? '3px 6px' : '4px 8px',
          cursor: 'pointer', letterSpacing: 0.4,
          maxWidth: '92vw', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >{MASTER_TOKEN_ADDRESS}</button>
      <span style={{ fontSize: 11, color: copied ? '#7fffa0' : '#888', minWidth: 50 }}>
        {copied ? '✓ copied' : '(click to copy)'}
      </span>
    </div>
  );
}

// Inline SVG icons for the main menu (no icon-library dependency).
const svg = (path: React.ReactNode) => (
  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{path}</svg>
);
const MENU_ICONS = {
  play: svg(<polygon points="6 4 20 12 6 20 6 4" />),
  map:  svg(<><polygon points="9 4 15 6 21 4 21 18 15 20 9 18 3 20 3 6 9 4" /><line x1="9" y1="4" x2="9" y2="18" /><line x1="15" y1="6" x2="15" y2="20" /></>),
  box:  svg(<><path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" /><path d="M3 8l9 5 9-5" /><path d="M12 13v8" /></>),
  user: svg(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>),
  book: svg(<><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2Z" /><path d="M4 19a2 2 0 0 1 2-2h13" /></>),
  news: svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="7" y1="9" x2="13" y2="9" /><line x1="7" y1="13" x2="17" y2="13" /><line x1="7" y1="17" x2="17" y2="17" /></>),
  chevron: svg(<polyline points="9 6 15 12 9 18" />),
};

function MenuRow({ icon, label, desc, onClick, primary }: {
  icon: React.ReactNode; label: string; desc: string; onClick: () => void; primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="ocva-card ocva-card--hover"
      style={{
        display: 'flex', alignItems: 'center', gap: 14, width: '100%', textAlign: 'left',
        cursor: 'pointer', padding: '13px 15px', fontFamily: F.body, color: C.textHi,
        background: primary
          ? 'linear-gradient(135deg, rgba(124,92,255,0.24), rgba(124,92,255,0.08))'
          : 'rgba(18,18,31,0.72)',
        borderColor: primary ? C.accent : C.border,
        backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      }}
    >
      <span style={{
        flex: '0 0 auto', width: 38, height: 38, borderRadius: 10,
        display: 'grid', placeItems: 'center',
        background: primary ? 'rgba(124,92,255,0.28)' : C.bg3,
        color: primary ? C.accentHi : C.textMid,
      }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 700, fontSize: 15, letterSpacing: '0.005em' }}>{label}</span>
        <span style={{ display: 'block', fontSize: 12, color: C.textLo, marginTop: 1 }}>{desc}</span>
      </span>
      <span style={{ flex: '0 0 auto', color: primary ? C.accentHi : C.textLo }}>{MENU_ICONS.chevron}</span>
    </button>
  );
}

// ── Profile page ────────────────────────────────────────────────────────────
// ── On-Chain Virtual Arena profile hub ──────────────────────────────────────
// A compact, app-style profile with four tabs (Overview / Decks / Collection /
// Achievements) that replaces the old long vertical scroll. Wired entirely to
// live data: profile, ranked stats, and the multi-deck backend.
const HUB = {
  bg: '#050711', surface: '#080D18', raised: '#0C1220',
  gold: '#E5B84B', goldHi: '#FFD86A', purple: '#8E4DFF', violet: '#C45CFF',
  cyan: '#19D3D2', green: '#39E879', red: '#E0525E', text: '#F4F2EA', muted: '#989BB0',
  border: '#1b2540', borderHi: '#2b3a5c',
};
const HUB_SERIF = "'Cinzel', 'EB Garamond', Georgia, serif";
const HUB_SANS = "'Inter', system-ui, -apple-system, sans-serif";

type HubTab = 'overview' | 'decks' | 'collection' | 'achievements';
const HUB_TABS: HubTab[] = ['overview', 'decks', 'collection', 'achievements'];

function readHubTab(): HubTab {
  const h = (typeof window !== 'undefined' ? window.location.hash : '').replace('#', '').toLowerCase();
  return (HUB_TABS as string[]).includes(h) ? (h as HubTab) : 'overview';
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function ProfilePage({ myName, onBack }: { myName: string; onBack: () => void }) {
  const mobile = useIsMobile(920);
  const [prof, setProf] = useState<Profile | null>(null);
  const [ranked, setRanked] = useState<any | null>(null);
  const [decks, setDecks] = useState<DeckEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<HubTab>(readHubTab);
  const [muted, setMuted] = useState<boolean>(() => { try { return localStorage.getItem('ocva.muted') === '1'; } catch { return false; } });
  const [copied, setCopied] = useState(false);

  const reload = useCallback(async () => {
    let p = await getProfileApi(myName);
    if (!p) p = await upsertProfileApi(myName);
    setProf(p);
  }, [myName]);

  const reloadDecks = useCallback(async () => {
    try { setDecks(await listDecksApi(myName)); } catch { setDecks([]); }
  }, [myName]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        await reload();
        try { setRanked(await RankedAPI.profile(myName).catch(() => null)); } catch { setRanked(null); }
        await reloadDecks();
      } finally { setLoading(false); }
    })();
  }, [myName, reload, reloadDecks]);

  // Persist active tab in the URL hash so it survives refresh and is linkable.
  useEffect(() => { try { if (readHubTab() !== tab) window.history.replaceState(null, '', `#${tab}`); } catch {} }, [tab]);
  useEffect(() => {
    const onHash = () => setTab(readHubTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    try { localStorage.setItem('ocva.muted', muted ? '1' : '0'); } catch {}
    document.querySelectorAll('audio').forEach((a) => { (a as HTMLAudioElement).muted = muted; });
  }, [muted]);

  const activeDeck = decks.find((d) => d.isActive) ?? null;
  const favoriteCards = activeDeck?.cards ?? [];

  const games  = prof ? prof.wins + prof.losses + prof.draws : 0;
  const winPct = games ? Math.round((prof!.wins / games) * 100) : 0;
  const level  = Math.max(1, Math.floor(Math.sqrt((games + 1) * 2.2)));
  const xpForNextLevel = (lvl: number) => Math.round((lvl + 1) * (lvl + 1) / 2.2);
  const xpPrev = xpForNextLevel(level - 1);
  const xpNext = xpForNextLevel(level);
  const xpPct  = Math.max(0, Math.min(100, Math.round(((games - xpPrev) / Math.max(1, xpNext - xpPrev)) * 100)));

  const copyAddr = async () => {
    if (!prof?.walletAddress) return;
    try { await navigator.clipboard.writeText(prof.walletAddress); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };

  return (
    <div style={{ position: 'fixed', inset: 0, height: '100dvh', display: 'flex', flexDirection: 'column',
      overflow: mobile ? 'auto' : 'hidden', background: HUB.bg, color: HUB.text, fontFamily: HUB_SANS }}>
      <style>{`
        @media (prefers-reduced-motion: reduce) { .hub-anim { transition: none !important; animation: none !important; } }
        .hub-scroll::-webkit-scrollbar { width: 9px; height: 9px; }
        .hub-scroll::-webkit-scrollbar-thumb { background: ${HUB.borderHi}; border-radius: 5px; }
      `}</style>
      <HubBackdrop />

      <HubTopNav
        tab={tab} setTab={(t) => setTab(t)} onBack={onBack} onEdit={() => setEditing(true)}
        walletAddress={prof?.walletAddress ?? null} copied={copied} onCopy={copyAddr}
        muted={muted} onToggleMute={() => setMuted((m) => !m)}
      />

      {loading ? (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: HUB.muted, position: 'relative', zIndex: 1 }}>Loading profile…</div>
      ) : (
        <div style={{ position: 'relative', zIndex: 1, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
          gap: 12, padding: mobile ? '12px 12px 32px' : '14px 22px 18px', maxWidth: 1680, width: '100%', margin: '0 auto' }}>
          <IdentityBar
            name={prof?.name ?? myName} avatarUrl={prof?.avatarUrl ?? null}
            placement={ranked?.placementMatchesRemaining ?? 0}
            rankLabel={ranked ? formatRankLabel(ranked) : 'Unranked'}
            level={level} xpPct={xpPct} xpInto={games - xpPrev} xpRange={xpNext - xpPrev}
            wins={prof?.wins ?? 0} losses={prof?.losses ?? 0} winPct={winPct} games={games}
            favoriteDeckName={activeDeck?.name ?? null} favoriteFaction={deriveFavoriteFaction(favoriteCards)}
            onOpenDecks={() => setTab('decks')}
          />

          <div style={{ flex: 1, minHeight: 0 }}>
            {tab === 'overview' && (
              <OverviewTab prof={prof} ranked={ranked} winPct={winPct} games={games} level={level}
                xpPct={xpPct} favoriteDeck={activeDeck} favoriteFaction={deriveFavoriteFaction(favoriteCards)}
                onBuildDeck={() => setTab('decks')} mobile={mobile} />
            )}
            {tab === 'decks' && (
              <DeckWorkspace myName={myName} mobile={mobile} onDecksChanged={reloadDecks} />
            )}
            {tab === 'collection' && (
              <CollectionTab walletAddress={prof?.walletAddress ?? null} mobile={mobile} />
            )}
            {tab === 'achievements' && (
              <AchievementsTab prof={prof} ranked={ranked} deck={favoriteCards} mobile={mobile} />
            )}
          </div>
        </div>
      )}

      {editing && prof && (
        <ProfileEditModal prof={prof} onClose={() => setEditing(false)}
          onSaved={async () => { await reload(); setEditing(false); }} />
      )}
    </div>
  );
}

function HubBackdrop() {
  return (
    <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, background:
        `radial-gradient(60% 45% at 50% 0%, rgba(142,77,255,0.10), transparent 70%),
         radial-gradient(120% 90% at 50% 0%, #0a0d1c 0%, ${HUB.bg} 60%)` }} />
      <div style={{ position: 'absolute', inset: 0, opacity: 0.4, background:
        'repeating-linear-gradient(90deg, transparent 0 14%, rgba(229,184,75,0.03) 14% 14.3%, transparent 14.3% 28%)' }} />
      <div style={{ position: 'absolute', inset: 0, boxShadow: 'inset 0 0 200px 40px rgba(0,0,0,0.7)' }} />
    </div>
  );
}

// ── Top navigation (~60px) ──────────────────────────────────────────────────
function HubTopNav({ tab, setTab, onBack, onEdit, walletAddress, copied, onCopy, muted, onToggleMute }: {
  tab: HubTab; setTab: (t: HubTab) => void; onBack: () => void; onEdit: () => void;
  walletAddress: string | null; copied: boolean; onCopy: () => void; muted: boolean; onToggleMute: () => void;
}) {
  const connected = !!walletAddress;
  const isEvm = !!walletAddress?.startsWith('0x');
  const dot = connected ? HUB.cyan : HUB.red;
  const net = connected ? (isEvm ? 'Robinhood Chain' : 'Solana') : 'Disconnected';
  return (
    <div style={{ position: 'relative', zIndex: 5, height: 60, flex: '0 0 60px', display: 'flex', alignItems: 'center',
      gap: 14, padding: '0 18px', background: 'rgba(6,8,18,0.75)', backdropFilter: 'blur(10px)', borderBottom: `1px solid ${HUB.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
        <HubEmblem size={28} />
        <div style={{ lineHeight: 1 }}>
          <div style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: 10, letterSpacing: '0.2em', color: HUB.muted }}>ON-CHAIN</div>
          <div style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: 13, letterSpacing: '0.1em', color: HUB.goldHi }}>VIRTUAL ARENA</div>
        </div>
        <button onClick={onBack} style={{ marginLeft: 8, background: 'none', border: 'none', color: HUB.muted, cursor: 'pointer', fontWeight: 700, letterSpacing: '0.08em', fontSize: 12 }}>← LOBBY</button>
      </div>

      <nav style={{ display: 'flex', alignItems: 'center', gap: 4 }} aria-label="Profile sections">
        {HUB_TABS.map((t) => {
          const active = tab === t;
          return (
            <button key={t} onClick={() => setTab(t)} aria-current={active ? 'page' : undefined}
              className="hub-anim"
              style={{ position: 'relative', background: 'none', border: 'none', cursor: 'pointer',
                padding: '18px 14px', fontFamily: HUB_SANS, fontWeight: 800, fontSize: 12.5, letterSpacing: '0.1em',
                color: active ? HUB.text : HUB.muted, transition: 'color .18s ease', textTransform: 'uppercase' }}>
              {t}
              {active && <span aria-hidden style={{ position: 'absolute', left: 10, right: 10, bottom: 10, height: 2, borderRadius: 2,
                background: `linear-gradient(90deg, ${HUB.gold}, ${HUB.violet})`, boxShadow: `0 0 12px ${HUB.violet}aa` }} />}
            </button>
          );
        })}
      </nav>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'flex-end', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 11px', borderRadius: 999, background: HUB.raised, border: `1px solid ${HUB.border}` }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, boxShadow: `0 0 8px ${dot}` }} />
          <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{net}</span>
        </div>
        {walletAddress && (
          <button onClick={onCopy} title="Copy wallet address" style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 11px',
            borderRadius: 999, background: HUB.raised, border: `1px solid ${HUB.border}`, color: HUB.text, cursor: 'pointer', fontFamily: F.mono, fontSize: 12 }}>
            {shortAddr(walletAddress)} <span style={{ color: copied ? HUB.green : HUB.muted }}>{copied ? '✓' : '⧉'}</span>
          </button>
        )}
        <button onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'} style={{ width: 34, height: 34, display: 'grid', placeItems: 'center',
          borderRadius: 9, background: HUB.raised, border: `1px solid ${HUB.gold}44`, color: HUB.goldHi, cursor: 'pointer', fontSize: 14 }}>{muted ? '🔇' : '🔊'}</button>
        <button onClick={onEdit} style={{ padding: '8px 14px', borderRadius: 9, background: 'transparent', border: `1px solid ${HUB.gold}`,
          color: HUB.goldHi, cursor: 'pointer', fontWeight: 800, letterSpacing: '0.06em', fontSize: 11.5 }}>EDIT PROFILE</button>
      </div>
    </div>
  );
}

function HubEmblem({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden>
      <defs><linearGradient id="hub-emb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={HUB.goldHi} /><stop offset="1" stopColor="#b98f34" /></linearGradient></defs>
      <path d="M50 6 L86 28 V72 L50 94 L14 72 V28 Z" stroke="url(#hub-emb)" strokeWidth="5" />
      <path d="M50 30 L66 42 L50 54 L34 42 Z" fill="url(#hub-emb)" />
      <path d="M50 56 L66 68 L50 80 L34 68 Z" fill={HUB.purple} opacity="0.85" />
    </svg>
  );
}

// ── Identity bar (~140px) ───────────────────────────────────────────────────
function IdentityBar(props: {
  name: string; avatarUrl: string | null; placement: number; rankLabel: string;
  level: number; xpPct: number; xpInto: number; xpRange: number;
  wins: number; losses: number; winPct: number; games: number;
  favoriteDeckName: string | null; favoriteFaction: { name: string; color: string } | null; onOpenDecks: () => void;
}) {
  const { name, avatarUrl, placement, level, xpPct, xpInto, xpRange, wins, losses, winPct, games, favoriteDeckName, favoriteFaction, onOpenDecks } = props;
  const stats: Array<{ label: string; value: string; color?: string }> = [
    { label: 'WINS', value: String(wins), color: HUB.green },
    { label: 'LOSSES', value: String(losses), color: HUB.red },
    { label: 'WIN RATE', value: `${winPct}%`, color: HUB.violet },
    { label: 'GAMES', value: String(games) },
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '14px 18px', borderRadius: 14,
      background: `linear-gradient(180deg, ${HUB.surface}, ${HUB.raised})`, border: `1px solid ${HUB.gold}33`,
      minHeight: 120, flexWrap: 'wrap' }}>
      <div style={{ position: 'relative', width: 84, height: 84, borderRadius: '50%', flex: 'none',
        background: `conic-gradient(from 0deg, ${HUB.gold}, ${HUB.violet}, ${HUB.gold})`, padding: 3 }}>
        <div style={{ width: '100%', height: '100%', borderRadius: '50%', overflow: 'hidden', background: HUB.bg, display: 'grid', placeItems: 'center' }}>
          {avatarUrl ? <img src={avatarUrl} alt={`${name} avatar`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ fontSize: 30, fontWeight: 800, color: HUB.violet }}>{name.slice(0, 1).toUpperCase()}</span>}
        </div>
      </div>

      <div style={{ minWidth: 220, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: 26, color: HUB.text }}>{name}</span>
          <span style={{ padding: '4px 10px', borderRadius: 999, background: `${HUB.gold}1c`, border: `1px solid ${HUB.gold}66`,
            color: HUB.goldHi, fontSize: 11, fontWeight: 700, letterSpacing: '0.05em' }}>
            {placement > 0 ? `PLACEMENT · ${placement} LEFT` : props.rankLabel.toUpperCase()}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: HUB.goldHi, letterSpacing: '0.06em' }}>LEVEL {level}</span>
          <div style={{ flex: 1, maxWidth: 260, height: 6, borderRadius: 999, background: HUB.raised, border: `1px solid ${HUB.border}`, overflow: 'hidden' }}>
            <div className="hub-anim" style={{ width: `${xpPct}%`, height: '100%', background: `linear-gradient(90deg, ${HUB.gold}, ${HUB.violet})`, transition: 'width .3s ease' }} />
          </div>
          <span style={{ fontSize: 11, color: HUB.muted }}>{xpInto} / {xpRange} XP</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {stats.map((s) => (
          <div key={s.label} style={{ minWidth: 84, textAlign: 'center', padding: '10px 14px', borderRadius: 12,
            background: HUB.raised, border: `1px solid ${HUB.border}` }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: s.color ?? HUB.text, lineHeight: 1 }}>{s.value}</div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: HUB.muted, marginTop: 5 }}>{s.label}</div>
          </div>
        ))}
        <button onClick={onOpenDecks} title="Open deck builder" style={{ minWidth: 150, textAlign: 'left', padding: '10px 14px', borderRadius: 12,
          background: HUB.raised, border: `1px solid ${favoriteDeckName ? HUB.gold + '55' : HUB.border}`, cursor: 'pointer', color: HUB.text,
          display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 20 }} aria-hidden>{favoriteDeckName ? '⭐' : '🂠'}</span>
          <span>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: HUB.muted }}>{favoriteDeckName ? 'FAVORITE DECK' : 'NO FAVORITE DECK'}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: favoriteDeckName ? HUB.text : HUB.muted, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {favoriteDeckName ?? 'Build one →'}{favoriteFaction && favoriteDeckName ? ` · ${favoriteFaction.name}` : ''}
            </div>
          </span>
        </button>
      </div>
    </div>
  );
}

// ── Overview tab ────────────────────────────────────────────────────────────
function OverviewTab({ prof, ranked, winPct, games, favoriteDeck, favoriteFaction, onBuildDeck, mobile }: {
  prof: Profile | null; ranked: any | null; winPct: number; games: number; level: number; xpPct: number;
  favoriteDeck: DeckEntry | null; favoriteFaction: { name: string; color: string } | null; onBuildDeck: () => void; mobile: boolean;
}) {
  const placementLeft = ranked?.placementMatchesRemaining ?? 0;
  const placementDone = Math.max(0, 10 - placementLeft);
  const career = [
    { label: 'Wins', value: prof?.wins ?? 0 }, { label: 'Losses', value: prof?.losses ?? 0 },
    { label: 'Draws', value: prof?.draws ?? 0 }, { label: 'Games', value: games },
    { label: 'Win rate', value: `${winPct}%` },
  ];
  return (
    <div className="hub-scroll" style={{ height: '100%', overflow: 'auto', display: 'grid', gap: 14,
      gridTemplateColumns: mobile ? '1fr' : '1.4fr 1fr', alignContent: 'start' }}>
      <HubCard title="CAREER STATISTICS">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px,1fr))', gap: 10 }}>
          {career.map((c) => (
            <div key={c.label} style={{ padding: '12px 10px', borderRadius: 10, background: HUB.surface, border: `1px solid ${HUB.border}`, textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 800 }}>{c.value}</div>
              <div style={{ fontSize: 10.5, color: HUB.muted, letterSpacing: '0.06em', marginTop: 4 }}>{c.label}</div>
            </div>
          ))}
        </div>
      </HubCard>

      <HubCard title="PLACEMENT PROGRESS">
        {placementLeft > 0 ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 28, fontWeight: 800, color: HUB.goldHi }}>{placementDone}</span>
              <span style={{ color: HUB.muted }}>/ 10 placement matches</span>
            </div>
            <div style={{ height: 8, borderRadius: 999, background: HUB.surface, border: `1px solid ${HUB.border}`, overflow: 'hidden', marginTop: 10 }}>
              <div style={{ width: `${(placementDone / 10) * 100}%`, height: '100%', background: `linear-gradient(90deg, ${HUB.gold}, ${HUB.violet})` }} />
            </div>
            <div style={{ fontSize: 12, color: HUB.muted, marginTop: 8 }}>Finish {placementLeft} more to earn your rank.</div>
          </>
        ) : (
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: HUB.goldHi }}>{ranked ? formatRankLabel(ranked) : 'Unranked'}</div>
            <div style={{ fontSize: 12, color: HUB.muted, marginTop: 6 }}>{ranked ? 'Placement complete.' : 'Play ranked matches to earn a rank.'}</div>
          </div>
        )}
      </HubCard>

      <HubCard title="FAVORITE DECK">
        {favoriteDeck ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 18 }} aria-hidden>⭐</span>
              <span style={{ fontFamily: HUB_SERIF, fontSize: 18, fontWeight: 700 }}>{favoriteDeck.name}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <Pill>{favoriteDeck.cards.length} cards</Pill>
              {favoriteFaction && <Pill color={favoriteFaction.color}>{favoriteFaction.name}</Pill>}
              <Pill color={validateDeck(favoriteDeck.cards).ok ? HUB.green : HUB.red}>{validateDeck(favoriteDeck.cards).ok ? 'Legal' : 'Illegal'}</Pill>
            </div>
          </div>
        ) : (
          <div>
            <div style={{ color: HUB.muted, fontSize: 13 }}>No favorite deck yet.</div>
            <button onClick={onBuildDeck} style={hubGoldBtn(false)}>BUILD A DECK</button>
          </div>
        )}
      </HubCard>

      <HubCard title="RECENT MATCHES">
        <div style={{ color: HUB.muted, fontSize: 13 }}>Match history isn’t tracked yet — your win/loss totals above reflect all games played.</div>
      </HubCard>
    </div>
  );
}

function HubCard({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ padding: 16, borderRadius: 14, background: HUB.raised, border: `1px solid ${HUB.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontFamily: HUB_SANS, fontWeight: 800, fontSize: 12, letterSpacing: '0.12em', color: HUB.muted }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}
function Pill({ children, color }: { children: React.ReactNode; color?: string }) {
  return <span style={{ padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700,
    background: `${color ?? HUB.violet}1c`, border: `1px solid ${color ?? HUB.violet}66`, color: color ?? HUB.violet }}>{children}</span>;
}
function hubGoldBtn(disabled: boolean): React.CSSProperties {
  return { marginTop: 12, padding: '10px 16px', borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: HUB_SANS, fontWeight: 800, letterSpacing: '0.06em', fontSize: 12, color: disabled ? '#efe6c9aa' : '#20170a',
    background: disabled ? 'linear-gradient(180deg,#5a4c28,#3a3018)' : `linear-gradient(180deg,${HUB.goldHi},${HUB.gold} 55%,#b98f34)`,
    border: `1px solid ${disabled ? '#6a5a30' : '#8a6d24'}`, opacity: disabled ? 0.85 : 1 };
}

// ── Collection tab ──────────────────────────────────────────────────────────
function CollectionTab({ walletAddress, mobile }: { walletAddress: string | null; mobile: boolean }) {
  const [chain, setChain] = useState<Color | 'all'>('all');
  const [type, setType] = useState<'all' | CardType>('all');
  const cards = useMemo(() => BUILDABLE_CARDS.filter((c) =>
    (chain === 'all' || c.color === chain) && (type === 'all' || c.type === type)), [chain, type]);
  const connected = !!walletAddress;
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ padding: '10px 14px', borderRadius: 12, background: HUB.raised, border: `1px solid ${HUB.border}`,
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: connected ? HUB.cyan : HUB.muted }} />
        <span style={{ fontSize: 13, color: HUB.text }}>
          {connected
            ? `Card archive · every card in the set is available to build with. On-chain booster mints land in your wallet ${shortAddr(walletAddress!)}.`
            : 'Wallet not linked. You can still browse and build with the full card archive; link a wallet from the home screen to track on-chain booster mints.'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <ChainChips value={chain} onChange={setChain} />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <TypeChips value={type} onChange={setType} />
        <span style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: 12, color: HUB.muted }}>{cards.length} cards</span>
      </div>

      <div className="hub-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${mobile ? 150 : 190}px, 1fr))`, gap: 12, alignContent: 'start', paddingBottom: 8 }}>
        {cards.map((def) => (
          <HubCardTile key={def.id} def={def} inDeck={0} cap={isBasicNode(def.id) ? Infinity : MAX_COPIES_NONBASIC}
            deckFull={false} onAdd={undefined} showAdd={false} />
        ))}
      </div>
    </div>
  );
}

// ── Achievements tab ────────────────────────────────────────────────────────
function AchievementsTab({ prof, ranked, deck, mobile }: { prof: Profile | null; ranked: any | null; deck: string[]; mobile: boolean }) {
  const achievements = useMemo(() => computeAchievements({ prof, deck, ranked }), [prof, deck, ranked]);
  const earned = achievements.filter((a) => a.earned).length;
  return (
    <div className="hub-scroll" style={{ height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ fontFamily: HUB_SANS, fontWeight: 800, letterSpacing: '0.1em', fontSize: 13, color: HUB.muted }}>ACHIEVEMENTS</div>
        <Pill color={HUB.gold}>{earned} / {achievements.length} unlocked</Pill>
      </div>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: `repeat(auto-fill, minmax(${mobile ? 150 : 210}px, 1fr))` }}>
        {achievements.map((a) => (
          <div key={a.id} style={{ padding: 14, borderRadius: 12, display: 'flex', gap: 12, alignItems: 'center',
            background: a.earned ? `radial-gradient(circle at 0% 0%, ${HUB.gold}22, ${HUB.raised} 70%)` : HUB.raised,
            border: `1px solid ${a.earned ? HUB.gold + '66' : HUB.border}`, opacity: a.earned ? 1 : 0.7 }}>
            <div aria-hidden style={{ fontSize: 26, filter: a.earned ? `drop-shadow(0 0 8px ${HUB.gold}aa)` : 'grayscale(1)' }}>{a.earned ? a.icon : '🔒'}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontWeight: 800, fontSize: 13, color: a.earned ? HUB.text : HUB.muted }}>{a.title}</span>
                <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.08em', color: a.earned ? HUB.green : HUB.muted }}>{a.earned ? 'UNLOCKED' : 'LOCKED'}</span>
              </div>
              <div style={{ fontSize: 11.5, color: HUB.muted, marginTop: 3 }}>{a.description}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Chain / type filter chips (chain accent only inside the badge) ──────────
function ChainChips({ value, onChange }: { value: Color | 'all'; onChange: (c: Color | 'all') => void }) {
  return (
    <>
      <span style={{ alignSelf: 'center', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: HUB.muted, marginRight: 4 }}>CHAIN</span>
      <HubChip label="ALL" selected={value === 'all'} onClick={() => onChange('all')} />
      {COLORS.map((c) => (
        <HubChip key={c} label={COLOR_META[c].name.toUpperCase()} selected={value === c} onClick={() => onChange(c)} accent={COLOR_META[c].hex} />
      ))}
    </>
  );
}
function TypeChips({ value, onChange }: { value: 'all' | CardType; onChange: (t: 'all' | CardType) => void }) {
  const types: Array<'all' | CardType> = ['all', 'node', 'meme', 'machine', 'aura', 'move'];
  return (
    <>
      <span style={{ alignSelf: 'center', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: HUB.muted, marginRight: 4 }}>TYPE</span>
      {types.map((t) => <HubChip key={t} label={t.toUpperCase()} selected={value === t} onClick={() => onChange(t)} />)}
    </>
  );
}
function HubChip({ label, selected, onClick, accent }: { label: string; selected: boolean; onClick: () => void; accent?: string }) {
  const col = accent ?? HUB.violet;
  return (
    <button onClick={onClick} aria-pressed={selected} className="hub-anim" style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 9, cursor: 'pointer',
      fontSize: 11.5, fontWeight: 700, letterSpacing: '0.04em',
      background: selected ? `${col}22` : HUB.surface, color: selected ? (accent ?? HUB.text) : HUB.muted,
      border: `1px solid ${selected ? col : HUB.border}`, transition: 'all .15s ease',
    }}>
      {accent && <span style={{ width: 8, height: 8, borderRadius: 2, background: accent }} />}
      {label}
    </button>
  );
}

// ── Card tile (memoized) ────────────────────────────────────────────────────
const HubCardTile = React.memo(function HubCardTile({ def, inDeck, cap, deckFull, onAdd, showAdd = true }: {
  def: CardDef; inDeck: number; cap: number; deckFull: boolean; onAdd?: () => void; showAdd?: boolean;
}) {
  const meta = COLOR_META[def.color];
  const atCap = inDeck >= cap;
  const cost = def.cost ? Object.values(def.cost).reduce((s, n) => s + (n ?? 0), 0) : null;
  const capLabel = cap === Infinity ? '∞' : String(cap);
  const disabled = !onAdd || atCap || deckFull;
  return (
    <CardHover defId={def.id}>
      <div className="hub-anim" tabIndex={showAdd ? 0 : -1}
        onKeyDown={(e) => { if (showAdd && onAdd && !disabled && (e.key === 'Enter' || e.key === '+')) { e.preventDefault(); onAdd(); } }}
        onDoubleClick={() => { if (showAdd && onAdd && !disabled) onAdd(); }}
        style={{ position: 'relative', display: 'flex', flexDirection: 'column', borderRadius: 12, overflow: 'hidden',
          background: HUB.surface, border: `1px solid ${inDeck > 0 ? meta.hex + '99' : HUB.border}`,
          boxShadow: inDeck > 0 ? `0 0 0 1px ${meta.hex}55 inset` : 'none', transition: 'transform .15s ease, box-shadow .2s ease', outline: 'none' }}
        onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = `0 12px 26px -12px ${HUB.violet}, 0 0 0 1px ${HUB.gold}66 inset`; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = inDeck > 0 ? `0 0 0 1px ${meta.hex}55 inset` : 'none'; }}
        onFocus={(e) => { e.currentTarget.style.boxShadow = `0 0 0 2px ${HUB.gold}, 0 0 0 4px ${HUB.violet}55`; }}
        onBlur={(e) => { e.currentTarget.style.boxShadow = inDeck > 0 ? `0 0 0 1px ${meta.hex}55 inset` : 'none'; }}>
        {/* real TCG proportion art */}
        <div style={{ position: 'relative', aspectRatio: '3 / 4', background: `linear-gradient(160deg, ${meta.hex}, #0a1020)`, display: 'grid', placeItems: 'center' }}>
          {def.image ? <img src={def.image} alt={def.name} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ fontSize: 34, fontWeight: 900, color: meta.ink, opacity: 0.85 }}>{(meta as any).glyph ?? meta.name[0]}</span>}
          {cost != null && <span style={{ position: 'absolute', top: 6, left: 6, minWidth: 22, height: 22, padding: '0 6px', borderRadius: 8,
            background: 'rgba(0,0,0,0.72)', color: '#fff', fontSize: 12, fontWeight: 900, display: 'grid', placeItems: 'center' }}>{cost}</span>}
          <span style={{ position: 'absolute', top: 6, right: 6, padding: '2px 7px', borderRadius: 999, fontSize: 9, fontWeight: 800,
            letterSpacing: '0.06em', background: 'rgba(0,0,0,0.7)', color: '#fff', textTransform: 'uppercase' }}>{def.type}</span>
          {def.type === 'meme' && def.power != null && (
            <span style={{ position: 'absolute', bottom: 6, right: 6, padding: '2px 7px', borderRadius: 6, background: 'rgba(0,0,0,0.78)', color: '#fff', fontSize: 12, fontWeight: 900 }}>{def.power}/{def.toughness}</span>
          )}
          {inDeck > 0 && <span style={{ position: 'absolute', bottom: 6, left: 6, padding: '2px 8px', borderRadius: 999, background: meta.hex, color: meta.ink, fontSize: 11, fontWeight: 900 }}>×{inDeck}</span>}
        </div>
        <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: HUB.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{def.name}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: HUB.muted }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: meta.hex }} />{meta.name}
            </span>
            <span style={{ fontSize: 10.5, color: atCap ? HUB.gold : HUB.muted }}>{inDeck}/{capLabel}</span>
          </div>
          {showAdd && (
            <button onClick={onAdd} disabled={disabled} aria-label={`Add ${def.name} to deck`} className="hub-anim"
              style={{ marginTop: 2, padding: '7px 0', borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 800, fontSize: 13,
                color: disabled ? HUB.muted : '#fff', background: disabled ? HUB.raised : `linear-gradient(180deg, ${HUB.purple}, ${HUB.violet})`,
                border: `1px solid ${disabled ? HUB.border : HUB.violet}` }}>
              {deckFull ? 'DECK FULL' : atCap ? 'AT LIMIT' : '+ ADD'}
            </button>
          )}
        </div>
      </div>
    </CardHover>
  );
});

// ── Deck workspace (library + persistent current-deck panel) ────────────────
function DeckWorkspace({ myName, mobile, onDecksChanged }: { myName: string; mobile: boolean; onDecksChanged: () => void }) {
  const [decks, setDecks] = useState<DeckEntry[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deckName, setDeckName] = useState('Untitled Deck');
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [savedSnapshot, setSavedSnapshot] = useState<string>('[]');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ msg: string; ok: boolean } | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [mobilePanel, setMobilePanel] = useState(false); // mobile deck drawer

  // Library controls.
  const [rawSearch, setRawSearch] = useState('');
  const search = useDebounced(rawSearch, 180);
  const [chain, setChain] = useState<Color | 'all'>('all');
  const [type, setType] = useState<'all' | CardType>('all');
  const [sort, setSort] = useState<'name' | 'cost' | 'chain' | 'type'>('name');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [ownFilter, setOwnFilter] = useState<'all' | 'inDeck' | 'notInDeck'>('all');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const liveRef = useRef<HTMLDivElement>(null);

  const countsFrom = (cards: string[]) => { const n: Record<string, number> = {}; for (const id of cards) n[id] = (n[id] ?? 0) + 1; return n; };

  const loadInto = useCallback((d: DeckEntry | null) => {
    if (d) { setEditingId(d.id); setDeckName(d.name); setCounts(countsFrom(d.cards)); setSavedSnapshot(JSON.stringify([...d.cards].sort())); }
    else { setEditingId(null); setDeckName('Untitled Deck'); setCounts({}); setSavedSnapshot('[]'); }
    setStatus(null);
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const list = await listDecksApi(myName);
        setDecks(list);
        loadInto(list.find((d) => d.isActive) ?? list[0] ?? null);
      } catch {
        try { const cards = await getDeckApi(myName); setCounts(countsFrom(cards)); setSavedSnapshot(JSON.stringify([...cards].sort())); } catch {}
      } finally { setLoading(false); }
    })();
  }, [myName, loadInto]);

  const deckList = useMemo(() => { const out: string[] = []; for (const [id, n] of Object.entries(counts)) for (let i = 0; i < n; i++) out.push(id); return out; }, [counts]);
  const total = deckList.length;
  const v60 = useMemo(() => validateDeck(deckList), [deckList]);
  const copyIssues = useMemo(() => validateDeck(deckList, { requireSize: false }).issues, [deckList]);
  const legality: 'EMPTY' | 'INCOMPLETE' | 'INVALID' | 'READY' =
    total === 0 ? 'EMPTY' : total < DECK_SIZE ? 'INCOMPLETE' : v60.ok ? 'READY' : 'INVALID';
  const dirty = JSON.stringify([...deckList].sort()) !== savedSnapshot;

  // Announce count + legality changes for screen readers.
  useEffect(() => { if (liveRef.current) liveRef.current.textContent = `${total} of ${DECK_SIZE} cards. Deck ${legality.toLowerCase()}.`; }, [total, legality]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  function bump(id: string, delta: number) {
    setCounts((prev) => {
      const cur = prev[id] ?? 0;
      let next = cur + delta;
      if (next < 0) next = 0;
      if (!isBasicNode(id) && next > MAX_COPIES_NONBASIC) next = MAX_COPIES_NONBASIC;
      if (delta > 0 && total >= DECK_SIZE) return prev;
      const out = { ...prev };
      if (next === 0) delete out[id]; else out[id] = next;
      return out;
    });
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = BUILDABLE_CARDS.filter((c) => {
      if (chain !== 'all' && c.color !== chain) return false;
      if (type !== 'all' && c.type !== type) return false;
      const inDeck = (counts[c.id] ?? 0) > 0;
      if (ownFilter === 'inDeck' && !inDeck) return false;
      if (ownFilter === 'notInDeck' && inDeck) return false;
      if (q) {
        const hay = `${c.name} ${c.text ?? ''} ${c.type} ${COLOR_META[c.color].name} ${c.effect ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const costOf = (c: CardDef) => c.cost ? Object.values(c.cost).reduce((s, n) => s + (n ?? 0), 0) : 0;
    list = [...list].sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name)
      : sort === 'cost' ? costOf(a) - costOf(b) || a.name.localeCompare(b.name)
      : sort === 'chain' ? a.color.localeCompare(b.color) || a.name.localeCompare(b.name)
      : a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    return list;
  }, [search, chain, type, sort, ownFilter, counts]);

  async function refreshDecks() { try { const l = await listDecksApi(myName); setDecks(l); } catch {} onDecksChanged(); }

  async function save() {
    if (saving || !deckName.trim() || total !== DECK_SIZE || !v60.ok) return;
    setSaving(true); setStatus(null);
    try {
      if (editingId != null) {
        const up = await updateDeckApi(myName, editingId, { cards: deckList, name: deckName.trim() });
        setSavedSnapshot(JSON.stringify([...up.cards].sort()));
        setDecks((prev) => prev.map((d) => d.id === editingId ? { ...d, cards: up.cards, name: up.name } : d));
      } else {
        const created = await createDeckApi(myName, deckName.trim(), deckList);
        setEditingId(created.id); setSavedSnapshot(JSON.stringify([...created.cards].sort()));
        setDecks((prev) => [...prev, created]);
      }
      try { await saveDeckApi(myName, deckList); } catch {}
      setStatus({ msg: 'Deck saved.', ok: true });
      onDecksChanged();
    } catch (e: any) { setStatus({ msg: String(e?.message ?? e), ok: false }); }
    finally { setSaving(false); }
  }

  async function newDeck() {
    if (dirty && !window.confirm('Discard unsaved changes to start a new deck?')) return;
    loadInto(null);
  }
  function clearDeck() { if (total === 0) return; if (window.confirm('Remove all cards from this deck?')) setCounts({}); }

  async function selectDeck(d: DeckEntry) {
    if (d.id === editingId) { setShowLibrary(false); return; }
    if (dirty && !window.confirm('Discard unsaved changes and load this deck?')) return;
    loadInto(d); setShowLibrary(false);
  }
  async function setFavorite(d: DeckEntry) {
    try { await activateDeckApi(myName, d.id); setDecks((prev) => prev.map((x) => ({ ...x, isActive: x.id === d.id }))); onDecksChanged(); } catch {}
  }
  async function duplicate(d: DeckEntry) {
    try { const c = await createDeckApi(myName, `${d.name} copy`, d.cards); setDecks((prev) => [...prev, c]); onDecksChanged(); } catch {}
  }
  async function removeDeck(d: DeckEntry) {
    if (!window.confirm(`Delete “${d.name}”? This cannot be undone.`)) return;
    try {
      await deleteDeckApi(myName, d.id);
      const remaining = decks.filter((x) => x.id !== d.id);
      setDecks(remaining);
      if (editingId === d.id) loadInto(remaining.find((x) => x.isActive) ?? remaining[0] ?? null);
      onDecksChanged();
    } catch {}
  }

  const deckFull = total >= DECK_SIZE;

  const panel = (
    <CurrentDeckPanel
      deckName={deckName} setDeckName={setDeckName} total={total} legality={legality}
      counts={counts} bump={bump} copyIssues={copyIssues} v60={v60} dirty={dirty}
      canSave={!!deckName.trim() && total === DECK_SIZE && v60.ok && !saving}
      saving={saving} status={status} onSave={save} onClear={clearDeck} onNew={newDeck}
      onOpenLibrary={() => setShowLibrary(true)} savedCount={decks.length} editingId={editingId}
    />
  );

  return (
    <div style={{ height: '100%', display: 'flex', gap: 14, minHeight: 0, flexDirection: mobile ? 'column' : 'row' }}>
      <div aria-live="polite" ref={liveRef} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }} />

      {/* Card library */}
      <div style={{ flex: mobile ? '1 1 auto' : '2 1 0', minWidth: 0, display: 'flex', flexDirection: 'column',
        borderRadius: 14, background: HUB.raised, border: `1px solid ${HUB.border}`, minHeight: 0 }}>
        <div style={{ padding: 14, borderBottom: `1px solid ${HUB.border}` }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
            <span style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: 17, color: HUB.goldHi }}>◈ CARD LIBRARY</span>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: HUB.muted }}>BUILD A 60-CARD DECK</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180 }}>
              <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: HUB.muted }} aria-hidden>🔍</span>
              <input value={rawSearch} onChange={(e) => setRawSearch(e.target.value)} placeholder="Search cards…" aria-label="Search cards"
                style={{ width: '100%', padding: '9px 10px 9px 32px', borderRadius: 9, background: HUB.surface, border: `1px solid ${HUB.border}`, color: HUB.text, fontSize: 13, outline: 'none' }} />
            </div>
            <select value={sort} onChange={(e) => setSort(e.target.value as any)} aria-label="Sort cards"
              style={{ padding: '9px 10px', borderRadius: 9, background: HUB.surface, border: `1px solid ${HUB.border}`, color: HUB.text, fontSize: 12.5 }}>
              <option value="name">SORT: NAME</option><option value="cost">SORT: COST</option>
              <option value="chain">SORT: CHAIN</option><option value="type">SORT: TYPE</option>
            </select>
            <div style={{ display: 'flex', borderRadius: 9, overflow: 'hidden', border: `1px solid ${HUB.border}` }}>
              <button onClick={() => setView('grid')} aria-label="Grid view" aria-pressed={view === 'grid'} style={{ padding: '8px 11px', background: view === 'grid' ? HUB.purple : HUB.surface, color: '#fff', border: 'none', cursor: 'pointer' }}>▦</button>
              <button onClick={() => setView('list')} aria-label="List view" aria-pressed={view === 'list'} style={{ padding: '8px 11px', background: view === 'list' ? HUB.purple : HUB.surface, color: '#fff', border: 'none', cursor: 'pointer' }}>☰</button>
            </div>
            <button onClick={() => setShowAdvanced((v) => !v)} aria-label="Advanced filters" aria-pressed={showAdvanced}
              style={{ padding: '8px 11px', borderRadius: 9, background: showAdvanced ? HUB.purple : HUB.surface, color: showAdvanced ? '#fff' : HUB.muted, border: `1px solid ${HUB.border}`, cursor: 'pointer' }}>⛭</button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}><ChainChips value={chain} onChange={setChain} /></div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
            <TypeChips value={type} onChange={setType} />
            <button onClick={() => { setChain('all'); setType('all'); setRawSearch(''); setOwnFilter('all'); setSort('name'); }}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: HUB.muted, cursor: 'pointer', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em' }}>RESET ↺</button>
          </div>
          {showAdvanced && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: HUB.muted, marginRight: 4 }}>SHOW</span>
              {(['all', 'inDeck', 'notInDeck'] as const).map((o) => (
                <HubChip key={o} label={o === 'all' ? 'ALL' : o === 'inDeck' ? 'IN DECK' : 'NOT IN DECK'} selected={ownFilter === o} onClick={() => setOwnFilter(o)} />
              ))}
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 11.5, color: HUB.muted }}>{visible.length} cards</div>
        </div>

        {loading ? (
          <div style={{ padding: 24, color: HUB.muted }}>Loading library…</div>
        ) : (
          <div className="hub-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 14 }}>
            {visible.length === 0 ? (
              <div style={{ color: HUB.muted, padding: 20, textAlign: 'center' }}>No cards match your filters. <button onClick={() => { setChain('all'); setType('all'); setRawSearch(''); setOwnFilter('all'); }} style={{ background: 'none', border: 'none', color: HUB.violet, cursor: 'pointer', textDecoration: 'underline' }}>Reset filters</button></div>
            ) : view === 'grid' ? (
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${mobile ? 150 : 176}px, 1fr))`, gap: 12 }}>
                {visible.map((def) => (
                  <HubCardTile key={def.id} def={def} inDeck={counts[def.id] ?? 0}
                    cap={isBasicNode(def.id) ? Infinity : MAX_COPIES_NONBASIC} deckFull={deckFull} onAdd={() => bump(def.id, +1)} />
                ))}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {visible.map((def) => (
                  <LibraryRow key={def.id} def={def} inDeck={counts[def.id] ?? 0}
                    cap={isBasicNode(def.id) ? Infinity : MAX_COPIES_NONBASIC} deckFull={deckFull} onAdd={() => bump(def.id, +1)} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Current-deck panel (desktop persistent; mobile drawer) */}
      {!mobile ? <div style={{ flex: '1 1 0', minWidth: 320, maxWidth: 440, display: 'flex', minHeight: 0 }}>{panel}</div> : (
        <>
          <button onClick={() => setMobilePanel(true)} style={{ position: 'fixed', left: 12, right: 12, bottom: 12, zIndex: 50, padding: '14px', borderRadius: 12,
            background: `linear-gradient(180deg, ${HUB.purple}, ${HUB.violet})`, color: '#fff', border: 'none', fontWeight: 800, letterSpacing: '0.06em',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>CURRENT DECK · {total}/{DECK_SIZE} · {legality}</button>
          {mobilePanel && (
            <div onClick={() => setMobilePanel(false)} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(3,4,10,0.7)', display: 'flex', alignItems: 'flex-end' }}>
              <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxHeight: '85dvh', display: 'flex' }}>{panel}</div>
            </div>
          )}
        </>
      )}

      {showLibrary && (
        <SavedDeckLibrary decks={decks} editingId={editingId} onClose={() => setShowLibrary(false)}
          onSelect={selectDeck} onFavorite={setFavorite} onDuplicate={duplicate} onDelete={removeDeck} />
      )}
    </div>
  );
}

function LibraryRow({ def, inDeck, cap, deckFull, onAdd }: { def: CardDef; inDeck: number; cap: number; deckFull: boolean; onAdd: () => void }) {
  const meta = COLOR_META[def.color];
  const cost = def.cost ? Object.values(def.cost).reduce((s, n) => s + (n ?? 0), 0) : null;
  const atCap = inDeck >= cap;
  const disabled = atCap || deckFull;
  return (
    <CardHover defId={def.id}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 9, background: HUB.surface,
        border: `1px solid ${inDeck > 0 ? meta.hex + '77' : HUB.border}` }}>
        <div style={{ width: 34, height: 44, borderRadius: 6, overflow: 'hidden', background: `linear-gradient(160deg, ${meta.hex}, #0a1020)`, flex: 'none', display: 'grid', placeItems: 'center' }}>
          {def.image ? <img src={def.image} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: 12, fontWeight: 900, color: meta.ink }}>{(meta as any).glyph}</span>}
        </div>
        {cost != null && <span style={{ minWidth: 22, height: 22, borderRadius: 6, background: HUB.raised, border: `1px solid ${HUB.border}`, display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 800, flex: 'none' }}>{cost}</span>}
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{def.name}</span>
        <span style={{ fontSize: 10.5, color: HUB.muted, display: 'inline-flex', gap: 5, alignItems: 'center' }}><span style={{ width: 8, height: 8, borderRadius: 2, background: meta.hex }} />{def.type}</span>
        <span style={{ fontSize: 11, color: atCap ? HUB.gold : HUB.muted, width: 40, textAlign: 'right' }}>{inDeck}/{cap === Infinity ? '∞' : cap}</span>
        <button onClick={onAdd} disabled={disabled} aria-label={`Add ${def.name}`} style={{ width: 30, height: 30, borderRadius: 8, flex: 'none',
          background: disabled ? HUB.raised : `linear-gradient(180deg, ${HUB.purple}, ${HUB.violet})`, color: disabled ? HUB.muted : '#fff',
          border: `1px solid ${disabled ? HUB.border : HUB.violet}`, cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 900 }}>+</button>
      </div>
    </CardHover>
  );
}

function CurrentDeckPanel(props: {
  deckName: string; setDeckName: (s: string) => void; total: number; legality: 'EMPTY' | 'INCOMPLETE' | 'INVALID' | 'READY';
  counts: Record<string, number>; bump: (id: string, d: number) => void; copyIssues: DeckIssue[]; v60: DeckValidation; dirty: boolean;
  canSave: boolean; saving: boolean; status: { msg: string; ok: boolean } | null; onSave: () => void; onClear: () => void; onNew: () => void;
  onOpenLibrary: () => void; savedCount: number; editingId: number | null;
}) {
  const { deckName, setDeckName, total, legality, counts, bump, copyIssues, v60, dirty, canSave, saving, status, onSave, onClear, onNew, onOpenLibrary, savedCount } = props;
  const [editingName, setEditingName] = useState(false);
  const legColor = legality === 'READY' ? HUB.green : legality === 'INVALID' ? HUB.red : HUB.gold;
  const pct = Math.min(100, (total / DECK_SIZE) * 100);

  // Group deck entries by card type.
  const groups = useMemo(() => {
    const byType: Record<string, Array<{ id: string; n: number }>> = {};
    for (const [id, n] of Object.entries(counts)) { const t = CARDS[id]?.type ?? 'other'; (byType[t] ??= []).push({ id, n }); }
    const order: CardType[] = ['node', 'meme', 'machine', 'aura', 'move'];
    return order.filter((t) => byType[t]?.length).map((t) => ({ type: t, rows: byType[t].sort((a, b) => CARDS[a.id].name.localeCompare(CARDS[b.id].name)) }));
  }, [counts]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, borderRadius: 14, background: HUB.raised, border: `1px solid ${HUB.gold}44` }}>
      <div style={{ padding: 14, borderBottom: `1px solid ${HUB.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: 16, color: HUB.goldHi }}>◈ CURRENT DECK</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={onNew} style={{ padding: '6px 12px', borderRadius: 8, background: 'transparent', border: `1px solid ${HUB.violet}`, color: HUB.violet, cursor: 'pointer', fontWeight: 800, fontSize: 11 }}>NEW</button>
            <button onClick={onOpenLibrary} title="Saved decks" aria-label="Open saved decks" style={{ width: 32, height: 30, borderRadius: 8, background: HUB.surface, border: `1px solid ${HUB.border}`, color: HUB.text, cursor: 'pointer' }}>
              🗂{savedCount > 0 && <span style={{ fontSize: 9, color: HUB.gold }}> {savedCount}</span>}
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 9, background: HUB.surface, border: `1px solid ${HUB.border}` }}>
          {editingName ? (
            <input autoFocus value={deckName} onChange={(e) => setDeckName(e.target.value)} onBlur={() => setEditingName(false)}
              onKeyDown={(e) => { if (e.key === 'Enter') setEditingName(false); }} aria-label="Deck name"
              style={{ flex: 1, background: 'none', border: 'none', color: HUB.text, fontSize: 14, fontWeight: 700, outline: 'none' }} />
          ) : (
            <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: deckName ? HUB.text : HUB.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{deckName || 'Untitled Deck'}</span>
          )}
          <button onClick={() => setEditingName((v) => !v)} aria-label="Rename deck" style={{ background: 'none', border: 'none', color: HUB.muted, cursor: 'pointer' }}>✎</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: total === DECK_SIZE ? HUB.green : HUB.text, lineHeight: 1 }}>
            {total}<span style={{ fontSize: 15, color: HUB.muted, fontWeight: 700 }}> / {DECK_SIZE}</span>
          </div>
          <div style={{ flex: 1, height: 8, borderRadius: 999, background: HUB.surface, border: `1px solid ${HUB.border}`, overflow: 'hidden' }}>
            <div className="hub-anim" style={{ width: `${pct}%`, height: '100%', transition: 'width .2s ease', background: legality === 'READY' ? `linear-gradient(90deg, ${HUB.gold}, ${HUB.green})` : `linear-gradient(90deg, ${HUB.gold}, ${HUB.violet})` }} />
          </div>
          <span style={{ padding: '4px 10px', borderRadius: 999, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', color: legColor, background: `${legColor}1c`, border: `1px solid ${legColor}66` }}>
            {legality === 'EMPTY' ? 'INCOMPLETE' : legality}{dirty ? ' •' : ''}
          </span>
        </div>
      </div>

      <div className="hub-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 14 }}>
        {total === 0 ? (
          <div style={{ height: '100%', minHeight: 180, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, textAlign: 'center',
            border: `1px dashed ${HUB.border}`, borderRadius: 12, color: HUB.muted }}>
            <div style={{ fontSize: 30, opacity: 0.5 }} aria-hidden>🂠</div>
            <div style={{ fontSize: 13 }}>Add cards from the library to begin.</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {groups.map((g) => (
              <div key={g.type}>
                <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.12em', color: HUB.muted, marginBottom: 6, textTransform: 'uppercase' }}>
                  {g.type} · {g.rows.reduce((s, r) => s + r.n, 0)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {g.rows.map(({ id, n }) => {
                    const def = CARDS[id]; const meta = COLOR_META[def.color];
                    const cost = def.cost ? Object.values(def.cost).reduce((s, x) => s + (x ?? 0), 0) : null;
                    const over = !isBasicNode(id) && n > MAX_COPIES_NONBASIC;
                    return (
                      <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, background: HUB.surface, border: `1px solid ${over ? HUB.red : HUB.border}` }}>
                        {cost != null && <span style={{ minWidth: 20, height: 20, borderRadius: 5, background: HUB.raised, display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800, flex: 'none' }}>{cost}</span>}
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: meta.hex, flex: 'none' }} aria-hidden />
                        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={def.name}>{def.name}</span>
                        {over && <span style={{ fontSize: 9.5, fontWeight: 800, color: HUB.red }} title={`Max ${MAX_COPIES_NONBASIC}`}>OVER</span>}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 'none' }}>
                          <button onClick={() => bump(id, -1)} aria-label={`Remove one ${def.name}`} style={deckStep}>−</button>
                          <span style={{ minWidth: 18, textAlign: 'center', fontWeight: 800, fontSize: 13 }}>{n}</span>
                          <button onClick={() => bump(id, +1)} aria-label={`Add one ${def.name}`} style={deckStep}>+</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ padding: 14, borderTop: `1px solid ${HUB.border}` }}>
        {(copyIssues.length > 0 || (total > 0 && total !== DECK_SIZE)) && (
          <div style={{ marginBottom: 10, fontSize: 11.5, color: HUB.gold, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {total !== DECK_SIZE && <div>○ {total < DECK_SIZE ? `${DECK_SIZE - total} more card${DECK_SIZE - total === 1 ? '' : 's'} needed` : `Remove ${total - DECK_SIZE} card${total - DECK_SIZE === 1 ? '' : 's'}`}</div>}
            {copyIssues.slice(0, 3).map((it, i) => <div key={i} style={{ color: HUB.red }}>○ {it.message}</div>)}
            {total === DECK_SIZE && v60.ok && <div style={{ color: HUB.green }}>✓ Deck is legal and ready.</div>}
          </div>
        )}
        {total === 0 && <div style={{ marginBottom: 10, fontSize: 11.5, color: HUB.muted }}>○ 60 cards required · No cards selected</div>}
        {status && <div style={{ marginBottom: 10, fontSize: 12, color: status.ok ? HUB.green : HUB.red }}>{status.msg}</div>}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClear} style={{ padding: '12px 18px', borderRadius: 10, background: HUB.surface, border: `1px solid ${HUB.border}`, color: HUB.text, cursor: 'pointer', fontWeight: 700, letterSpacing: '0.06em', fontSize: 12 }}>CLEAR</button>
          <button onClick={onSave} disabled={!canSave} style={{ ...hubGoldBtn(!canSave), flex: 1, marginTop: 0, padding: '12px 18px', fontSize: 14 }}>{saving ? 'SAVING…' : 'SAVE DECK'}</button>
        </div>
        {!canSave && total !== DECK_SIZE && <div style={{ marginTop: 8, fontSize: 11, color: HUB.muted, textAlign: 'center' }}>Add {DECK_SIZE} cards to save this deck.</div>}
      </div>
    </div>
  );
}
const deckStep: React.CSSProperties = { width: 24, height: 24, borderRadius: 6, background: HUB.raised, border: `1px solid ${HUB.border}`, color: HUB.text, cursor: 'pointer', fontWeight: 900, fontSize: 14, lineHeight: 1 };

function SavedDeckLibrary({ decks, editingId, onClose, onSelect, onFavorite, onDuplicate, onDelete }: {
  decks: DeckEntry[]; editingId: number | null; onClose: () => void;
  onSelect: (d: DeckEntry) => void; onFavorite: (d: DeckEntry) => void; onDuplicate: (d: DeckEntry) => void; onDelete: (d: DeckEntry) => void;
}) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(3,4,10,0.75)', backdropFilter: 'blur(4px)', display: 'grid', placeItems: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 100%)', maxHeight: '80dvh', overflow: 'auto', borderRadius: 14, background: HUB.surface, border: `1px solid ${HUB.gold}44`, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <span style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: 17, color: HUB.goldHi }}>SAVED DECKS</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: HUB.muted, fontSize: 22, cursor: 'pointer' }}>×</button>
        </div>
        {decks.length === 0 ? (
          <div style={{ color: HUB.muted, fontSize: 13, padding: '20px 0', textAlign: 'center' }}>No saved decks yet. Build a 60-card deck and hit Save.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {decks.map((d) => {
              const ok = validateDeck(d.cards).ok;
              const faction = deriveFavoriteFaction(d.cards);
              return (
                <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10,
                  background: d.id === editingId ? `${HUB.violet}18` : HUB.raised, border: `1px solid ${d.id === editingId ? HUB.violet : HUB.border}` }}>
                  <button onClick={() => onSelect(d)} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', color: HUB.text, cursor: 'pointer' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {d.isActive && <span title="Favorite deck" aria-label="Favorite">⭐</span>}
                      <span style={{ fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 10.5, color: HUB.muted }}>{d.cards.length} cards</span>
                      {faction && <span style={{ fontSize: 10.5, color: faction.color }}>{faction.name}</span>}
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: ok ? HUB.green : HUB.red }}>{ok ? 'READY' : d.cards.length === DECK_SIZE ? 'INVALID' : 'INCOMPLETE'}</span>
                    </div>
                  </button>
                  {!d.isActive && <button onClick={() => onFavorite(d)} title="Set as favorite" aria-label="Set favorite" style={libAct(HUB.gold)}>☆</button>}
                  <button onClick={() => onDuplicate(d)} title="Duplicate" aria-label="Duplicate" style={libAct(HUB.muted)}>⧉</button>
                  <button onClick={() => onDelete(d)} title="Delete" aria-label="Delete" style={libAct(HUB.red)}>🗑</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
function libAct(color: string): React.CSSProperties {
  return { width: 30, height: 30, borderRadius: 8, background: HUB.raised, border: `1px solid ${HUB.border}`, color, cursor: 'pointer', flex: 'none', fontSize: 13 };
}

// ── Design tokens for the redesigned profile screen ────────────────────────
const PROFILE_FONT = "'Inter', 'Geist', 'Satoshi', system-ui, -apple-system, sans-serif";
const PROFILE_TOKENS = {
  bg:        '#07090f',
  card:      '#111827',
  cardSoft:  '#0e1422',
  border:    '#232f45',
  borderHi:  '#2f3e5c',
  accent:    '#00d18f',
  secondary: '#7c5cff',
  warning:   '#ffb84d',
  danger:    '#ff5d73',
  muted:     '#7d8aa3',
  text:      '#e9eef7',
};

function formatRankLabel(r: { visibleRank: string; division: number; rankedPoints: number; placementMatchesRemaining?: number }) {
  if ((r.placementMatchesRemaining ?? 0) > 0) return `Placement (${r.placementMatchesRemaining} left)`;
  const roman = ['', 'I', 'II', 'III', 'IV'][r.division] ?? '';
  if (r.visibleRank === 'Mythic') return `Mythic · ${r.rankedPoints} LP`;
  return `${r.visibleRank} ${roman} · ${r.rankedPoints} LP`;
}
function rankGlow(t: string) {
  return ({
    Bronze: '#a86a32', Silver: '#c2c2c2', Gold: '#ffd86a',
    Platinum: '#7debf6', Diamond: '#a3c8ff', Master: '#c084fc',
    Grandmaster: '#ff5757', Mythic: '#ffaa55',
  } as Record<string, string>)[t] ?? '#7c5cff';
}

function deriveFavoriteFaction(deck: string[]): { name: string; color: string; ink: string; count: number } | null {
  if (!deck.length) return null;
  const tally: Record<string, number> = {};
  for (const id of deck) { const d = CARDS[id]; if (!d) continue; tally[d.color] = (tally[d.color] ?? 0) + 1; }
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const meta = COLOR_META[top[0] as Color];
  return { name: meta.name, color: meta.hex, ink: meta.ink, count: top[1] };
}

// ── Top bar (sticky-ish, modern) ───────────────────────────────────────────
function ProfileTopBar({ onBack, onEdit }: { onBack: () => void; onEdit: () => void }) {
  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 30,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 22px',
      background: 'linear-gradient(180deg, rgba(7,9,15,0.96), rgba(7,9,15,0.7))',
      backdropFilter: 'blur(10px)',
      borderBottom: `1px solid ${PROFILE_TOKENS.border}`,
    }}>
      <button onClick={onBack} style={profileChip(false)}>← Back</button>
      <div style={{ fontWeight: 800, letterSpacing: 4, fontSize: 12, color: PROFILE_TOKENS.muted }}>PROFILE</div>
      <button onClick={onEdit} style={profileChip(true)}>✎ Edit Profile</button>
    </div>
  );
}
function profileChip(accent: boolean): React.CSSProperties {
  return {
    padding: '8px 14px', fontSize: 12, fontWeight: 700, letterSpacing: 0.5,
    background: accent ? 'linear-gradient(180deg, rgba(0,209,143,0.18), rgba(0,209,143,0.06))' : 'rgba(17,24,39,0.7)',
    color: accent ? PROFILE_TOKENS.accent : PROFILE_TOKENS.text,
    border: `1px solid ${accent ? '#00d18f55' : PROFILE_TOKENS.border}`,
    borderRadius: 8, cursor: 'pointer', transition: '200ms ease',
    fontFamily: PROFILE_FONT,
  };
}

// ── Skeleton loader ────────────────────────────────────────────────────────
function ProfileSkeleton() {
  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: 28, display: 'flex', flexDirection: 'column', gap: 22 }}>
      {[200, 110, 240, 180, 220].map((h, i) => (
        <div key={i} style={{
          height: h, borderRadius: 14,
          background: 'linear-gradient(90deg, #0e1422, #151c2f, #0e1422)',
          backgroundSize: '200% 100%',
          animation: 'profSkeleton 1.4s ease-in-out infinite',
          border: `1px solid ${PROFILE_TOKENS.border}`,
        }} />
      ))}
      <style>{`@keyframes profSkeleton{0%{background-position:0% 50%}100%{background-position:200% 50%}}`}</style>
    </div>
  );
}

// ── HERO ───────────────────────────────────────────────────────────────────
function ProfileHero(props: {
  name: string; avatarUrl: string | null; bio: string | null;
  rankLabel: string; rankGlow: string;
  level: number; xpPct: number; xpCur: number; xpRange: number;
  winPct: number; wins: number; losses: number; placement: number;
}) {
  const { name, avatarUrl, bio, rankLabel, rankGlow, level, xpPct, xpCur, xpRange, winPct, wins, losses, placement } = props;
  return (
    <div style={{
      position: 'relative', overflow: 'hidden',
      borderRadius: 18,
      padding: '28px 28px 32px',
      background: `radial-gradient(1100px 360px at 18% -30%, ${rankGlow}33 0%, transparent 60%), linear-gradient(160deg, ${PROFILE_TOKENS.card} 0%, #0a1020 100%)`,
      border: `1px solid ${PROFILE_TOKENS.border}`,
      boxShadow: `0 22px 60px -30px ${rankGlow}55`,
    }}>
      {/* Faint pattern accent */}
      <div aria-hidden style={{
        position: 'absolute', inset: 0, opacity: 0.06,
        backgroundImage: 'radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)',
        backgroundSize: '24px 24px', pointerEvents: 'none',
      }} />
      <div style={{ position: 'relative', display: 'flex', gap: 28, alignItems: 'center', flexWrap: 'wrap' }}>
        <AvatarFramed src={avatarUrl} name={name} glow={rankGlow} size={130} />
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{
              fontFamily: '"Cinzel", "Times New Roman", serif',
              fontSize: 38, fontWeight: 900, letterSpacing: 1.5,
              color: '#fff', textShadow: `0 2px 24px ${rankGlow}88`,
              lineHeight: 1.1, margin: 0,
            }}>{name}</div>
            <span style={{
              padding: '4px 10px', borderRadius: 999,
              background: `${rankGlow}22`, color: rankGlow,
              border: `1px solid ${rankGlow}55`,
              fontSize: 11, fontWeight: 800, letterSpacing: 1.5, textTransform: 'uppercase',
            }}>{rankLabel}</span>
          </div>
          {bio && (
            <div style={{ marginTop: 6, color: PROFILE_TOKENS.muted, fontSize: 14, lineHeight: 1.5, maxWidth: 620 }}>
              {bio}
            </div>
          )}
          {/* Level / XP bar */}
          <div style={{ marginTop: 18, maxWidth: 520 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#cfd6e3', letterSpacing: 0.5 }}>
                LEVEL <span style={{ color: PROFILE_TOKENS.accent, fontSize: 18, marginLeft: 4 }}>{level}</span>
              </span>
              <span style={{ fontSize: 11, color: PROFILE_TOKENS.muted, fontWeight: 600 }}>{xpCur}/{xpRange} XP</span>
            </div>
            <div style={{
              height: 10, borderRadius: 999, overflow: 'hidden',
              background: '#0a1224', border: `1px solid ${PROFILE_TOKENS.border}`,
              position: 'relative',
            }}>
              <div style={{
                width: `${xpPct}%`, height: '100%',
                background: `linear-gradient(90deg, ${PROFILE_TOKENS.accent}, ${PROFILE_TOKENS.secondary})`,
                boxShadow: `0 0 12px ${PROFILE_TOKENS.accent}88`,
                transition: 'width 600ms ease',
              }} />
            </div>
          </div>
        </div>
        {/* Win-rate dial */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: 130 }}>
          <RingStat value={winPct} max={100} size={108} color={winPct >= 50 ? PROFILE_TOKENS.accent : PROFILE_TOKENS.danger} suffix="%" label="Win Rate" />
          <div style={{ fontSize: 11, color: PROFILE_TOKENS.muted, letterSpacing: 1 }}>
            <span style={{ color: PROFILE_TOKENS.accent, fontWeight: 700 }}>{wins}W</span>
            {'  '}
            <span style={{ color: PROFILE_TOKENS.danger, fontWeight: 700 }}>{losses}L</span>
          </div>
          {placement > 0 && (
            <div style={{ fontSize: 10, color: PROFILE_TOKENS.warning, fontWeight: 700, letterSpacing: 1 }}>
              {placement} PLACEMENTS LEFT
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AvatarFramed({ src, name, glow, size }: { src: string | null; name: string; glow: string; size: number }) {
  return (
    <div style={{
      position: 'relative', width: size, height: size,
      borderRadius: '50%', padding: 4,
      background: `conic-gradient(from 0deg, ${glow}, ${PROFILE_TOKENS.secondary}, ${glow})`,
      boxShadow: `0 0 22px ${glow}88, 0 8px 28px #000c`,
      animation: 'avatarGlow 6s linear infinite',
    }}>
      <div style={{
        width: '100%', height: '100%', borderRadius: '50%', overflow: 'hidden',
        background: PROFILE_TOKENS.cardSoft, border: `2px solid ${PROFILE_TOKENS.bg}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {src
          ? <img src={src} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <div style={{ fontSize: size * 0.5, color: PROFILE_TOKENS.muted }}>👤</div>}
      </div>
      <style>{`@keyframes avatarGlow{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function RingStat({ value, max, size, color, suffix, label }: { value: number; max: number; size: number; color: string; suffix?: string; label: string }) {
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value / max));
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} stroke="#1a2238" strokeWidth={8} fill="none" />
        <circle cx={size/2} cy={size/2} r={r} stroke={color} strokeWidth={8} fill="none"
          strokeDasharray={c} strokeDashoffset={c - c * pct} strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 6px ${color})`, transition: 'stroke-dashoffset 600ms ease' }} />
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', textAlign: 'center',
      }}>
        <div style={{ fontSize: 26, fontWeight: 900, color: '#fff', lineHeight: 1 }}>{value}{suffix}</div>
        <div style={{ fontSize: 9, color: PROFILE_TOKENS.muted, marginTop: 2, letterSpacing: 1.5, fontWeight: 700 }}>{label.toUpperCase()}</div>
      </div>
    </div>
  );
}

// ── STAT CARDS ─────────────────────────────────────────────────────────────
function PlayerStats(props: {
  wins: number; losses: number; draws: number; winPct: number;
  currentStreak: number; bestStreak: number;
  favoriteFaction: { name: string; color: string; ink: string; count: number } | null;
}) {
  const { wins, losses, draws, winPct, bestStreak, favoriteFaction } = props;
  const games = wins + losses + draws;
  return (
    <SectionShell title="Stats" eyebrow="Career Performance" accent={PROFILE_TOKENS.accent}>
      <div style={{
        display: 'grid', gap: 12,
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
      }}>
        <StatCard label="Win Rate" value={`${winPct}%`} color={winPct >= 50 ? PROFILE_TOKENS.accent : PROFILE_TOKENS.danger} icon="📈" />
        <StatCard label="Wins" value={wins} color={PROFILE_TOKENS.accent} icon="🏆" />
        <StatCard label="Losses" value={losses} color={PROFILE_TOKENS.danger} icon="💀" />
        <StatCard label="Games Played" value={games} color={PROFILE_TOKENS.secondary} icon="🎴" />
        <StatCard label="Best Streak" value={bestStreak} color={PROFILE_TOKENS.warning} icon="🔥" />
        <StatCard label="Draws" value={draws} color={PROFILE_TOKENS.muted} icon="🤝" />
        {favoriteFaction
          ? <StatCard label="Top Faction" value={favoriteFaction.name} color={favoriteFaction.color} icon="⛓️" small />
          : <StatCard label="Top Faction" value="—" color={PROFILE_TOKENS.muted} icon="⛓️" small />}
      </div>
    </SectionShell>
  );
}

function StatCard({ label, value, color, icon, small }: { label: string; value: number | string; color: string; icon: string; small?: boolean }) {
  return (
    <div
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = `0 12px 28px -12px ${color}66`; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}
      style={{
        padding: '14px 16px', borderRadius: 12,
        background: `linear-gradient(180deg, ${PROFILE_TOKENS.card}, ${PROFILE_TOKENS.cardSoft})`,
        border: `1px solid ${PROFILE_TOKENS.border}`,
        transition: 'transform 200ms ease, box-shadow 200ms ease',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 10, color: PROFILE_TOKENS.muted, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase' }}>{label}</span>
        <span style={{ fontSize: 16 }}>{icon}</span>
      </div>
      <div style={{
        fontSize: small ? 18 : 28, fontWeight: 800, color, lineHeight: 1.1,
        textShadow: `0 0 12px ${color}55`,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{value}</div>
    </div>
  );
}

// ── SECTION SHELL ──────────────────────────────────────────────────────────
function SectionShell({ title, eyebrow, accent, children }: { title: string; eyebrow?: string; accent: string; children: React.ReactNode }) {
  return (
    <section style={{
      borderRadius: 16,
      background: PROFILE_TOKENS.card,
      border: `1px solid ${PROFILE_TOKENS.border}`,
      padding: '18px 20px 22px',
    }}>
      <div style={{ marginBottom: 14 }}>
        {eyebrow && (
          <div style={{ fontSize: 10, color: accent, letterSpacing: 2, fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>
            {eyebrow}
          </div>
        )}
        <div style={{
          fontSize: 22, fontWeight: 800, color: '#fff', letterSpacing: 0.5,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          {title}
          <span style={{ flex: 1, height: 1, background: `linear-gradient(90deg, ${accent}55, transparent)` }} />
        </div>
      </div>
      {children}
    </section>
  );
}

// ── ACHIEVEMENTS ───────────────────────────────────────────────────────────
type Achievement = { id: string; icon: string; title: string; description: string; earned: boolean };

function computeAchievements({ prof, deck, ranked }: { prof: Profile | null; deck: string[]; ranked: any | null }): Achievement[] {
  const wins = prof?.wins ?? 0;
  const games = (prof?.wins ?? 0) + (prof?.losses ?? 0) + (prof?.draws ?? 0);
  const deckSize = deck.length;
  return [
    { id: 'first-victory', icon: '🏆', title: 'First Victory', description: 'Win your first match.', earned: wins >= 1 },
    { id: 'rising-star',   icon: '⭐', title: 'Rising Star',   description: 'Win 5 matches.',         earned: wins >= 5 },
    { id: 'veteran',       icon: '🎖️', title: 'Veteran',       description: 'Play 25 matches.',       earned: games >= 25 },
    { id: 'streak-5',      icon: '🔥', title: '5 Win Streak',   description: 'Win 5 in a row.',         earned: wins >= 5 && games <= wins + 2 },
    { id: 'meme-lord',     icon: '🐸', title: 'Meme Lord',      description: 'Win 25 matches.',         earned: wins >= 25 },
    { id: 'deckbuilder',   icon: '🛠️', title: 'Deckbuilder',    description: 'Build a 60-card deck.',  earned: deckSize >= 60 },
    { id: 'nft-collector', icon: '💎', title: 'NFT Collector', description: 'Link a Solana wallet.',   earned: !!prof?.walletAddress && !prof.walletAddress.startsWith('0x') },
    { id: 'placed',        icon: '🏅', title: 'Placed',         description: 'Finish placement matches.', earned: !!ranked && (ranked.placementMatchesRemaining ?? 10) === 0 },
    { id: 'gold-tier',     icon: '👑', title: 'Gold Tier',      description: 'Reach Gold or higher.',   earned: !!ranked && ['Gold','Platinum','Diamond','Master','Grandmaster','Mythic'].includes(ranked.visibleRank) },
    { id: 'mythic',        icon: '🔮', title: 'Mythic',         description: 'Climb to Mythic rank.',  earned: ranked?.visibleRank === 'Mythic' },
  ];
}

function AchievementGrid({ achievements }: { achievements: Achievement[] }) {
  const earned = achievements.filter(a => a.earned).length;
  return (
    <SectionShell title="Achievements" eyebrow={`${earned}/${achievements.length} Unlocked`} accent={PROFILE_TOKENS.warning}>
      <div style={{
        display: 'grid', gap: 12,
        gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
      }}>
        {achievements.map(a => <AchievementBadge key={a.id} a={a} />)}
      </div>
    </SectionShell>
  );
}

function AchievementBadge({ a }: { a: Achievement }) {
  return (
    <div title={`${a.title} — ${a.description}`}
      onMouseEnter={e => { if (a.earned) e.currentTarget.style.transform = 'scale(1.05)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
      style={{
        padding: '14px 8px', borderRadius: 12, textAlign: 'center',
        background: a.earned
          ? `radial-gradient(circle at 50% 0%, ${PROFILE_TOKENS.warning}33, ${PROFILE_TOKENS.cardSoft} 70%)`
          : PROFILE_TOKENS.cardSoft,
        border: `1px solid ${a.earned ? PROFILE_TOKENS.warning + '88' : PROFILE_TOKENS.border}`,
        boxShadow: a.earned ? `0 0 16px ${PROFILE_TOKENS.warning}33, inset 0 0 8px ${PROFILE_TOKENS.warning}22` : 'none',
        opacity: a.earned ? 1 : 0.45,
        transition: 'transform 200ms ease',
        cursor: 'help',
        animation: a.earned ? 'achPulse 3s ease-in-out infinite' : 'none',
      }}>
      <div style={{
        fontSize: 30, lineHeight: 1, marginBottom: 6,
        filter: a.earned ? `drop-shadow(0 0 8px ${PROFILE_TOKENS.warning}aa)` : 'grayscale(1)',
      }}>{a.earned ? a.icon : '🔒'}</div>
      <div style={{ fontSize: 11, fontWeight: 800, color: a.earned ? '#fff' : PROFILE_TOKENS.muted, letterSpacing: 0.5 }}>{a.title}</div>
      <style>{`@keyframes achPulse{0%,100%{box-shadow:0 0 16px ${PROFILE_TOKENS.warning}33,inset 0 0 8px ${PROFILE_TOKENS.warning}22}50%{box-shadow:0 0 22px ${PROFILE_TOKENS.warning}55,inset 0 0 10px ${PROFILE_TOKENS.warning}33}}`}</style>
    </div>
  );
}

// ── FAVORITE DECK ──────────────────────────────────────────────────────────
function FavoriteDeck({ deck, myName }: { deck: string[]; myName: string }) {
  const stats = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const id of deck) counts[id] = (counts[id] ?? 0) + 1;
    const colorTally: Record<string, number> = {};
    let topCard: { id: string; count: number; def: any } | null = null;
    for (const [id, n] of Object.entries(counts)) {
      const d = CARDS[id]; if (!d) continue;
      colorTally[d.color] = (colorTally[d.color] ?? 0) + n;
      if (!topCard || n > topCard.count) topCard = { id, count: n, def: d };
    }
    const sortedColors = Object.entries(colorTally).sort((a, b) => b[1] - a[1]);
    return {
      size: deck.length,
      colors: sortedColors.slice(0, 3).map(([c]) => COLOR_META[c as Color]),
      topCard,
      archetype: sortedColors.length === 1
        ? `Mono-${COLOR_META[sortedColors[0][0] as Color].name}`
        : sortedColors.length >= 2
          ? `${COLOR_META[sortedColors[0][0] as Color].name}/${COLOR_META[sortedColors[1][0] as Color].name}`
          : 'Custom',
    };
  }, [deck]);

  return (
    <SectionShell title="Favorite Deck" eyebrow="Your Featured Build" accent={PROFILE_TOKENS.secondary}>
      {deck.length === 0 ? (
        <EmptyState icon="🃏" title="No deck saved yet"
          message="Build a 60-card deck below to feature it here." />
      ) : (
        <div style={{ display: 'flex', gap: 18, alignItems: 'stretch', flexWrap: 'wrap' }}>
          {/* Deck "spine" art */}
          <div style={{
            position: 'relative', width: 140, height: 192, flex: '0 0 auto',
            borderRadius: 12, overflow: 'hidden',
            background: stats.colors.length === 1
              ? `linear-gradient(160deg, ${stats.colors[0].hex}, #0a1020)`
              : `linear-gradient(160deg, ${stats.colors.map(c => c.hex).join(', ')})`,
            border: `1px solid ${PROFILE_TOKENS.borderHi}`,
            boxShadow: '0 12px 28px -8px #000c, inset 0 0 30px #0008',
            display: 'flex', alignItems: 'flex-end', padding: 10,
          }}>
            <div style={{
              fontFamily: '"Cinzel", "Times New Roman", serif',
              fontSize: 18, fontWeight: 900, color: '#fff',
              textShadow: '0 2px 6px #000', lineHeight: 1.1,
            }}>{stats.archetype}</div>
          </div>
          <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#fff', marginBottom: 4 }}>{myName}'s {stats.archetype}</div>
              <div style={{ fontSize: 12, color: PROFILE_TOKENS.muted, marginBottom: 12 }}>
                {stats.size}/60 cards · {stats.colors.length === 1 ? 'Mono-color' : `${stats.colors.length} chain split`}
              </div>
              <div style={{ display: 'flex', gap: 16, marginBottom: 14 }}>
                <Mini label="Cards" value={`${stats.size}/60`} color={stats.size === 60 ? PROFILE_TOKENS.accent : PROFILE_TOKENS.warning} />
                {stats.topCard && <Mini label="Most Used" value={`${stats.topCard.def.name} ×${stats.topCard.count}`} color={PROFILE_TOKENS.secondary} />}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {stats.colors.map(c => (
                  <span key={c.name} style={{
                    padding: '4px 10px', borderRadius: 999, fontSize: 10, fontWeight: 800,
                    background: c.hex, color: c.ink, letterSpacing: 1, textTransform: 'uppercase',
                  }}>{c.name}</span>
                ))}
              </div>
            </div>
            <div style={{ fontSize: 11, color: PROFILE_TOKENS.muted, marginTop: 14 }}>
              Edit your deck in the Deck Builder below ↓
            </div>
          </div>
        </div>
      )}
    </SectionShell>
  );
}

function Mini({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: PROFILE_TOKENS.muted, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 800, color }}>{value}</div>
    </div>
  );
}

function EmptyState({ icon, title, message }: { icon: string; title: string; message: string }) {
  return (
    <div style={{
      textAlign: 'center', padding: '36px 20px',
      background: PROFILE_TOKENS.cardSoft, borderRadius: 12,
      border: `1px dashed ${PROFILE_TOKENS.border}`,
    }}>
      <div style={{ fontSize: 44, opacity: 0.4, marginBottom: 10 }}>{icon}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: '#cfd6e3' }}>{title}</div>
      <div style={{ fontSize: 12, color: PROFILE_TOKENS.muted, marginTop: 4 }}>{message}</div>
    </div>
  );
}

// ── EDIT MODAL ─────────────────────────────────────────────────────────────
function ProfileEditModal({ prof, onClose, onSaved }: { prof: Profile; onClose: () => void; onSaved: () => void }) {
  const [bio, setBio] = useState(prof.bio ?? '');
  const [avatarUrl, setAvatarUrl] = useState(prof.avatarUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.size > 600 * 1024) { setErr('Image too large — under 600 KB.'); return; }
    const r = new FileReader();
    r.onload = () => setAvatarUrl(String(r.result || ''));
    r.readAsDataURL(f);
  }
  async function save() {
    setSaving(true); setErr('');
    try {
      await updateProfileApi(prof.name, { bio: bio.trim() || null, avatarUrl: avatarUrl.trim() || null });
      onSaved();
    } catch (e: any) { setErr(String(e?.message ?? e)); setSaving(false); }
  }
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20, fontFamily: PROFILE_FONT,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(560px, 100%)', maxHeight: '90vh', overflow: 'auto',
        borderRadius: 16, padding: 24,
        background: `linear-gradient(180deg, ${PROFILE_TOKENS.card}, ${PROFILE_TOKENS.cardSoft})`,
        border: `1px solid ${PROFILE_TOKENS.borderHi}`,
        boxShadow: '0 30px 80px #000c',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#fff', letterSpacing: 0.5 }}>Edit Profile</div>
          <button onClick={onClose} style={profileChip(false)}>✕</button>
        </div>
        <div style={{ display: 'flex', gap: 18, alignItems: 'center', marginBottom: 18 }}>
          <AvatarFramed src={avatarUrl || null} name={prof.name} glow={PROFILE_TOKENS.secondary} size={84} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ ...profileChip(true), textAlign: 'center', cursor: 'pointer', display: 'inline-block' }}>
              Upload picture
              <input type="file" accept="image/*" onChange={onPickFile} style={{ display: 'none' }} />
            </label>
            <input value={avatarUrl} onChange={e => setAvatarUrl(e.target.value)} placeholder="...or paste image URL"
              style={{ padding: '8px 10px', background: PROFILE_TOKENS.bg, color: PROFILE_TOKENS.text, border: `1px solid ${PROFILE_TOKENS.border}`, borderRadius: 8, fontSize: 13, fontFamily: PROFILE_FONT }} />
          </div>
        </div>
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, color: PROFILE_TOKENS.muted, letterSpacing: 1.5, fontWeight: 700, marginBottom: 6 }}>BIO</div>
          <textarea value={bio} onChange={e => setBio(e.target.value.slice(0, 500))} rows={5} placeholder="Tell the chain about yourself…"
            style={{ width: '100%', padding: 12, background: PROFILE_TOKENS.bg, color: PROFILE_TOKENS.text, border: `1px solid ${PROFILE_TOKENS.border}`, borderRadius: 8, fontSize: 13, fontFamily: PROFILE_FONT, resize: 'vertical', minHeight: 110 }} />
          <div style={{ fontSize: 10, color: PROFILE_TOKENS.muted, textAlign: 'right' }}>{bio.length}/500</div>
        </div>
        {err && <div style={{ fontSize: 12, color: PROFILE_TOKENS.danger, marginBottom: 10 }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={profileChip(false)}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ ...profileChip(true), opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Public (read-only) profile shown when clicking a leaderboard name ──────
function PublicProfile({ name, onBack }: { name: string; onBack: () => void }) {
  const mobile = useIsMobile();
  const [prof, setProf] = useState<Profile | null>(null);
  const [deck, setDeck] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setErr('');
      try {
        const [p, d] = await Promise.all([
          getProfileApi(name).catch(() => null),
          getDeckApi(name).catch(() => [] as string[]),
        ]);
        if (cancelled) return;
        setProf(p);
        setDeck(d);
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [name]);

  const games = prof ? prof.wins + prof.losses + prof.draws : 0;
  const winPct = games ? Math.round((prof!.wins / games) * 100) : 0;

  // Group deck list by card def, count copies, then sort by color then cost.
  const deckGrouped = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const id of deck) counts[id] = (counts[id] ?? 0) + 1;
    const rows = Object.entries(counts)
      .map(([id, n]) => ({ id, n, def: CARDS[id] }))
      .filter(r => !!r.def);
    rows.sort((a, b) => {
      if (a.def.color !== b.def.color) return COLORS.indexOf(a.def.color) - COLORS.indexOf(b.def.color);
      const typeOrder = ['node', 'meme', 'machine', 'aura', 'move'];
      const ta = typeOrder.indexOf(a.def.type), tb = typeOrder.indexOf(b.def.type);
      if (ta !== tb) return ta - tb;
      return a.def.name.localeCompare(b.def.name);
    });
    return rows;
  }, [deck]);

  const deckValid = validateDeck(deck);

  return (
    <div style={{ fontFamily: 'system-ui', background: '#0a0a0c', minHeight: '100vh', color: '#eee' }}>
      <div style={{ padding: '14px 22px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #222' }}>
        <button onClick={onBack} style={ghostBtn}>← Back</button>
        <div style={{ fontWeight: 800, letterSpacing: 1.5 }}>PROFILE</div>
        <div style={{ width: 80 }} />
      </div>

      {loading ? (
        <div style={{ padding: 40, color: '#888' }}>Loading…</div>
      ) : !prof ? (
        <div style={{ padding: 40, color: '#888' }}>No profile found for "{name}".</div>
      ) : (
        <>
          <div style={{
            display: 'grid',
            gridTemplateColumns: mobile ? '1fr' : 'minmax(220px, 280px) 1fr',
            gap: mobile ? 16 : 24,
            padding: mobile ? 14 : 24,
            maxWidth: 980, margin: '0 auto',
          }}>
            {/* Avatar + record */}
            <div>
              <div style={{
                width: '100%', aspectRatio: '1', borderRadius: 12, overflow: 'hidden',
                background: '#181820', border: '1px solid #2a2a32',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {prof.avatarUrl ? (
                  <img src={prof.avatarUrl} alt={prof.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div style={{ fontSize: 64, color: '#444' }}>👤</div>
                )}
              </div>
              <div style={{ marginTop: 18, padding: 14, background: '#101015', border: '1px solid #25252e', borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: '#888', letterSpacing: 1.5, marginBottom: 8 }}>RECORD</div>
                <div style={{ display: 'flex', justifyContent: 'space-around', textAlign: 'center' }}>
                  <Stat label="Wins"   value={prof.wins}   color="#7fdc7f" />
                  <Stat label="Losses" value={prof.losses} color="#ef7373" />
                  <Stat label="Draws"  value={prof.draws}  color="#cccc77" />
                </div>
                <div style={{ marginTop: 12, textAlign: 'center', color: '#aaa', fontSize: 13 }}>
                  {games} games · <b style={{ color: '#fff' }}>{winPct}%</b> win rate
                </div>
              </div>
            </div>

            {/* Name + bio */}
            <div>
              <div style={labelStyle}>NAME</div>
              <div style={{
                padding: '10px 12px', background: '#101015', border: '1px solid #25252e', borderRadius: 6,
                fontSize: 22, fontWeight: 800, color: '#fff',
              }}>{prof.name}</div>

              <div style={{ marginTop: 18 }}>
                <div style={labelStyle}>BIO</div>
                <div style={{
                  padding: '10px 12px', background: '#101015', border: '1px solid #25252e', borderRadius: 6,
                  minHeight: 80, color: '#ccc', whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.5,
                }}>
                  {prof.bio?.trim() || <span style={{ color: '#555' }}>No bio.</span>}
                </div>
              </div>

              {err && <div style={{ marginTop: 10, color: '#ef7373', fontSize: 12 }}>{err}</div>}
            </div>
          </div>

          {/* Custom deck */}
          <div style={{ maxWidth: 980, margin: '0 auto', padding: mobile ? '0 14px 40px' : '0 24px 50px' }}>
            <div style={{ padding: 14, background: '#101015', border: '1px solid #25252e', borderRadius: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div style={{ fontWeight: 800, color: '#9cf', letterSpacing: 1.5, fontSize: 14 }}>
                  🛠️ {prof.name.toUpperCase()}'S CUSTOM DECK ({deckGrouped.reduce((s, r) => s + r.n, 0)}/{DECK_SIZE})
                </div>
                {deck.length > 0 && (
                  <div style={{ fontSize: 11, color: deckValid.ok ? '#7fdc7f' : '#fc8' }}>
                    {deckValid.ok ? '✓ Legal' : 'Incomplete deck'}
                  </div>
                )}
              </div>

              {deck.length === 0 ? (
                <div style={{ marginTop: 12, fontSize: 13, color: '#777' }}>
                  This player hasn't published a custom deck yet.
                </div>
              ) : (
                <div style={{
                  marginTop: 12, display: 'grid',
                  gridTemplateColumns: `repeat(auto-fill, minmax(${mobile ? 150 : 220}px, 1fr))`,
                  gap: 6,
                }}>
                  {deckGrouped.map(r => {
                    const meta = COLOR_META[r.def.color];
                    return (
                      <div key={r.id} style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '6px 8px',
                        background: '#161620', border: '1px solid #2a2a32', borderRadius: 4,
                      }}>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          minWidth: 22, height: 20, padding: '0 5px',
                          background: meta.hex, color: meta.ink,
                          borderRadius: 4, fontWeight: 800, fontSize: 12,
                        }}>{r.n}×</span>
                        <span style={{ flex: 1, fontSize: 12, color: '#eee', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r.def.name}
                        </span>
                        <span style={{ fontSize: 10, color: '#888', textTransform: 'uppercase' }}>{r.def.type}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Sproto Gremlin NFT showcase (collection 5Vz7…6MSU) ──────────────────────
function SprotoGremlinShowcase({ walletAddress }: { walletAddress: string | null }) {
  const [items, setItems] = useState<OwnedNft[] | null>(null);
  const [loading, setLoading] = useState(false);
  const isSol = !!walletAddress && !walletAddress.startsWith('0x');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!walletAddress || !isSol) { setItems([]); return; }
      setLoading(true);
      try {
        const owned = await listOwnedSprotoGremlins(walletAddress);
        if (!cancelled) setItems(owned);
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [walletAddress, isSol]);

  if (!walletAddress) return null;
  if (!isSol)         return null;
  if (loading && !items) {
    return (
      <div style={{ padding: 18, color: '#9aa6c0', fontSize: 13 }}>
        Scanning your wallet for Sproto Gremlins…
      </div>
    );
  }
  if (!items || items.length === 0) return null;

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 10, padding: '0 4px',
      }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#e9eef7' }}>
          🦎 Sproto Gremlins <span style={{ color: '#7d8aa3', fontWeight: 500 }}>· {items.length} owned</span>
        </div>
        <a
          href={`https://solscan.io/token/${SPROTO_COLLECTION_MINT}`}
          target="_blank" rel="noopener noreferrer"
          style={{ fontSize: 11, color: '#7c5cff', textDecoration: 'none' }}
        >
          collection ↗
        </a>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
        gap: 12,
      }}>
        {items.map(it => (
          <a
            key={it.mint}
            href={`https://solscan.io/token/${it.mint}`}
            target="_blank" rel="noopener noreferrer"
            title={it.name}
            style={{
              display: 'block',
              border: '1px solid #232f45',
              borderRadius: 12,
              overflow: 'hidden',
              background: '#0e1422',
              textDecoration: 'none',
              color: 'inherit',
              transition: 'transform 120ms ease, border-color 120ms ease',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLAnchorElement).style.transform = 'translateY(-2px)';
              (e.currentTarget as HTMLAnchorElement).style.borderColor = '#7c5cff';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLAnchorElement).style.transform = 'translateY(0)';
              (e.currentTarget as HTMLAnchorElement).style.borderColor = '#232f45';
            }}
          >
            <div style={{ aspectRatio: '5 / 7', background: '#000' }}>
              <img
                src={it.image}
                alt={it.name}
                loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/sproto-gremlin.png'; }}
              />
            </div>
            <div style={{ padding: '8px 10px', fontSize: 12, fontWeight: 600, color: '#e9eef7' }}>
              {it.name}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

// ── NFT library (Memetic Masters via Helius) ────────────────────────────────
function LibrarySection({ prof }: { prof: Profile | null }) {
  const mobile = useIsMobile();
  const [cards, setCards] = useState<LibraryCard[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const wallet = prof?.walletAddress ?? '';
  const isSol = !!wallet && !wallet.startsWith('0x');

  const load = useCallback(async () => {
    if (!wallet) return;
    setLoading(true); setErr('');
    try { setCards(await getLibraryApi(wallet)); }
    catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setLoading(false); }
  }, [wallet]);

  useEffect(() => { if (wallet && isSol) load(); }, [wallet, isSol, load]);

  const count = cards?.length ?? 0;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: '#cfd6e3', fontWeight: 700 }}>
          {count > 0 ? `${count} NFT${count === 1 ? '' : 's'} Owned` : '0 NFTs Owned'}
        </div>
        {wallet && isSol && (
          <button onClick={load} style={profileChip(false)} disabled={loading}>
            {loading ? '…' : '↻ Refresh'}
          </button>
        )}
      </div>

      {!wallet && (
        <EmptyState icon="🔗" title="No wallet linked"
          message="Connect a Solana wallet from the home screen to display your Memetic Masters collection." />
      )}
      {wallet && !isSol && (
        <EmptyState icon="⚠️" title="EVM wallet detected"
          message={`Memetic Masters live on Solana. Your linked wallet (${wallet.slice(0,6)}…) is EVM — link a Solana wallet.`} />
      )}
      {err && (
        <div style={{ marginTop: 8, fontSize: 12, color: PROFILE_TOKENS.danger }}>{err}</div>
      )}
      {wallet && isSol && !loading && cards && cards.length === 0 && !err && (
        <EmptyState icon="🎴" title="No Memetic Masters found"
          message="No Memetic Masters NFTs were found in this wallet. Pick some up to fill your showcase." />
      )}
      {wallet && isSol && loading && (
        <div style={{ padding: 24, color: PROFILE_TOKENS.muted, fontSize: 13, textAlign: 'center' }}>Scanning chain…</div>
      )}

      {cards && cards.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fill, minmax(${mobile ? 130 : 168}px, 1fr))`,
          gap: 12,
        }}>
          {cards.map(c => <LibraryCardTile key={c.id} card={c} />)}
        </div>
      )}
    </div>
  );
}

function LibraryCardTile({ card }: { card: LibraryCard }) {
  return (
    <div
      onMouseEnter={e => {
        const img = e.currentTarget.querySelector('img') as HTMLImageElement | null;
        if (img) img.style.transform = 'scale(1.08)';
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow = `0 14px 30px -10px ${PROFILE_TOKENS.accent}55`;
        e.currentTarget.style.borderColor = PROFILE_TOKENS.accent + '88';
      }}
      onMouseLeave={e => {
        const img = e.currentTarget.querySelector('img') as HTMLImageElement | null;
        if (img) img.style.transform = 'scale(1)';
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = 'none';
        e.currentTarget.style.borderColor = PROFILE_TOKENS.border;
      }}
      style={{
        borderRadius: 10, overflow: 'hidden',
        background: PROFILE_TOKENS.cardSoft, border: `1px solid ${PROFILE_TOKENS.border}`,
        display: 'flex', flexDirection: 'column',
        transition: '200ms ease',
      }}>
      <div style={{ aspectRatio: '1', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {card.image
          ? <img src={card.image} alt={card.name} loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'transform 300ms ease' }} />
          : <div style={{ fontSize: 36, color: PROFILE_TOKENS.muted }}>🎴</div>}
      </div>
      <div style={{ padding: '8px 10px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {card.name}
        </div>
        {card.collection && (
          <div style={{ fontSize: 10, color: PROFILE_TOKENS.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {card.collection}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Deckbuilder ─────────────────────────────────────────────────────────────
function DeckbuilderPanel({ myName }: { myName: string }) {
  const mobile = useIsMobile();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [filter, setFilter] = useState<Color | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'node' | 'meme' | 'machine' | 'aura' | 'move'>('all');

  // ── Deck Library state ─────────────────────────────────────────────────────
  const [decks, setDecks] = useState<DeckEntry[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState<string>('');
  const [libBusy, setLibBusy] = useState(false);

  function countsFromCards(cards: string[]): Record<string, number> {
    const next: Record<string, number> = {};
    for (const id of cards) next[id] = (next[id] ?? 0) + 1;
    return next;
  }

  // Initial load: list decks, populate editor with active (or first).
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const list = await listDecksApi(myName);
        setDecks(list);
        const pick = list.find(d => d.isActive) ?? list[0] ?? null;
        if (pick) {
          setEditingId(pick.id);
          setEditingName(pick.name);
          setCounts(countsFromCards(pick.cards));
        } else {
          // Legacy fallback: pull "the deck" via back-compat endpoint.
          const cards = await getDeckApi(myName);
          setCounts(countsFromCards(cards));
          setEditingId(null);
          setEditingName('');
        }
      } catch {
        try {
          const cards = await getDeckApi(myName);
          setCounts(countsFromCards(cards));
        } catch { /* leave empty */ }
      } finally { setLoading(false); }
    })();
  }, [myName]);

  const deckList = useMemo(() => {
    const out: string[] = [];
    for (const [id, n] of Object.entries(counts)) for (let i = 0; i < n; i++) out.push(id);
    return out;
  }, [counts]);
  const validation = useMemo(() => validateDeck(deckList), [deckList]);
  const total = validation.size;

  function bump(id: string, delta: number) {
    setCounts(prev => {
      const cur = prev[id] ?? 0;
      let next = cur + delta;
      if (next < 0) next = 0;
      if (!isBasicNode(id) && next > MAX_COPIES_NONBASIC) next = MAX_COPIES_NONBASIC;
      if (delta > 0 && total >= DECK_SIZE) return prev;
      const out = { ...prev };
      if (next === 0) delete out[id]; else out[id] = next;
      return out;
    });
  }

  async function save() {
    setSaving(true); setStatus('');
    try {
      if (!validation.ok) { setStatus(validation.issues[0]?.message ?? 'Invalid deck.'); return; }
      if (editingId != null) {
        const updated = await updateDeckApi(myName, editingId, { cards: deckList });
        setDecks(prev => prev.map(d => d.id === editingId ? { ...d, cards: updated.cards } : d));
        setStatus(`Saved “${editingName}”!`);
      } else {
        // Create a new deck row (legacy fallback path).
        const name = window.prompt('Name this deck:', 'Default') ?? '';
        if (!name.trim()) { setStatus('Save cancelled.'); return; }
        const created = await createDeckApi(myName, name.trim(), deckList);
        setDecks(prev => [...prev, created]);
        setEditingId(created.id);
        setEditingName(created.name);
        setStatus(`Saved “${created.name}”!`);
      }
      // Also write the back-compat single-deck slot so old callers see latest.
      try { await saveDeckApi(myName, deckList); } catch { /* non-fatal */ }
    } catch (e: any) {
      setStatus(String(e?.message ?? e));
    } finally { setSaving(false); }
  }
  function clear() {
    if (!confirm('Clear cards from this deck (does not delete the deck)?')) return;
    setCounts({});
    setStatus('');
  }

  async function newDeck() {
    const name = window.prompt('Name your new deck:', `Deck ${decks.length + 1}`) ?? '';
    if (!name.trim()) return;
    setLibBusy(true); setStatus('');
    try {
      const created = await createDeckApi(myName, name.trim(), []);
      setDecks(prev => [...prev, created]);
      setEditingId(created.id);
      setEditingName(created.name);
      setCounts({});
      setStatus(`Created “${created.name}”.`);
    } catch (e: any) {
      setStatus(String(e?.message ?? e));
    } finally { setLibBusy(false); }
  }

  function loadDeck(d: DeckEntry) {
    if (saving || libBusy) return;
    if (editingId === d.id) return;
    setEditingId(d.id);
    setEditingName(d.name);
    setCounts(countsFromCards(d.cards));
    setStatus('');
  }

  async function setActive(d: DeckEntry) {
    setLibBusy(true); setStatus('');
    try {
      await activateDeckApi(myName, d.id);
      setDecks(prev => prev.map(x => ({ ...x, isActive: x.id === d.id })));
      setStatus(`“${d.name}” is now active.`);
    } catch (e: any) {
      setStatus(String(e?.message ?? e));
    } finally { setLibBusy(false); }
  }

  async function renameDeck(d: DeckEntry) {
    const name = window.prompt('Rename deck:', d.name) ?? '';
    if (!name.trim() || name.trim() === d.name) return;
    setLibBusy(true); setStatus('');
    try {
      const updated = await updateDeckApi(myName, d.id, { name: name.trim() });
      setDecks(prev => prev.map(x => x.id === d.id ? { ...x, name: updated.name } : x));
      if (editingId === d.id) setEditingName(updated.name);
    } catch (e: any) {
      setStatus(String(e?.message ?? e));
    } finally { setLibBusy(false); }
  }

  async function removeDeck(d: DeckEntry) {
    if (!confirm(`Delete deck “${d.name}”? This cannot be undone.`)) return;
    setLibBusy(true); setStatus('');
    try {
      await deleteDeckApi(myName, d.id);
      const remaining = decks.filter(x => x.id !== d.id);
      setDecks(remaining);
      if (editingId === d.id) {
        const next = remaining.find(x => x.isActive) ?? remaining[0] ?? null;
        if (next) { setEditingId(next.id); setEditingName(next.name); setCounts(countsFromCards(next.cards)); }
        else      { setEditingId(null); setEditingName(''); setCounts({}); }
      }
    } catch (e: any) {
      setStatus(String(e?.message ?? e));
    } finally { setLibBusy(false); }
  }

  const visible = useMemo(() => {
    return BUILDABLE_CARDS.filter(c =>
      (filter === 'all' || c.color === filter) &&
      (typeFilter === 'all' || c.type === typeFilter)
    );
  }, [filter, typeFilter]);

  return (
    <div>
      {/* Deck Library sidebar (rendered as a horizontal bar on mobile, top on desktop too for simplicity) */}
      <div style={{
        marginBottom: 14, padding: 12, borderRadius: 12,
        background: '#0a1224', border: `1px solid ${PROFILE_TOKENS.border}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontSize: 11, letterSpacing: 1.5, fontWeight: 700, color: PROFILE_TOKENS.muted, textTransform: 'uppercase' }}>
            📚 Deck Library {decks.length > 0 && <span style={{ color: PROFILE_TOKENS.accent }}>({decks.length})</span>}
          </div>
          <button onClick={newDeck} disabled={libBusy || saving}
            style={{ ...profileChip(true), opacity: (libBusy || saving) ? 0.5 : 1 }}>
            + New Deck
          </button>
        </div>
        {decks.length === 0 ? (
          <div style={{ fontSize: 12, color: PROFILE_TOKENS.muted }}>
            No saved decks yet. Build cards below and hit <b>Save Deck</b> to create your first.
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {decks.map(d => {
              const isEditing = d.id === editingId;
              return (
                <div key={d.id} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
                  borderRadius: 8,
                  background: isEditing ? `${PROFILE_TOKENS.accent}22` : '#0f1830',
                  border: `1px solid ${isEditing ? PROFILE_TOKENS.accent : PROFILE_TOKENS.border}`,
                }}>
                  <button onClick={() => loadDeck(d)} title="Load into editor"
                    style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 13, padding: 0 }}>
                    {d.isActive ? '⭐ ' : ''}{d.name}
                    <span style={{ marginLeft: 6, fontSize: 10, color: PROFILE_TOKENS.muted, fontWeight: 600 }}>
                      ({d.cards.length})
                    </span>
                  </button>
                  {!d.isActive && (
                    <button onClick={() => setActive(d)} disabled={libBusy} title="Set as active deck"
                      style={{ background: 'transparent', border: 'none', color: PROFILE_TOKENS.accent, cursor: 'pointer', fontSize: 12 }}>
                      ⭐
                    </button>
                  )}
                  <button onClick={() => renameDeck(d)} disabled={libBusy} title="Rename"
                    style={{ background: 'transparent', border: 'none', color: PROFILE_TOKENS.muted, cursor: 'pointer', fontSize: 12 }}>
                    ✎
                  </button>
                  <button onClick={() => removeDeck(d)} disabled={libBusy} title="Delete"
                    style={{ background: 'transparent', border: 'none', color: PROFILE_TOKENS.danger, cursor: 'pointer', fontSize: 12 }}>
                    🗑
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Header — deck progress + actions */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12,
        marginBottom: 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <div style={{ fontSize: 32, fontWeight: 900, color: total === DECK_SIZE ? PROFILE_TOKENS.accent : '#fff', lineHeight: 1 }}>
            {total}<span style={{ fontSize: 18, color: PROFILE_TOKENS.muted, fontWeight: 700 }}>/{DECK_SIZE}</span>
          </div>
          <div style={{ fontSize: 11, color: PROFILE_TOKENS.muted, letterSpacing: 1.5, fontWeight: 700, textTransform: 'uppercase' }}>
            {editingName ? `Editing: ${editingName}` : 'Cards in Deck'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {status && <span style={{ fontSize: 12, color: status.startsWith('Saved') || status.startsWith('Created') || status.endsWith('active.') ? PROFILE_TOKENS.accent : PROFILE_TOKENS.danger }}>{status}</span>}
          <button onClick={clear} style={profileChip(false)}>Clear</button>
          <button onClick={save} disabled={!validation.ok || saving}
            style={{ ...profileChip(true), opacity: (!validation.ok || saving) ? 0.5 : 1, cursor: (!validation.ok || saving) ? 'not-allowed' : 'pointer' }}>
            {saving ? 'Saving…' : (editingId != null ? '💾 Save Deck' : '💾 Save as New')}
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{
        height: 6, borderRadius: 999, overflow: 'hidden',
        background: '#0a1224', border: `1px solid ${PROFILE_TOKENS.border}`,
        marginBottom: 14,
      }}>
        <div style={{
          width: `${Math.min(100, (total / DECK_SIZE) * 100)}%`, height: '100%',
          background: total === DECK_SIZE
            ? `linear-gradient(90deg, ${PROFILE_TOKENS.accent}, ${PROFILE_TOKENS.secondary})`
            : PROFILE_TOKENS.warning,
          transition: 'width 200ms ease',
        }} />
      </div>

      {/* Validation hints */}
      {!validation.ok && validation.issues.length > 0 && total > 0 && (
        <div style={{
          marginBottom: 12, padding: '8px 12px', borderRadius: 8,
          background: `${PROFILE_TOKENS.warning}11`, border: `1px solid ${PROFILE_TOKENS.warning}55`,
          fontSize: 12, color: PROFILE_TOKENS.warning,
        }}>
          {validation.issues.slice(0, 3).map((it, i) => <div key={i}>• {it.message}</div>)}
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <FilterChip selected={filter === 'all'} onClick={() => setFilter('all')} label="All Chains" />
        {COLORS.map(c => (
          <FilterChip key={c} selected={filter === c}
            onClick={() => setFilter(c)}
            label={COLOR_META[c].name} hex={COLOR_META[c].hex} ink={COLOR_META[c].ink} />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {(['all', 'node', 'meme', 'machine', 'aura', 'move'] as const).map(t => (
          <FilterChip key={t} selected={typeFilter === t}
            onClick={() => setTypeFilter(t)}
            label={t === 'all' ? 'All Types' : t.charAt(0).toUpperCase() + t.slice(1)} />
        ))}
      </div>

      {loading ? (
        <div style={{ padding: 24, color: PROFILE_TOKENS.muted, fontSize: 13 }}>Loading deck…</div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fill, minmax(${mobile ? 152 : 180}px, 1fr))`,
          gap: 12,
        }}>
          {visible.map(def => {
            const n = counts[def.id] ?? 0;
            const cap = isBasicNode(def.id) ? Infinity : MAX_COPIES_NONBASIC;
            return (
              <DeckBuilderCard key={def.id}
                def={def} count={n} cap={cap} totalFull={total >= DECK_SIZE}
                onPlus={() => bump(def.id, +1)}
                onMinus={() => bump(def.id, -1)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function DeckBuilderCard({ def, count, cap, totalFull, onPlus, onMinus }: {
  def: any; count: number; cap: number; totalFull: boolean;
  onPlus: () => void; onMinus: () => void;
}) {
  const meta = COLOR_META[def.color as Color];
  const owned = count > 0;
  return (
    <CardHover defId={def.id}>
      <div
        onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = `0 14px 28px -10px ${meta.hex}66`; }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = owned ? `0 0 0 1px ${meta.hex}88 inset` : 'none'; }}
        style={{
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          background: PROFILE_TOKENS.cardSoft, borderRadius: 12,
          border: `1px solid ${owned ? meta.hex + '88' : PROFILE_TOKENS.border}`,
          transition: '200ms ease',
          boxShadow: owned ? `0 0 0 1px ${meta.hex}88 inset` : 'none',
        }}>
        {/* Art */}
        <div style={{
          aspectRatio: '1', overflow: 'hidden',
          background: `linear-gradient(160deg, ${meta.hex}, #0a1020)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          position: 'relative',
        }}>
          {def.image
            ? <img src={def.image} alt={def.name} loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ fontSize: 36, color: meta.ink, fontWeight: 900, opacity: 0.8 }}>{(meta as any).glyph ?? meta.name[0]}</span>}
          {/* Type badge */}
          <span style={{
            position: 'absolute', top: 6, left: 6,
            padding: '2px 7px', borderRadius: 999, fontSize: 9, fontWeight: 800,
            background: 'rgba(0,0,0,0.7)', color: '#fff', letterSpacing: 1, textTransform: 'uppercase',
          }}>{def.type}</span>
          {/* Cost badge (sum of all chain gas) */}
          {def.cost && Object.keys(def.cost).length > 0 && (
            <span style={{
              position: 'absolute', top: 6, right: 6,
              minWidth: 22, height: 22, padding: '0 6px',
              borderRadius: 999,
              background: meta.hex, color: meta.ink,
              fontSize: 11, fontWeight: 900,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}>{Object.values(def.cost as Record<string, number>).reduce((s, n) => s + (n as number), 0)}</span>
          )}
          {/* Power/toughness for memes */}
          {def.type === 'meme' && (
            <span style={{
              position: 'absolute', bottom: 6, right: 6,
              padding: '2px 7px', borderRadius: 6,
              background: 'rgba(0,0,0,0.75)', color: '#fff',
              fontSize: 12, fontWeight: 900,
            }}>{def.power}/{def.toughness}</span>
          )}
        </div>
        {/* Footer */}
        <div style={{ padding: '10px 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{
            fontSize: 13, fontWeight: 800, color: '#fff', lineHeight: 1.2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{def.name}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: meta.hex,
            }}>{meta.name}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button onClick={onMinus} disabled={count === 0} style={qtyBtn(count > 0)}>−</button>
              <div style={{
                minWidth: 22, textAlign: 'center', fontSize: 14, fontWeight: 900,
                color: count > 0 ? '#fff' : PROFILE_TOKENS.muted,
              }}>{count}</div>
              <button onClick={onPlus} disabled={count >= cap || totalFull} style={qtyBtn(count < cap && !totalFull)}>+</button>
            </div>
          </div>
        </div>
      </div>
    </CardHover>
  );
}

function qtyBtn(enabled: boolean): React.CSSProperties {
  return {
    width: 26, height: 26, padding: 0, borderRadius: 6,
    background: enabled ? 'linear-gradient(180deg, #1a2238, #101728)' : '#0c1220',
    color: enabled ? '#fff' : PROFILE_TOKENS.muted,
    border: `1px solid ${enabled ? PROFILE_TOKENS.borderHi : PROFILE_TOKENS.border}`,
    fontSize: 16, fontWeight: 900, cursor: enabled ? 'pointer' : 'not-allowed',
    transition: '150ms ease', lineHeight: 1,
    fontFamily: PROFILE_FONT,
  };
}

function FilterChip({ selected, onClick, label, hex, ink }: { selected: boolean; onClick: () => void; label: string; hex?: string; ink?: string }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 10px', fontSize: 12, fontWeight: 700,
      background: selected ? (hex ?? '#e9e4d0') : 'transparent',
      color: selected ? (ink ?? '#000') : '#ccc',
      border: `1px solid ${selected ? (hex ?? '#888') : '#3a3a44'}`,
      borderRadius: 999, cursor: 'pointer',
    }}>{label}</button>
  );
}

const tinyBtn: React.CSSProperties = {
  width: 22, height: 22, padding: 0,
  background: '#1c1c24', color: '#fff',
  border: '1px solid #3a3a44', borderRadius: 4,
  fontSize: 14, fontWeight: 800, cursor: 'pointer',
};

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div style={{ fontSize: 26, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 11, color: '#888', letterSpacing: 1 }}>{label}</div>
    </div>
  );
}

// ── Lobby screen ────────────────────────────────────────────────────────────
function Lobby({
  myName, onJoined, onBack, onViewProfile, onSolo,
}: { myName: string; onJoined: (seat: Seat) => void; onBack: () => void; onViewProfile: (name: string) => void; onSolo: () => void }) {
  const mobile = useIsMobile();
  const [matches, setMatches] = useState<any[]>([]);
  const [leaderboard, setLeaderboard] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Create-match panel state — creator only picks their own color now.
  const [myColor, setMyColor] = useState<Color>('sol');
  const [seatChoice, setSeatChoice] = useState<'0' | '1'>('0');
  // Custom-deck state (creator and joiner each pick standard color OR custom).
  // myDecks = all saved decks; selected* = which one is in play. The flat
  // myDeck/joinDeck arrays below are derived from those, kept as state so
  // the rest of the lobby code (validation, setupData payload, etc.) can
  // read them synchronously.
  const [myDecks, setMyDecks] = useState<DeckEntry[]>([]);
  const [mySelectedDeckId, setMySelectedDeckId] = useState<number | null>(null);
  const [myDeck, setMyDeck] = useState<string[]>([]);
  const [useCustom, setUseCustom] = useState(false);
  const [joinSelectedDeckId, setJoinSelectedDeckId] = useState<number | null>(null);
  const [joinDeck, setJoinDeck] = useState<string[]>([]);
  const [joinUseCustom, setJoinUseCustom] = useState(false);
  // Join modal state — second player picks their color when accepting.
  const [joinTarget, setJoinTarget] = useState<{ match: any; seat: string } | null>(null);
  const [plazaOpen, setPlazaOpen] = useState(false);
  const [joinColor, setJoinColor] = useState<Color>('eth');
  // Match stakes — 'free' or a $MASTER token wager. Currently UI-only metadata stored in setupData.
  const [wagerKind, setWagerKind] = useState<'free' | 'master'>('free');
  const [wagerAmount, setWagerAmount] = useState<string>('1000');
  // Optional human-readable match name so opponents can find each other in the lobby.
  const [matchName, setMatchName] = useState<string>('');
  // Center-column action tabs — one dominant action at a time instead of 3 stacked forms.
  const [centerTab, setCenterTab] = useState<'quick' | 'create' | 'challenge'>('quick');

  // Player profile for top-bar header (avatar, win rate, level)
  const [myProfile, setMyProfile] = useState<Profile | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        let p = await getProfileApi(myName);
        if (!p) p = await upsertProfileApi(myName);
        if (alive) setMyProfile(p);
      } catch {}
    })();
    return () => { alive = false; };
  }, [myName]);

  // ── Solana wallet picker (Phantom / Solflare / Backpack) ───────────────────
  const [walletPicker, setWalletPicker] = useState<null | {
    resolve: (kind: SolanaWalletKind) => void; reject: (e: Error) => void;
  }>(null);
  const pickSolanaWallet = useCallback((): Promise<SolanaWalletKind> => {
    return new Promise((resolve, reject) => setWalletPicker({ resolve, reject }));
  }, []);

  // ── Challenges: poll both incoming and outgoing every 5s ────────────────────
  const [incomingChallenges, setIncomingChallenges] = useState<Challenge[]>([]);
  const [outgoingChallenges, setOutgoingChallenges] = useState<Challenge[]>([]);
  const [challengeTarget, setChallengeTarget] = useState<string>('');
  const [challengeMsg, setChallengeMsg] = useState<string>('');
  const [challengeBusy, setChallengeBusy] = useState<boolean>(false);
  useEffect(() => {
    if (!myName) return;
    let alive = true;
    const poll = async () => {
      try {
        const [inc, out] = await Promise.all([
          listIncomingChallengesApi(myName),
          listOutgoingChallengesApi(myName),
        ]);
        if (!alive) return;
        setIncomingChallenges(inc);
        setOutgoingChallenges(out);
      } catch {}
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [myName]);

  // Load this player's full deck library on mount. Default both the create-
  // and join-side selection to the active deck (or first deck if no active).
  useEffect(() => {
    (async () => {
      try {
        const decks = await listDecksApi(myName);
        setMyDecks(decks);
        const initial = decks.find(d => d.isActive) ?? decks[0] ?? null;
        if (initial) {
          setMySelectedDeckId(initial.id);
          setJoinSelectedDeckId(initial.id);
          setMyDeck(initial.cards);
          setJoinDeck(initial.cards);
        }
      } catch {}
    })();
  }, [myName]);

  // Whenever the user picks a different deck from the dropdown, sync the
  // flat cards array used by the rest of the lobby code.
  useEffect(() => {
    const d = myDecks.find(d => d.id === mySelectedDeckId);
    if (d) setMyDeck(d.cards);
  }, [myDecks, mySelectedDeckId]);
  useEffect(() => {
    const d = myDecks.find(d => d.id === joinSelectedDeckId);
    if (d) setJoinDeck(d.cards);
  }, [myDecks, joinSelectedDeckId]);

  const myDeckOk = useMemo(() => validateDeck(myDeck).ok, [myDeck]);

  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await lobby.listMatches(GAME_NAME);
      setMatches(r.matches);
      const profs = await listProfilesApi();
      setLeaderboard(profs);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, [refresh]);

  async function createAndJoin() {
    setError('');
    try {
      if (useCustom && !myDeckOk) {
        setError(`Custom deck must be exactly ${DECK_SIZE} cards. Build it in Profile → Custom Deck.`);
        return;
      }
      let wager = parseWager(wagerKind, wagerAmount);
      if (wagerKind === 'master' && !wager) {
        setError('Enter a valid $MASTER wager amount greater than 0.');
        return;
      }
      // For $MASTER wagers, deposit into the server-held custodial escrow
      // BEFORE creating the BG.io match so we never have a "ghost" wagered
      // match the creator didn't actually back. Phantom prompts for the
      // SPL-token transfer signature.
      if (wager && wager.kind === 'master') {
        const kind = await pickSolanaWallet();
        const phantom = await getSolanaWallet(kind);
        const conn = solConn();
        const custId = matchIdToHex(newMatchId());
        const intent = await requestWagerIntent({ matchID: custId, playerID: '0', amount: wager.amount });
        await depositCustodialWager({ connection: conn, wallet: phantom, intent });
        wager = { kind: 'master', amount: wager.amount, onchainId: custId, mode: 'custodial' };
      }
      await upsertProfileApi(myName);
      // When using a custom deck, the color slot is null and the deck is passed
      // via setupData.decks; the game derives a theme color from the deck.
      const colors: Array<Color | null> = ['0', '1'].map(s =>
        s === seatChoice ? (useCustom ? null : myColor) : null
      ) as Array<Color | null>;
      const decks: Array<string[] | null> = ['0', '1'].map(s =>
        s === seatChoice && useCustom ? myDeck : null
      ) as Array<string[] | null>;
      const trimmedName = matchName.trim().slice(0, 40);
      const created = await lobby.createMatch(GAME_NAME, {
        numPlayers: 2,
        setupData: { colors, names: ['Player 0', 'Player 1'], decks, wager, matchName: trimmedName || undefined },
      });
      const joined = await lobby.joinMatch(GAME_NAME, created.matchID, {
        playerID: seatChoice,
        playerName: myName,
      });
      // Creator already picked, no pending color needed.
      try { sessionStorage.removeItem('pendingPickColor'); } catch {}
      try { sessionStorage.removeItem('pendingCustomDeck'); } catch {}
      onJoined({ matchID: created.matchID, playerID: seatChoice, credentials: joined.playerCredentials, playerName: myName });
    } catch (e: any) { setError(String(e?.message ?? e)); }
  }

  /** Create a private match seeded for a direct opponent and notify them via the challenge inbox. */
  async function sendChallenge() {
    setError('');
    const target = challengeTarget.trim();
    if (!target) { setError('Enter the opponent\'s exact username.'); return; }
    if (target.toLowerCase() === myName.trim().toLowerCase()) {
      setError('You can\'t challenge yourself.'); return;
    }
    if (useCustom && !myDeckOk) {
      setError(`Custom deck must be exactly ${DECK_SIZE} cards. Build it in Profile → Custom Deck.`);
      return;
    }
    setChallengeBusy(true);
    try {
      // Verify the recipient exists before doing anything expensive.
      const target_p = await getProfileApi(target);
      if (!target_p) {
        setError(`No player named "${target}" was found. Usernames are case-insensitive.`);
        return;
      }

      let wager = parseWager(wagerKind, wagerAmount);
      if (wagerKind === 'master' && !wager) {
        setError('Enter a valid $MASTER wager amount greater than 0.');
        return;
      }
      if (wager && wager.kind === 'master') {
        const kind = await pickSolanaWallet();
        const phantom = await getSolanaWallet(kind);
        const conn = solConn();
        const custId = matchIdToHex(newMatchId());
        const intent = await requestWagerIntent({ matchID: custId, playerID: '0', amount: wager.amount });
        await depositCustodialWager({ connection: conn, wallet: phantom, intent });
        wager = { kind: 'master', amount: wager.amount, onchainId: custId, mode: 'custodial' };
      }
      await upsertProfileApi(myName);
      const colors: Array<Color | null> = ['0', '1'].map(s =>
        s === seatChoice ? (useCustom ? null : myColor) : null
      ) as Array<Color | null>;
      const decks: Array<string[] | null> = ['0', '1'].map(s =>
        s === seatChoice && useCustom ? myDeck : null
      ) as Array<string[] | null>;
      const trimmedName = matchName.trim().slice(0, 40) || `${myName} vs ${target_p.name}`;
      const created = await lobby.createMatch(GAME_NAME, {
        numPlayers: 2,
        setupData: {
          colors, names: ['Player 0', 'Player 1'], decks, wager,
          matchName: trimmedName,
          // Mark the match private so only host + invitee see it in the lobby.
          privateTo: target_p.name,
          hostName: myName,
        },
      });
      const joined = await lobby.joinMatch(GAME_NAME, created.matchID, {
        playerID: seatChoice, playerName: myName,
      });
      try { sessionStorage.removeItem('pendingPickColor'); } catch {}
      try { sessionStorage.removeItem('pendingCustomDeck'); } catch {}
      // Post the challenge AFTER the match exists so the recipient can act on it immediately.
      await createChallengeApi({
        fromName: myName, toName: target_p.name, matchId: created.matchID,
        wagerKind: wager?.kind ?? 'free',
        wagerAmount: wager?.kind === 'master' ? wager.amount : null,
        message: challengeMsg.trim() ? challengeMsg.trim().slice(0, 200) : null,
      });
      // Refresh outgoing list immediately so the UI updates without waiting for the next poll.
      try { setOutgoingChallenges(await listOutgoingChallengesApi(myName)); } catch {}
      setChallengeTarget(''); setChallengeMsg('');
      // Drop the challenger straight into the waiting room.
      onJoined({ matchID: created.matchID, playerID: seatChoice, credentials: joined.playerCredentials, playerName: myName });
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setChallengeBusy(false);
    }
  }

  /** Recipient accepts an incoming challenge — find the match in the lobby and route into the join flow. */
  async function acceptChallenge(ch: Challenge) {
    setError('');
    try {
      await respondChallengeApi(ch.id, 'accept', myName);
      // Optimistically remove from incoming list.
      setIncomingChallenges(prev => prev.filter(x => x.id !== ch.id));
      // Pull a fresh match list so we can find the private match we were invited to.
      const list = await lobby.listMatches(GAME_NAME);
      const match = (list.matches as any[]).find(m => m.matchID === ch.matchId);
      if (!match) {
        setError('The challenger\'s match is no longer open. They may have cancelled.');
        return;
      }
      openJoin(match);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  }
  async function declineChallenge(ch: Challenge) {
    try {
      await respondChallengeApi(ch.id, 'decline', myName);
      setIncomingChallenges(prev => prev.filter(x => x.id !== ch.id));
    } catch (e: any) { setError(String(e?.message ?? e)); }
  }
  async function cancelOutgoing(ch: Challenge) {
    try {
      await respondChallengeApi(ch.id, 'cancel', myName);
      setOutgoingChallenges(prev => prev.filter(x => x.id !== ch.id));
    } catch (e: any) { setError(String(e?.message ?? e)); }
  }

  function openJoin(m: any) {
    // If we already have a saved seat for this match (e.g. tab closed + reopened),
    // just rejoin directly using the stored credentials — do NOT pick a new open
    // seat (which would be the wrong one and could clobber another player).
    const existing = local.get<Seat | null>('seat', null);
    if (existing && existing.matchID === m.matchID) {
      onJoined(existing);
      return;
    }
    // If our name is already claimed in this match but we don't have credentials,
    // that means another tab still has the seat. Refuse rather than trying to
    // grab the opponent's slot.
    if ((m.players as Array<{ name?: string }>).some(p => p.name === myName)) {
      setError('You are already in this match in another tab. Close that tab or use it to play.');
      return;
    }
    // Confirm wagered matches BEFORE opening the deck-pick modal so the joiner
    // is never surprised by stakes mid-flow.
    const w = readWager(m.setupData);
    if (w.kind === 'master') {
      const ok = window.confirm(
        `This is a WAGERED match.\n\nStakes: ${w.amount} $MASTER — winner takes 90% of the pot (10% burned).\n\n` +
        `By continuing you will be prompted by Phantom to deposit ${w.amount} $MASTER into escrow. Continue?`
      );
      if (!ok) return;
    }
    const openSeat = (m.players as Array<{ id: number; name?: string }>).find(p => !p.name);
    if (!openSeat) { setError('No open seat'); return; }
    // Default the join-color to something different from the creator's color if known.
    const creatorColor = (m.setupData?.colors ?? []).find((c: any) => !!c) as Color | undefined;
    if (creatorColor && creatorColor === joinColor) {
      const fallback = COLOR_ORDER.find(c => c !== creatorColor)!;
      setJoinColor(fallback);
    }
    setJoinUseCustom(false);
    setJoinTarget({ match: m, seat: String(openSeat.id) });
  }

  async function confirmJoin() {
    if (!joinTarget) return;
    setError('');
    const { match: m, seat: pid } = joinTarget;
    try {
      if (joinUseCustom && !validateDeck(joinDeck).ok) {
        setError(`Custom deck must be exactly ${DECK_SIZE} cards. Build it in Profile → Custom Deck.`);
        return;
      }
      await upsertProfileApi(myName);
      // For $MASTER wagers, deposit BEFORE joining the BG.io match so we
      // never "join" a match we haven't actually backed.
      const w = readWager(m.setupData);
      if (w.kind === 'master') {
        if (!w.onchainId) {
          setError('This wagered match was created without an escrow id; cannot join.');
          return;
        }
        console.log('[join] picking wallet…');
        const kind = await pickSolanaWallet();
        console.log('[join] wallet kind selected =', kind);
        let phantom: any;
        try {
          phantom = await Promise.race([
            getSolanaWallet(kind),
            new Promise((_, rej) => setTimeout(() => rej(new Error(
              `${kind} did not respond to connect within 20s — extension is likely asleep or this page lost its provider bridge. Reload the page and try again.`
            )), 20_000)),
          ]);
        } catch (err: any) {
          console.error('[join] getSolanaWallet failed:', err);
          throw err;
        }
        console.log('[join] wallet connected, publicKey =', phantom?.publicKey?.toBase58?.() ?? '<none>');
        const conn = solConn();
        console.log('[join] requesting wager intent', { matchID: w.onchainId, amount: w.amount });
        const intent = await requestWagerIntent({ matchID: w.onchainId, playerID: '1', amount: w.amount ?? 0 });
        console.log('[join] intent ok, depositing…');
        await depositCustodialWager({ connection: conn, wallet: phantom, intent });
        console.log('[join] deposit confirmed');
      }
      // Stash the joiner's choice; Board.tsx will auto-call chooseColor on mount.
      try {
        if (joinUseCustom) {
          sessionStorage.setItem('pendingCustomDeck', JSON.stringify(joinDeck));
          sessionStorage.removeItem('pendingPickColor');
        } else {
          sessionStorage.setItem('pendingPickColor', joinColor);
          sessionStorage.removeItem('pendingCustomDeck');
        }
      } catch {}
      const joined = await lobby.joinMatch(GAME_NAME, m.matchID, { playerID: pid, playerName: myName });
      setJoinTarget(null);
      onJoined({ matchID: m.matchID, playerID: pid, credentials: joined.playerCredentials, playerName: myName });
    } catch (e: any) {
      console.error('[join] confirmJoin failed:', e);
      setError(String(e?.message ?? e));
    }
  }

  // Split available matches between the two side panels of the art frame.
  // Hide private (challenge) matches from anyone who isn't the host or the invited player.
  const openMatches = matches.filter(m => {
    if (!(m.players as Array<{ name?: string }>).some(p => !p.name)) return false;
    const sd: any = m.setupData ?? {};
    if (sd.privateTo) {
      const myKey = myName.trim().toLowerCase();
      const allowed = String(sd.privateTo).trim().toLowerCase();
      const host    = String(sd.hostName ?? '').trim().toLowerCase();
      if (myKey !== allowed && myKey !== host) return false;
    }
    return true;
  });

  // Stats for footer bar
  const inProgressCount = matches.filter(m => (m.players as Array<{ name?: string }>).every(p => p.name)).length;
  const myGames = myProfile ? myProfile.wins + myProfile.losses + myProfile.draws : 0;
  const myWinPct = myGames ? Math.round((myProfile!.wins / myGames) * 100) : 0;
  const myLevel = Math.max(1, Math.floor(Math.sqrt((myGames + 1) * 2.2)));

  // Activity feed — synthesized from matches + leaderboard so the lobby feels alive.
  const activity = useMemo(() => buildActivityFeed(matches, leaderboard), [matches, leaderboard]);

  return (
    <div style={{
      position: 'relative', minHeight: '100vh', color: '#e9eef7',
      fontFamily: PROFILE_FONT,
      backgroundImage: 'url(/lobby-bg.png?v=2)',
      backgroundSize: 'cover', backgroundPosition: 'center', backgroundAttachment: 'fixed',
    }}>
      {/* Dark overlay so the UI floats above the scene */}
      <div aria-hidden style={{
        position: 'fixed', inset: 0, zIndex: 0,
        background: 'linear-gradient(180deg, rgba(7,9,15,0.78) 0%, rgba(7,9,15,0.55) 50%, rgba(7,9,15,0.88) 100%)',
        pointerEvents: 'none',
      }} />
      {/* All content lives above the overlay */}
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <LobbyTopBar
          profile={myProfile} myName={myName}
          level={myLevel} winPct={myWinPct} wins={myProfile?.wins ?? 0} losses={myProfile?.losses ?? 0}
          onBack={onBack}
        />

        {/* Floating button to open the WorkAdventure-style Memetic Plaza overlay. */}
        <button
          onClick={() => window.open('https://play.workadventu.re/@/asdasd-1775062076/asdasd/memetic-masters-hq', '_blank', 'noopener,noreferrer')}
          title="Enter Memetic Masters HQ on WorkAdventure"
          style={{
            position: 'fixed', right: 16, top: 16, zIndex: 50,
            background: 'linear-gradient(135deg,#3a1f5a,#1b1230)',
            color: '#fff', border: '1px solid #6c4bd8', borderRadius: 8,
            padding: '8px 14px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
            boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
          }}
        >🏛️ Enter Plaza</button>

        {/* VS BOT — single-player launcher lives here now (was a separate landing button). */}
        <button
          onClick={onSolo}
          title="Play a single-player match against the bot"
          style={{
            position: 'fixed', right: 16, top: 60, zIndex: 50,
            background: 'linear-gradient(135deg,#1f3a5a,#12203a)',
            color: '#fff', border: '1px solid #4b8ad8', borderRadius: 8,
            padding: '8px 14px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
            boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
          }}
        >🤖 VS Bot</button>

        {plazaOpen && (
          <Plaza
            matches={matches}
            myName={myName}
            onClose={() => setPlazaOpen(false)}
            onJoinMatch={(m) => { setPlazaOpen(false); openJoin(m); }}
          />
        )}

        {error && (
          <div style={{ maxWidth: 1480, margin: '12px auto 0', padding: '0 22px', width: '100%' }}>
            <div style={{
              padding: '10px 14px', borderRadius: 10,
              background: 'rgba(255,107,107,0.10)', border: '1px solid rgba(255,107,107,0.45)',
              color: '#ffb4b4', fontSize: 13,
            }}>{error}</div>
          </div>
        )}

        {incomingChallenges.length > 0 && (
          <div style={{ maxWidth: 1480, margin: '12px auto 0', padding: '0 22px', width: '100%' }}>
            <IncomingChallengesBanner
              challenges={incomingChallenges}
              onAccept={acceptChallenge}
              onDecline={declineChallenge}
            />
          </div>
        )}

        {walletPicker && (
          <SolanaWalletPicker
            onPick={k => { walletPicker.resolve(k); setWalletPicker(null); }}
            onCancel={() => { walletPicker.reject(new Error('Wallet selection canceled.')); setWalletPicker(null); }}
          />
        )}

        <div style={{
          flex: 1, width: '100%', maxWidth: 1480, margin: '0 auto',
          padding: mobile ? '14px' : '22px 22px 100px',
          display: 'grid', gap: mobile ? 14 : 18,
          gridTemplateColumns: mobile ? '1fr' : 'minmax(280px, 340px) minmax(0, 1fr) minmax(280px, 340px)',
        }}>
          <OpenMatchesPanel
            matches={openMatches} loading={loading}
            onRefresh={refresh} onJoin={openJoin}
          />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
            {/* Center action tabs — one dominant action at a time (Quick Match default). */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {([
                { k: 'quick',     icon: '⚔️', label: 'Quick Match' },
                { k: 'create',    icon: '➕', label: 'Create Match' },
                { k: 'challenge', icon: '🎯', label: 'Challenge' },
              ] as const).map(t => {
                const active = centerTab === t.k;
                const gold = t.k === 'quick';
                return (
                  <button key={t.k} onClick={() => { setCenterTab(t.k); setError(''); }} style={{
                    padding: '12px 8px', borderRadius: 12, cursor: 'pointer', textAlign: 'center',
                    fontFamily: PROFILE_FONT, fontWeight: 800, fontSize: 13, letterSpacing: 0.3,
                    background: active
                      ? (gold ? 'linear-gradient(180deg,#f0d27a,#c69533)' : 'rgba(143,92,255,0.22)')
                      : 'rgba(10,15,25,0.72)',
                    color: active ? (gold ? '#1a1408' : '#e6d4ff') : LOBBY_TOKENS.muted,
                    border: `1px solid ${active ? (gold ? '#8a6d24' : 'rgba(143,92,255,0.6)') : LOBBY_TOKENS.border}`,
                    boxShadow: active ? (gold ? '0 6px 18px -6px #d9b85f88' : '0 0 20px rgba(143,92,255,0.35)') : 'none',
                    transition: 'all .15s ease', backdropFilter: 'blur(10px)',
                  }}>
                    <div style={{ fontSize: 18 }}>{t.icon}</div>
                    <div style={{ marginTop: 4 }}>{t.label}</div>
                  </button>
                );
              })}
            </div>

            {centerTab === 'quick' && (
              <RankedQueuePanel
                myName={myName}
                decks={myDecks}
                selectedDeckId={mySelectedDeckId}
                setSelectedDeckId={setMySelectedDeckId}
                selectedDeckCards={myDeck}
                deckOk={myDeckOk}
                onJoined={onJoined}
                setError={setError}
              />
            )}
            {centerTab === 'create' && (
              <CreateMatchPanel
                myColor={myColor} setMyColor={setMyColor}
                useCustom={useCustom} setUseCustom={setUseCustom}
                myDeck={myDeck} myDeckOk={myDeckOk}
                myDecks={myDecks} selectedDeckId={mySelectedDeckId} onSelectDeck={setMySelectedDeckId}
                seatChoice={seatChoice} setSeatChoice={setSeatChoice}
                matchName={matchName} setMatchName={setMatchName}
                wagerKind={wagerKind} setWagerKind={setWagerKind}
                wagerAmount={wagerAmount} setWagerAmount={setWagerAmount}
                onCreate={createAndJoin}
              />
            )}
            {centerTab === 'challenge' && (
              <ChallengePanel
                target={challengeTarget} setTarget={setChallengeTarget}
                message={challengeMsg} setMessage={setChallengeMsg}
                busy={challengeBusy} onSend={sendChallenge}
                outgoing={outgoingChallenges} onCancel={cancelOutgoing}
                wagerKind={wagerKind} wagerAmount={wagerAmount}
              />
            )}
          </div>

          <CommunityPanel
            leaderboard={leaderboard}
            onViewProfile={onViewProfile}
            activity={activity}
          />
        </div>

        <FooterStatsBar
          playersOnline={leaderboard.length}
          openMatches={openMatches.length}
          inProgress={inProgressCount}
          onBack={onBack}
        />
      </div>

      {joinTarget && (
        <div onClick={() => setJoinTarget(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(6px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: 'linear-gradient(180deg, #131826, #0a1020)',
            border: '1px solid rgba(217,184,95,0.45)',
            borderRadius: 14,
            padding: 22, width: 'min(560px, calc(100vw - 24px))',
            maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', color: '#e9eef7',
            boxShadow: '0 30px 80px #000c',
          }}>
            <h2 style={{ margin: '0 0 6px', fontSize: 22, fontFamily: '"Cinzel", serif', letterSpacing: 1, color: '#d9b85f' }}>Accept Match</h2>
            <p style={{ color: '#9faabf', marginTop: 0, fontSize: 13 }}>
              You're joining as <b style={{ color: '#fff' }}>P{joinTarget.seat}</b>. Pick the deck you want to play with.
            </p>
            {(() => {
              const mName = readMatchName(joinTarget.match.setupData);
              if (!mName) return null;
              return (
                <div style={{
                  fontSize: 13, marginBottom: 10, padding: '6px 10px',
                  background: 'rgba(217,184,95,0.10)', border: '1px solid rgba(217,184,95,0.45)',
                  borderRadius: 6, color: '#ffd66e', fontWeight: 700,
                }}>Match: <span style={{ color: '#fff' }}>{mName}</span></div>
              );
            })()}
            {(() => {
              const otherSeat = joinTarget.seat === '0' ? '1' : '0';
              const oppCol = (joinTarget.match.setupData?.colors ?? [])[Number(otherSeat)] as Color | null | undefined;
              return oppCol ? (
                <div style={{ fontSize: 13, color: '#bbb', marginBottom: 12 }}>
                  Opponent is playing <span style={{ color: COLOR_META[oppCol].hex, fontWeight: 700 }}>{COLOR_META[oppCol].name}</span>.
                </div>
              ) : null;
            })()}
            {(() => {
              const w = readWager(joinTarget.match.setupData);
              if (w.kind === 'free') {
                return <div style={{
                  fontSize: 12, marginBottom: 12, padding: '6px 10px',
                  background: 'rgba(217,184,95,0.10)', border: '1px solid rgba(217,184,95,0.45)',
                  borderRadius: 6, color: '#d9c98e', fontWeight: 700, letterSpacing: 0.5,
                }}>Stakes: FREE MATCH</div>;
              }
              return <div style={{
                fontSize: 13, marginBottom: 12, padding: '8px 10px',
                background: 'rgba(143,92,255,0.14)', border: '1px solid rgba(143,92,255,0.55)',
                borderRadius: 6, color: '#e6d4ff',
              }}>
                <div style={{ fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', fontSize: 11, color: '#c8a3ff' }}>Wagered Match</div>
                <div style={{ marginTop: 2 }}>Accepting will agree to a <b style={{ color: '#fff' }}>{w.amount} $MASTER</b> wager — winner takes the pot.</div>
              </div>;
            })()}
            <ColorChooser label="Your chain" value={joinColor} onChange={(c) => { setJoinUseCustom(false); setJoinColor(c); }} />
            {validateDeck(joinDeck).ok && (
              <div style={{ marginTop: 10 }}>
                <button onClick={() => setJoinUseCustom(v => !v)} style={{
                  width: '100%', padding: '8px 12px', fontWeight: 800, fontSize: 13,
                  background: joinUseCustom ? 'linear-gradient(90deg,#7aa7ff,#5b6df5)' : 'rgba(10,12,20,0.78)',
                  color: joinUseCustom ? '#0a0a18' : '#e9e4d0',
                  border: `2px dashed ${joinUseCustom ? '#d9b85f' : 'rgba(120,170,255,0.45)'}`,
                  borderRadius: 6, cursor: 'pointer',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <span>🛠️ Use Custom Deck</span>
                  <span style={{ fontSize: 10, opacity: 0.85 }}>{joinUseCustom ? 'ON' : 'OFF'}</span>
                </button>
                {joinUseCustom && myDecks.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <DeckPicker decks={myDecks} selectedId={joinSelectedDeckId} onSelect={setJoinSelectedDeckId} />
                  </div>
                )}
              </div>
            )}
            <div style={{ marginTop: 18, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setJoinTarget(null)} style={LOBBY_GHOST_BTN}>Cancel</button>
              <button onClick={confirmJoin} style={LOBBY_GOLD_BTN}>Accept &amp; enter match</button>
            </div>
            {error && (
              <div style={{
                marginTop: 12, padding: '8px 10px', borderRadius: 6,
                background: 'rgba(217,75,75,0.14)', border: '1px solid rgba(217,75,75,0.55)',
                color: '#ffb8b8', fontSize: 12, whiteSpace: 'pre-wrap',
              }}>{error}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LOBBY DESIGN TOKENS + REUSABLE BUTTONS
// ─────────────────────────────────────────────────────────────────────────────
const LOBBY_TOKENS = {
  bg:       '#07090f',
  panel:    'rgba(10,15,25,0.72)',
  panelHi:  'rgba(16,22,38,0.82)',
  border:   'rgba(255,255,255,0.08)',
  borderHi: 'rgba(217,184,95,0.45)',
  gold:     '#d9b85f',
  purple:   '#8f5cff',
  green:    '#00d18f',
  danger:   '#ff6b6b',
  muted:    '#9faabf',
  text:     '#e9eef7',
};

const LOBBY_GLASS: React.CSSProperties = {
  background: LOBBY_TOKENS.panel,
  border: `1px solid ${LOBBY_TOKENS.border}`,
  borderRadius: 14,
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  boxShadow: '0 22px 60px -28px rgba(0,0,0,0.8)',
};

const LOBBY_GOLD_BTN: React.CSSProperties = {
  padding: '10px 18px',
  background: 'linear-gradient(180deg, #f0d27a, #c69533)',
  color: '#1a1408', border: '1px solid #8a6d24',
  borderRadius: 10, cursor: 'pointer',
  fontWeight: 800, letterSpacing: 0.5, fontSize: 13,
  fontFamily: PROFILE_FONT,
  boxShadow: '0 6px 18px -6px #d9b85f88',
  transition: '200ms ease',
};

const LOBBY_GHOST_BTN: React.CSSProperties = {
  padding: '8px 14px',
  background: 'rgba(255,255,255,0.04)',
  color: LOBBY_TOKENS.text, border: `1px solid ${LOBBY_TOKENS.border}`,
  borderRadius: 10, cursor: 'pointer',
  fontWeight: 600, fontSize: 13, fontFamily: PROFILE_FONT,
  transition: '200ms ease',
};

// ─────────────────────────────────────────────────────────────────────────────
// TOP BAR — profile card + nav
// ─────────────────────────────────────────────────────────────────────────────
function LobbyTopBar({ profile, myName, level, winPct, wins, losses, onBack }: {
  profile: Profile | null; myName: string;
  level: number; winPct: number; wins: number; losses: number;
  onBack: () => void;
}) {
  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 20,
      padding: '12px 22px',
      background: 'linear-gradient(180deg, rgba(7,9,15,0.92), rgba(7,9,15,0.55))',
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      borderBottom: `1px solid ${LOBBY_TOKENS.border}`,
    }}>
      <div style={{
        maxWidth: 1480, margin: '0 auto',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap',
      }}>
        {/* Profile cluster */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
          <div style={{ position: 'relative' }}>
            <AvatarFramed
              src={profile?.avatarUrl ?? null}
              name={myName}
              glow={winPct >= 50 ? LOBBY_TOKENS.green : LOBBY_TOKENS.purple}
              size={56}
            />
            <span aria-hidden style={{
              position: 'absolute', bottom: 0, right: 0,
              width: 14, height: 14, borderRadius: '50%',
              background: LOBBY_TOKENS.green, border: '2px solid #07090f',
              boxShadow: `0 0 8px ${LOBBY_TOKENS.green}`,
            }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontFamily: '"Cinzel", serif', fontSize: 20, fontWeight: 800, color: '#fff',
              letterSpacing: 1, textShadow: '0 2px 8px #000',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280,
            }}>{myName}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 11, color: LOBBY_TOKENS.muted, marginTop: 2 }}>
              <span><b style={{ color: LOBBY_TOKENS.gold }}>Level {level}</b></span>
              <span style={{ color: winPct >= 50 ? LOBBY_TOKENS.green : LOBBY_TOKENS.danger, fontWeight: 700 }}>{winPct}% WR</span>
              <span><b style={{ color: LOBBY_TOKENS.green }}>{wins}W</b> · <b style={{ color: LOBBY_TOKENS.danger }}>{losses}L</b></span>
            </div>
          </div>
        </div>
        {/* Title + nav */}
        <div style={{
          fontFamily: '"Cinzel", serif', fontSize: 14, color: LOBBY_TOKENS.gold,
          letterSpacing: 4, textTransform: 'uppercase', fontWeight: 700,
        }}>⚔ Matchmaking Lobby</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onBack} style={LOBBY_GHOST_BTN}>← Home</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OPEN MATCHES PANEL (left column)
// ─────────────────────────────────────────────────────────────────────────────
function OpenMatchesPanel({ matches, loading, onRefresh, onJoin }: {
  matches: any[]; loading: boolean;
  onRefresh: () => void; onJoin: (m: any) => void;
}) {
  return (
    <section style={{ ...LOBBY_GLASS, display: 'flex', flexDirection: 'column', maxHeight: '78vh', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 18px',
        borderBottom: `1px solid ${LOBBY_TOKENS.border}`,
      }}>
        <div>
          <div style={{ fontSize: 10, color: LOBBY_TOKENS.gold, letterSpacing: 2, fontWeight: 700, textTransform: 'uppercase' }}>Live</div>
          <div style={{ fontFamily: '"Cinzel", serif', fontSize: 18, fontWeight: 800, color: '#fff', letterSpacing: 1 }}>
            Open Matches <span style={{ color: LOBBY_TOKENS.muted, fontSize: 12, fontFamily: PROFILE_FONT }}>· {matches.length}</span>
          </div>
        </div>
        <button onClick={onRefresh} disabled={loading} style={{
          ...LOBBY_GHOST_BTN, padding: '6px 10px', fontSize: 12,
          opacity: loading ? 0.5 : 1,
        }} title="Refresh">{loading ? '…' : '↻'}</button>
      </div>
      <div style={{ overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {matches.length === 0 ? (
          <EmptyMatchesState />
        ) : matches.map(m => (
          <MatchCard key={m.matchID} m={m} onJoin={() => onJoin(m)} />
        ))}
      </div>
    </section>
  );
}

function EmptyMatchesState() {
  return (
    <div style={{
      padding: '32px 16px', textAlign: 'center',
      border: `1px dashed ${LOBBY_TOKENS.border}`, borderRadius: 12,
      background: 'rgba(255,255,255,0.02)',
    }}>
      <div style={{ fontSize: 48, opacity: 0.5, marginBottom: 8 }}>🏰</div>
      <div style={{ fontFamily: '"Cinzel", serif', fontSize: 15, color: '#fff', fontWeight: 700, letterSpacing: 1 }}>No Open Matches</div>
      <div style={{ fontSize: 12, color: LOBBY_TOKENS.muted, marginTop: 6, lineHeight: 1.5 }}>
        Create the first match and challenge<br/>other players to a duel.
      </div>
    </div>
  );
}

function MatchCard({ m, onJoin }: { m: any; onJoin: () => void }) {
  const players = (m.players as Array<{ id: number; name?: string }>);
  const filled = players.filter(p => p.name).length;
  const colors = (m.setupData?.colors ?? [null, null]) as Array<Color | null>;
  const creator = players.find(p => p.name);
  const creatorCol = creator ? colors[creator.id] : null;
  const meta = creatorCol ? COLOR_META[creatorCol] : null;
  const inProgress = filled === players.length;
  const w = readWager(m.setupData);
  const mName = readMatchName(m.setupData);
  const createdAt = (m as any).createdAt ?? (m as any).updatedAt ?? Date.now();
  const waitMin = Math.max(0, Math.round((Date.now() - createdAt) / 60000));
  return (
    <div
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = LOBBY_TOKENS.borderHi; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.borderColor = LOBBY_TOKENS.border; }}
      style={{
        position: 'relative', overflow: 'hidden',
        flex: '0 0 auto',
        background: `linear-gradient(180deg, rgba(16,22,38,0.85), rgba(8,12,22,0.85))`,
        border: `1px solid ${LOBBY_TOKENS.border}`,
        borderRadius: 12,
        padding: '12px 14px',
        transition: 'all 200ms ease',
      }}>
      {/* Chain-color accent stripe */}
      {meta && (
        <div aria-hidden style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 4,
          background: meta.hex, boxShadow: `0 0 12px ${meta.hex}88`,
        }} />
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 15, fontWeight: 800, color: '#fff', lineHeight: 1.2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{creator?.name ?? 'Open Seat'}</div>
          <div style={{ fontSize: 11, color: LOBBY_TOKENS.muted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {mName ?? `Match ${m.matchID.slice(0, 6)}`}
          </div>
        </div>
        {meta && (
          <span style={{
            padding: '3px 9px', borderRadius: 999, fontSize: 10, fontWeight: 800,
            background: `${meta.hex}26`, color: meta.hex, border: `1px solid ${meta.hex}66`,
            letterSpacing: 1, textTransform: 'uppercase', flex: '0 0 auto',
          }}>{meta.name}</span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        <span style={{
          padding: '3px 8px', borderRadius: 6, fontSize: 10, fontWeight: 800,
          background: w.kind === 'master' ? 'rgba(143,92,255,0.18)' : 'rgba(217,184,95,0.12)',
          color: w.kind === 'master' ? '#c8a3ff' : '#d9c98e',
          border: `1px solid ${w.kind === 'master' ? 'rgba(143,92,255,0.55)' : 'rgba(217,184,95,0.45)'}`,
          letterSpacing: 0.5, textTransform: 'uppercase',
        }}>{wagerLabel(w)}</span>
        <span style={{ fontSize: 11, color: LOBBY_TOKENS.muted }}>
          {filled}/{players.length} · {waitMin > 0 ? `${waitMin}m waiting` : 'just now'}
        </span>
      </div>
      <button onClick={onJoin} disabled={inProgress}
        onMouseEnter={e => { if (!inProgress) e.currentTarget.style.transform = 'scale(1.02)'; }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
        style={{
          marginTop: 10, width: '100%', padding: '8px 0',
          background: inProgress ? 'rgba(40,44,56,0.6)' : 'linear-gradient(180deg, #f0d27a, #c69533)',
          color: inProgress ? '#6c7283' : '#1a1408',
          border: `1px solid ${inProgress ? LOBBY_TOKENS.border : '#8a6d24'}`,
          borderRadius: 8, fontSize: 12, fontWeight: 800, letterSpacing: 1,
          cursor: inProgress ? 'not-allowed' : 'pointer',
          transition: '200ms ease',
          boxShadow: inProgress ? 'none' : '0 4px 12px -4px #d9b85f66',
        }}>{inProgress ? 'IN PROGRESS' : 'JOIN MATCH →'}</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE MATCH PANEL (center column)
// ─────────────────────────────────────────────────────────────────────────────
function CreateMatchPanel(props: {
  myColor: Color; setMyColor: (c: Color) => void;
  useCustom: boolean; setUseCustom: (b: boolean | ((p: boolean) => boolean)) => void;
  myDeck: string[]; myDeckOk: boolean;
  myDecks: DeckEntry[]; selectedDeckId: number | null; onSelectDeck: (id: number) => void;
  seatChoice: '0' | '1'; setSeatChoice: (s: '0' | '1') => void;
  matchName: string; setMatchName: (s: string) => void;
  wagerKind: 'free' | 'master'; setWagerKind: (k: 'free' | 'master') => void;
  wagerAmount: string; setWagerAmount: (s: string) => void;
  onCreate: () => void;
}) {
  const { myColor, setMyColor, useCustom, setUseCustom, myDeck, myDeckOk,
          myDecks, selectedDeckId, onSelectDeck,
          seatChoice, setSeatChoice, matchName, setMatchName,
          wagerKind, setWagerKind, wagerAmount, setWagerAmount, onCreate } = props;
  const [isPrivate, setIsPrivate] = useState(false);
  return (
    <section style={{ ...LOBBY_GLASS, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '14px 20px 6px', borderBottom: `1px solid ${LOBBY_TOKENS.border}` }}>
        <div style={{ fontSize: 10, color: LOBBY_TOKENS.gold, letterSpacing: 2, fontWeight: 700, textTransform: 'uppercase' }}>Forge a Duel</div>
        <div style={{ fontFamily: '"Cinzel", serif', fontSize: 22, fontWeight: 800, color: '#fff', letterSpacing: 1 }}>Create Match</div>
      </div>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 22 }}>
        {/* Step 1 — Chain selector */}
        <CreateStep n={1} title="Choose Your Deck">
          <ChainSelector
            selected={!useCustom ? myColor : null}
            useCustom={useCustom}
            canCustom={myDeckOk}
            onPickColor={c => { setUseCustom(false); setMyColor(c); }}
            onPickCustom={() => setUseCustom(true)}
          />
          {useCustom && myDecks.length > 0 && (
            <DeckPicker decks={myDecks} selectedId={selectedDeckId} onSelect={onSelectDeck} />
          )}
          <DeckPreview color={useCustom ? null : myColor} useCustom={useCustom} myDeck={myDeck} />
        </CreateStep>

        {/* Step 2 — Match type */}
        <CreateStep n={2} title="Match Type">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <SegBtn active={wagerKind === 'free'} onClick={() => setWagerKind('free')}>🎮 Casual</SegBtn>
            <SegBtn active={false} disabled title="Use the dedicated Ranked Hub">🏆 Ranked</SegBtn>
            <SegBtn active={false} disabled title="Coming soon">🥇 Tournament</SegBtn>
            <SegBtn active={wagerKind === 'master'} onClick={() => setWagerKind('master')}>💎 Wager</SegBtn>
          </div>
          {wagerKind === 'master' && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 10, color: LOBBY_TOKENS.muted, letterSpacing: 1.5, fontWeight: 700, marginBottom: 4 }}>STAKE ($MASTER)</div>
              <input
                type="number" min={1} value={wagerAmount}
                onChange={e => setWagerAmount(e.target.value)}
                style={{
                  width: '100%', padding: '10px 12px',
                  background: '#0a0f1c', color: '#fff',
                  border: `1px solid ${LOBBY_TOKENS.borderHi}`,
                  borderRadius: 8, fontSize: 14, fontWeight: 700, fontFamily: PROFILE_FONT,
                }}
              />
            </div>
          )}
        </CreateStep>

        {/* Step 3 — Settings */}
        <CreateStep n={3} title="Settings">
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            <div>
              <div style={{ fontSize: 10, color: LOBBY_TOKENS.muted, letterSpacing: 1.5, fontWeight: 700, marginBottom: 4 }}>MATCH NAME</div>
              <input
                type="text" value={matchName}
                onChange={e => setMatchName(e.target.value.slice(0, 40))}
                placeholder="Optional…"
                maxLength={40}
                style={{
                  width: '100%', padding: '8px 12px',
                  background: '#0a0f1c', color: '#fff',
                  border: `1px solid ${LOBBY_TOKENS.border}`,
                  borderRadius: 8, fontSize: 13, fontFamily: PROFILE_FONT,
                }}
              />
            </div>
            <div>
              <div style={{ fontSize: 10, color: LOBBY_TOKENS.muted, letterSpacing: 1.5, fontWeight: 700, marginBottom: 4 }}>SEAT</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['0','1'] as const).map(s => (
                  <button key={s} onClick={() => setSeatChoice(s)} style={{
                    flex: 1, padding: '8px 0',
                    background: seatChoice === s ? `linear-gradient(180deg, ${LOBBY_TOKENS.gold}, #b78827)` : 'rgba(255,255,255,0.04)',
                    color: seatChoice === s ? '#1a1408' : LOBBY_TOKENS.text,
                    border: `1px solid ${seatChoice === s ? '#8a6d24' : LOBBY_TOKENS.border}`,
                    borderRadius: 8, fontWeight: 800, fontSize: 12, cursor: 'pointer',
                    fontFamily: PROFILE_FONT, letterSpacing: 0.5,
                  }}>P{s}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: LOBBY_TOKENS.muted, letterSpacing: 1.5, fontWeight: 700, marginBottom: 4 }}>VISIBILITY</div>
              <button onClick={() => setIsPrivate(p => !p)} title="Public matches show in everyone's Open Matches list"
                style={{
                  width: '100%', padding: '8px 12px',
                  background: 'rgba(255,255,255,0.04)',
                  color: LOBBY_TOKENS.text,
                  border: `1px solid ${LOBBY_TOKENS.border}`,
                  borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: 'pointer',
                  fontFamily: PROFILE_FONT,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                <span>{isPrivate ? '🔒 Private' : '🌐 Public'}</span>
                <span style={{ fontSize: 10, opacity: 0.7 }}>{isPrivate ? 'invite-only' : 'all players'}</span>
              </button>
            </div>
          </div>
        </CreateStep>

        {/* Step 4 — CTA */}
        <button onClick={onCreate}
          onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.02)'; e.currentTarget.style.boxShadow = '0 12px 32px -6px rgba(217,184,95,0.65)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = '0 8px 22px -8px rgba(217,184,95,0.55)'; }}
          style={{
            width: '100%', padding: '16px 0',
            background: 'linear-gradient(180deg, #f5d77a, #c8932a 60%, #a07418)',
            color: '#1a1408', border: '1px solid #8a6d24',
            borderRadius: 12, cursor: 'pointer',
            fontFamily: '"Cinzel", serif',
            fontWeight: 900, fontSize: 18, letterSpacing: 3, textTransform: 'uppercase',
            boxShadow: '0 8px 22px -8px rgba(217,184,95,0.55)',
            transition: '180ms ease',
            animation: 'lobbyCtaGlow 3.4s ease-in-out infinite',
          }}>⚔ Create Match</button>
        <style>{`@keyframes lobbyCtaGlow{0%,100%{filter:drop-shadow(0 0 0px #d9b85f00)}50%{filter:drop-shadow(0 0 14px #d9b85f88)}}`}</style>
      </div>
    </section>
  );
}

function CreateStep({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 24, height: 24, borderRadius: '50%',
          background: `linear-gradient(180deg, ${LOBBY_TOKENS.gold}, #b78827)`,
          color: '#1a1408', fontWeight: 900, fontSize: 12,
          boxShadow: `0 0 10px ${LOBBY_TOKENS.gold}66`,
        }}>{n}</span>
        <span style={{ fontFamily: '"Cinzel", serif', fontSize: 16, fontWeight: 700, color: '#fff', letterSpacing: 1 }}>{title}</span>
        <span style={{ flex: 1, height: 1, background: `linear-gradient(90deg, ${LOBBY_TOKENS.border}, transparent)` }} />
      </div>
      {children}
    </div>
  );
}

function DeckPicker({ decks, selectedId, onSelect }: {
  decks: DeckEntry[]; selectedId: number | null; onSelect: (id: number) => void;
}) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{
        fontSize: 10, color: LOBBY_TOKENS.muted, letterSpacing: 1.5,
        fontWeight: 700, marginBottom: 4, textTransform: 'uppercase',
      }}>Which deck?</div>
      <select
        value={selectedId ?? ''}
        onChange={e => onSelect(Number(e.target.value))}
        style={{
          width: '100%', padding: '10px 12px',
          background: '#0a0f1c', color: '#fff',
          border: `1px solid ${LOBBY_TOKENS.borderHi}`,
          borderRadius: 8, fontSize: 13, fontWeight: 700,
          fontFamily: PROFILE_FONT, cursor: 'pointer',
        }}
      >
        {decks.map(d => (
          <option key={d.id} value={d.id}>
            {d.isActive ? '★ ' : ''}{d.name} ({d.cards.length} cards)
          </option>
        ))}
      </select>
    </div>
  );
}

function SegBtn({ active, disabled, onClick, title, children }: { active: boolean; disabled?: boolean; onClick?: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      style={{
        flex: '1 1 100px', padding: '10px 12px',
        background: active
          ? `linear-gradient(180deg, ${LOBBY_TOKENS.gold}, #b78827)`
          : 'rgba(255,255,255,0.04)',
        color: active ? '#1a1408' : (disabled ? '#5b6378' : LOBBY_TOKENS.text),
        border: `1px solid ${active ? '#8a6d24' : LOBBY_TOKENS.border}`,
        borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer',
        fontWeight: 800, fontSize: 13, letterSpacing: 0.5,
        fontFamily: PROFILE_FONT,
        opacity: disabled ? 0.5 : 1,
        transition: '180ms ease',
      }}>{children}</button>
  );
}

function ChainSelector({ selected, useCustom, canCustom, onPickColor, onPickCustom }: {
  selected: Color | null; useCustom: boolean; canCustom: boolean;
  onPickColor: (c: Color) => void; onPickCustom: () => void;
}) {
  return (
    <div style={{
      display: 'grid', gap: 8,
      gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
    }}>
      {COLORS.map(c => {
        const meta = COLOR_META[c];
        const isOn = !useCustom && selected === c;
        return (
          <button key={c} onClick={() => onPickColor(c)}
            onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; }}
            onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
            style={{
              padding: '12px 6px', cursor: 'pointer',
              background: isOn
                ? `radial-gradient(circle at 50% 0%, ${meta.hex}55, ${LOBBY_TOKENS.panelHi} 80%)`
                : LOBBY_TOKENS.panelHi,
              border: `2px solid ${isOn ? meta.hex : LOBBY_TOKENS.border}`,
              borderRadius: 10,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
              transition: '180ms ease',
              boxShadow: isOn ? `0 0 18px ${meta.hex}66, inset 0 0 12px ${meta.hex}22` : 'none',
              fontFamily: PROFILE_FONT,
            }}>
            <span style={{
              width: 30, height: 30, borderRadius: '50%',
              background: `radial-gradient(circle at 30% 30%, ${meta.hex}, #1a1a22 80%)`,
              border: `2px solid ${meta.hex}88`,
              boxShadow: `0 0 10px ${meta.hex}88`,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              color: meta.ink, fontWeight: 900, fontSize: 12,
            }}>{c.toUpperCase().slice(0,1)}</span>
            <span style={{ fontSize: 11, fontWeight: 800, color: isOn ? '#fff' : LOBBY_TOKENS.text, letterSpacing: 0.5 }}>{meta.name}</span>
            <span style={{ fontSize: 9, color: LOBBY_TOKENS.muted, letterSpacing: 1, textTransform: 'uppercase' }}>{c}</span>
          </button>
        );
      })}
      <button onClick={onPickCustom} disabled={!canCustom}
        title={canCustom ? 'Play your custom 60-card deck' : 'Build a custom deck in Profile first'}
        onMouseEnter={e => { if (canCustom) e.currentTarget.style.transform = 'translateY(-2px)'; }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
        style={{
          padding: '12px 6px', cursor: canCustom ? 'pointer' : 'not-allowed',
          background: useCustom
            ? `radial-gradient(circle at 50% 0%, ${LOBBY_TOKENS.purple}55, ${LOBBY_TOKENS.panelHi} 80%)`
            : LOBBY_TOKENS.panelHi,
          border: `2px dashed ${useCustom ? LOBBY_TOKENS.purple : 'rgba(143,92,255,0.45)'}`,
          borderRadius: 10,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
          opacity: canCustom ? 1 : 0.5, transition: '180ms ease',
          boxShadow: useCustom ? `0 0 18px ${LOBBY_TOKENS.purple}66, inset 0 0 12px ${LOBBY_TOKENS.purple}22` : 'none',
          fontFamily: PROFILE_FONT,
        }}>
        <span style={{ fontSize: 22 }}>🛠️</span>
        <span style={{ fontSize: 11, fontWeight: 800, color: useCustom ? '#fff' : LOBBY_TOKENS.text, letterSpacing: 0.5 }}>Custom</span>
        <span style={{ fontSize: 9, color: useCustom ? '#fff' : LOBBY_TOKENS.muted, letterSpacing: 1, textTransform: 'uppercase' }}>
          {canCustom ? (useCustom ? 'Active' : '60 cards') : 'Locked'}
        </span>
      </button>
    </div>
  );
}

function DeckPreview({ color, useCustom, myDeck }: { color: Color | null; useCustom: boolean; myDeck: string[] }) {
  const data = useMemo(() => {
    if (useCustom && myDeck.length > 0) {
      const counts: Record<string, number> = {};
      for (const id of myDeck) counts[id] = (counts[id] ?? 0) + 1;
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      return {
        name: 'Custom Build',
        flavor: `${myDeck.length} cards · your saved deck`,
        accent: '#8f5cff',
        topCards: sorted.slice(0, 4).map(([id, n]) => ({ name: CARDS[id]?.name ?? id, n })),
      };
    }
    if (!color) return null;
    const meta = COLOR_META[color];
    const chainCards = BUILDABLE_CARDS.filter(c => c.color === color);
    const top = chainCards.filter(c => c.type === 'meme' || c.type === 'move').slice(0, 4);
    return {
      name: `${meta.name} Standard`,
      flavor: `60 cards · mono-${meta.name} theme deck`,
      accent: meta.hex,
      topCards: top.map(c => ({ name: c.name, n: 4 })),
    };
  }, [color, useCustom, myDeck]);

  if (!data) return null;
  return (
    <div style={{
      marginTop: 12, padding: 12, borderRadius: 10,
      background: `linear-gradient(135deg, ${data.accent}1a, rgba(10,15,25,0.6))`,
      border: `1px solid ${data.accent}55`,
      boxShadow: `0 0 22px -8px ${data.accent}88`,
      transition: '200ms ease',
    }}>
      <div style={{ fontSize: 9, color: data.accent, letterSpacing: 2, fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>Selected Deck</div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontFamily: '"Cinzel", serif', fontSize: 16, fontWeight: 800, color: '#fff', letterSpacing: 1 }}>{data.name}</div>
        <div style={{ fontSize: 11, color: LOBBY_TOKENS.muted }}>{data.flavor}</div>
      </div>
      <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {data.topCards.map((c, i) => (
          <span key={i} style={{
            padding: '3px 9px', borderRadius: 999, fontSize: 10, fontWeight: 700,
            background: 'rgba(255,255,255,0.06)', color: '#cfd6e3',
            border: `1px solid ${LOBBY_TOKENS.border}`,
          }}>{c.name}{c.n > 1 && <span style={{ color: data.accent, marginLeft: 4 }}>×{c.n}</span>}</span>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CHALLENGE PANEL (middle column, under Create Match)
// ─────────────────────────────────────────────────────────────────────────────
function ChallengePanel(props: {
  target: string; setTarget: (s: string) => void;
  message: string; setMessage: (s: string) => void;
  busy: boolean; onSend: () => void;
  outgoing: Challenge[]; onCancel: (c: Challenge) => void;
  wagerKind: 'free' | 'master'; wagerAmount: string;
}) {
  const { target, setTarget, message, setMessage, busy, onSend, outgoing, onCancel, wagerKind, wagerAmount } = props;
  const stakeLabel = wagerKind === 'master'
    ? `Wager · ${Number(wagerAmount) || 0} $MASTER`
    : 'Free Match';
  return (
    <div style={{
      ...glassPanelStyle(),
      padding: 20, display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontFamily: '"Cinzel", serif', fontSize: 16, fontWeight: 800, color: '#fff', letterSpacing: 1.2 }}>
          ⚔ Challenge a Player
        </div>
        <div style={{ fontSize: 10, color: LOBBY_TOKENS.muted, letterSpacing: 2, textTransform: 'uppercase' }}>
          Direct Invite
        </div>
      </div>
      <div style={{ fontSize: 12, color: LOBBY_TOKENS.muted, lineHeight: 1.5 }}>
        Invite a specific player by username. They'll see your challenge in their lobby and the match stays
        private until accepted. Uses the deck, seat, and stakes you picked above.
      </div>
      <div>
        <label style={{ fontSize: 10, color: LOBBY_TOKENS.muted, letterSpacing: 1.4, textTransform: 'uppercase' }}>
          Opponent username
        </label>
        <input
          type="text"
          value={target}
          onChange={e => setTarget(e.target.value.slice(0, 40))}
          placeholder="ShmeegleTheMage"
          spellCheck={false} autoCapitalize="none" autoCorrect="off"
          style={challengeInputStyle()}
        />
      </div>
      <div>
        <label style={{ fontSize: 10, color: LOBBY_TOKENS.muted, letterSpacing: 1.4, textTransform: 'uppercase' }}>
          Message (optional)
        </label>
        <input
          type="text"
          value={message}
          onChange={e => setMessage(e.target.value.slice(0, 200))}
          placeholder="gg let's go"
          style={challengeInputStyle()}
        />
      </div>
      <div style={{
        fontSize: 11, color: LOBBY_TOKENS.muted,
        background: 'rgba(255,255,255,0.04)', border: `1px solid ${LOBBY_TOKENS.border}`,
        borderRadius: 8, padding: '8px 12px',
      }}>
        Stakes: <b style={{ color: wagerKind === 'master' ? '#c8a3ff' : '#fff' }}>{stakeLabel}</b>
      </div>
      <button
        type="button" disabled={busy || !target.trim()} onClick={onSend}
        style={{
          padding: '12px 16px', borderRadius: 12, border: 'none', cursor: busy || !target.trim() ? 'not-allowed' : 'pointer',
          background: busy || !target.trim()
            ? 'rgba(255,255,255,0.08)'
            : 'linear-gradient(135deg, #8f5cff 0%, #b285ff 100%)',
          color: '#0a0414', fontFamily: '"Cinzel", serif', fontWeight: 800, fontSize: 13,
          letterSpacing: 1.4, textTransform: 'uppercase',
          boxShadow: busy ? 'none' : '0 0 20px rgba(143,92,255,0.35)',
          transition: 'transform .15s ease, filter .15s ease',
        }}
        onMouseOver={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.01)'; }}
        onMouseOut={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'; }}
      >
        {busy ? 'Sending…' : 'Send Challenge'}
      </button>

      {outgoing.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: 10, color: LOBBY_TOKENS.muted, letterSpacing: 1.4, textTransform: 'uppercase', marginBottom: 6 }}>
            Pending invites
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {outgoing.slice(0, 5).map(c => (
              <div key={c.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 8, padding: '8px 10px', borderRadius: 8,
                background: 'rgba(255,255,255,0.04)', border: `1px solid ${LOBBY_TOKENS.border}`,
              }}>
                <div style={{ fontSize: 12 }}>
                  <span style={{ color: LOBBY_TOKENS.muted }}>→ </span>
                  <b style={{ color: '#fff' }}>{c.toName}</b>
                  {c.wagerKind === 'master' && (
                    <span style={{ color: '#c8a3ff', marginLeft: 6 }}>· {c.wagerAmount} $MASTER</span>
                  )}
                </div>
                <button
                  type="button" onClick={() => onCancel(c)}
                  style={{
                    padding: '4px 10px', borderRadius: 6, fontSize: 10, fontWeight: 700,
                    background: 'transparent', color: '#ff8a8a',
                    border: '1px solid rgba(255,107,107,0.45)', cursor: 'pointer',
                  }}
                >Cancel</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INCOMING CHALLENGES BANNER
// ─────────────────────────────────────────────────────────────────────────────
function SolanaWalletPicker({ onPick, onCancel }: {
  onPick: (kind: SolanaWalletKind) => void;
  onCancel: () => void;
}) {
  const wallets = useMemo(() => detectSolanaWallets(), []);
  const installLinks: Record<SolanaWalletKind, string> = {
    phantom:  'https://phantom.app/',
    solflare: 'https://solflare.com/',
    backpack: 'https://backpack.app/',
    jupiter:  'https://jup.ag/mobile',
  };
  return (
    <div onClick={onCancel} style={{
      position: 'fixed', inset: 0, zIndex: 300,
      background: 'rgba(4,6,12,0.78)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        ...glassPanelStyle(),
        width: 'min(440px, 100%)', padding: 22,
        borderColor: 'rgba(143,92,255,0.55)',
        boxShadow: '0 0 32px rgba(143,92,255,0.25)',
      }}>
        <div style={{
          fontFamily: '"Cinzel", serif', fontSize: 18, fontWeight: 800,
          color: '#fff', letterSpacing: 1, marginBottom: 4,
        }}>Choose Your Wallet</div>
        <div style={{ fontSize: 12, color: LOBBY_TOKENS.muted, marginBottom: 16 }}>
          Sign the $MASTER wager deposit with your preferred Solana wallet.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {wallets.map(w => (
            <button
              key={w.kind}
              onClick={() => w.installed ? onPick(w.kind) : window.open(installLinks[w.kind], '_blank', 'noopener')}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 16px', borderRadius: 10,
                background: w.installed
                  ? 'linear-gradient(135deg, rgba(143,92,255,0.18), rgba(143,92,255,0.06))'
                  : 'rgba(255,255,255,0.03)',
                border: `1px solid ${w.installed ? 'rgba(143,92,255,0.55)' : LOBBY_TOKENS.border}`,
                color: '#fff', fontFamily: PROFILE_FONT, fontSize: 14, fontWeight: 700,
                cursor: 'pointer', transition: 'all 180ms ease',
              }}
              onMouseEnter={e => { if (w.installed) e.currentTarget.style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20 }}>
                  {w.kind === 'phantom' ? '👻' : w.kind === 'solflare' ? '🔥' : '🎒'}
                </span>
                <span>{w.label}</span>
              </span>
              <span style={{
                fontSize: 10, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase',
                color: w.installed ? '#c8a3ff' : LOBBY_TOKENS.muted,
              }}>{w.installed ? 'Connect' : 'Install →'}</span>
            </button>
          ))}
        </div>
        <button onClick={onCancel} style={{
          marginTop: 14, width: '100%', padding: '8px',
          background: 'transparent', border: `1px solid ${LOBBY_TOKENS.border}`,
          color: LOBBY_TOKENS.muted, borderRadius: 8, cursor: 'pointer',
          fontSize: 12, fontWeight: 700, letterSpacing: 1,
        }}>CANCEL</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function IncomingChallengesBanner({ challenges, onAccept, onDecline }: {
  challenges: Challenge[];
  onAccept: (c: Challenge) => void;
  onDecline: (c: Challenge) => void;
}) {
  return (
    <div style={{
      ...glassPanelStyle(),
      padding: 14,
      borderColor: 'rgba(217,184,95,0.45)',
      boxShadow: '0 0 24px rgba(217,184,95,0.18)',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{
        fontFamily: '"Cinzel", serif', fontSize: 14, color: LOBBY_TOKENS.gold,
        letterSpacing: 1.6, fontWeight: 800, textTransform: 'uppercase',
      }}>
        ⚔ {challenges.length} Incoming Challenge{challenges.length === 1 ? '' : 's'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {challenges.slice(0, 5).map(c => {
          const ageMin = Math.max(0, Math.floor((Date.now() - c.createdAt) / 60000));
          const expiresMin = Math.max(0, Math.ceil((c.expiresAt - Date.now()) / 60000));
          return (
            <div key={c.id} style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              padding: '10px 12px', borderRadius: 10,
              background: 'rgba(217,184,95,0.06)', border: '1px solid rgba(217,184,95,0.25)',
            }}>
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ fontSize: 13 }}>
                  <b style={{ color: '#fff' }}>{c.fromName}</b>
                  <span style={{ color: LOBBY_TOKENS.muted }}> challenges you</span>
                  {c.wagerKind === 'master' && (
                    <span style={{ color: '#c8a3ff', marginLeft: 6, fontWeight: 700 }}>
                      · {c.wagerAmount} $MASTER
                    </span>
                  )}
                </div>
                {c.message && (
                  <div style={{ fontSize: 12, color: '#cfd6e3', marginTop: 3, fontStyle: 'italic' }}>"{c.message}"</div>
                )}
                <div style={{ fontSize: 10, color: LOBBY_TOKENS.muted, marginTop: 3, letterSpacing: 0.4 }}>
                  Sent {ageMin}m ago · Expires in {expiresMin}m
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button" onClick={() => onAccept(c)}
                  style={{
                    padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
                    background: 'linear-gradient(135deg, #d9b85f 0%, #f1d27a 100%)',
                    color: '#1a0f00', fontFamily: '"Cinzel", serif', fontWeight: 800,
                    fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase',
                    boxShadow: '0 0 12px rgba(217,184,95,0.4)',
                  }}
                >Accept</button>
                <button
                  type="button" onClick={() => onDecline(c)}
                  style={{
                    padding: '8px 14px', borderRadius: 8, fontSize: 11, fontWeight: 700,
                    background: 'transparent', color: '#ff8a8a',
                    border: '1px solid rgba(255,107,107,0.45)', cursor: 'pointer',
                    letterSpacing: 1, textTransform: 'uppercase',
                  }}
                >Decline</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function glassPanelStyle(): React.CSSProperties {
  return {
    background: LOBBY_TOKENS.panel,
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    borderRadius: 12,
    border: `1px solid ${LOBBY_TOKENS.border}`,
  };
}
function challengeInputStyle(): React.CSSProperties {
  return {
    width: '100%', marginTop: 4, padding: '10px 12px', borderRadius: 8,
    background: 'rgba(0,0,0,0.35)', border: `1px solid ${LOBBY_TOKENS.border}`,
    color: '#fff', fontSize: 13, fontFamily: PROFILE_FONT, outline: 'none',
    boxSizing: 'border-box',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMUNITY PANEL (right column)
// ─────────────────────────────────────────────────────────────────────────────
type ActivityItem = { id: string; icon: string; text: React.ReactNode; ts?: number };

function buildActivityFeed(matches: any[], leaderboard: Profile[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const m of matches.slice(0, 6)) {
    const creator = (m.players as Array<{ name?: string }>).find(p => p.name)?.name ?? 'Someone';
    const w = readWager(m.setupData);
    const isWager = w.kind === 'master';
    items.push({
      id: `m-${m.matchID}`,
      icon: isWager ? '💎' : '⚔️',
      text: <><b style={{ color: '#fff' }}>{creator}</b> opened {isWager ? <span style={{ color: '#c8a3ff' }}>a {w.amount} $MASTER wager</span> : 'a casual match'}</>,
    });
  }
  const topPlayer = leaderboard[0];
  if (topPlayer) {
    items.push({
      id: 'lb-top',
      icon: '👑',
      text: <><b style={{ color: '#d9b85f' }}>{topPlayer.name}</b> is the current top player ({topPlayer.wins}W)</>,
    });
  }
  for (const p of leaderboard.slice(1, 4)) {
    items.push({
      id: `lb-${p.name}`,
      icon: '⭐',
      text: <><b style={{ color: '#fff' }}>{p.name}</b> sits at {p.wins}W · {p.losses}L</>,
    });
  }
  if (items.length === 0) {
    items.push({ id: 'idle', icon: '🌙', text: <span style={{ color: '#9faabf' }}>The realm is quiet… for now.</span> });
  }
  return items;
}

function CommunityPanel({ leaderboard, onViewProfile, activity }: {
  leaderboard: Profile[];
  onViewProfile: (name: string) => void;
  activity: ActivityItem[];
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Online */}
      <section style={{ ...LOBBY_GLASS, padding: '16px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <div style={{ fontSize: 10, color: LOBBY_TOKENS.green, letterSpacing: 2, fontWeight: 700, textTransform: 'uppercase' }}>Live</div>
            <div style={{ fontFamily: '"Cinzel", serif', fontSize: 16, fontWeight: 800, color: '#fff', letterSpacing: 1 }}>Players Online</div>
          </div>
          <div style={{
            fontFamily: '"Cinzel", serif', fontSize: 28, fontWeight: 900,
            color: LOBBY_TOKENS.green, textShadow: `0 0 18px ${LOBBY_TOKENS.green}66`,
          }}>{leaderboard.length}</div>
        </div>
      </section>

      {/* Activity feed */}
      <section style={{ ...LOBBY_GLASS, padding: 0, display: 'flex', flexDirection: 'column', maxHeight: 280, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${LOBBY_TOKENS.border}` }}>
          <div style={{ fontSize: 10, color: LOBBY_TOKENS.purple, letterSpacing: 2, fontWeight: 700, textTransform: 'uppercase' }}>Pulse</div>
          <div style={{ fontFamily: '"Cinzel", serif', fontSize: 15, fontWeight: 800, color: '#fff', letterSpacing: 1 }}>Activity Feed</div>
        </div>
        <div style={{ overflowY: 'auto', padding: '8px 0' }}>
          {activity.map(a => (
            <div key={a.id} style={{
              display: 'flex', gap: 10, padding: '8px 16px',
              fontSize: 12, color: LOBBY_TOKENS.text, lineHeight: 1.4,
            }}>
              <span style={{ fontSize: 14, lineHeight: 1.2 }}>{a.icon}</span>
              <span style={{ flex: 1, minWidth: 0 }}>{a.text}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Tournaments */}
      <section style={{ ...LOBBY_GLASS, padding: 16 }}>
        <div style={{ fontSize: 10, color: LOBBY_TOKENS.gold, letterSpacing: 2, fontWeight: 700, textTransform: 'uppercase' }}>Tournaments</div>
        <div style={{ fontFamily: '"Cinzel", serif', fontSize: 15, fontWeight: 800, color: '#fff', letterSpacing: 1, marginBottom: 10 }}>Upcoming</div>
        <TournamentCard
          name="Daily $MASTER Cup"
          flavor="Top placement wins $MASTER"
          countdownToNextUtcMidnight
          entrants={Math.max(8, leaderboard.length)}
          accent={LOBBY_TOKENS.gold}
        />
        <div style={{ height: 10 }} />
        <TournamentCard
          name="Weekend Solana Showdown"
          flavor="Mono-Solana bracket · 32 seats"
          countdownDays={6}
          entrants={Math.min(32, Math.max(4, leaderboard.length / 2 | 0))}
          accent={LOBBY_TOKENS.purple}
        />
      </section>

      {/* Top players quick links */}
      {leaderboard.length > 0 && (
        <section style={{ ...LOBBY_GLASS, padding: 16 }}>
          <div style={{ fontSize: 10, color: LOBBY_TOKENS.muted, letterSpacing: 2, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8 }}>Top Players</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {leaderboard.slice(0, 5).map((p, i) => {
              const games = p.wins + p.losses + p.draws;
              const wp = games ? Math.round((p.wins / games) * 100) : 0;
              return (
                <button key={p.name} onClick={() => onViewProfile(p.name)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '6px 10px', textAlign: 'left',
                    background: 'rgba(255,255,255,0.03)',
                    border: `1px solid ${LOBBY_TOKENS.border}`,
                    borderRadius: 8, cursor: 'pointer',
                    fontFamily: PROFILE_FONT,
                  }}>
                  <span style={{
                    minWidth: 22, height: 22, borderRadius: '50%',
                    background: i === 0 ? `linear-gradient(180deg, ${LOBBY_TOKENS.gold}, #b78827)` : 'rgba(255,255,255,0.08)',
                    color: i === 0 ? '#1a1408' : '#cfd6e3',
                    fontSize: 11, fontWeight: 900,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}>{i + 1}</span>
                  <span style={{ flex: 1, color: '#fff', fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  <span style={{ fontSize: 11, color: LOBBY_TOKENS.muted }}>{wp}%</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function TournamentCard({ name, flavor, countdownToNextUtcMidnight, countdownDays, entrants, accent }: {
  name: string; flavor: string;
  countdownToNextUtcMidnight?: boolean; countdownDays?: number;
  entrants: number; accent: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const target = useMemo(() => {
    if (countdownToNextUtcMidnight) {
      const d = new Date();
      d.setUTCHours(24, 0, 0, 0);
      return d.getTime();
    }
    return Date.now() + (countdownDays ?? 1) * 86400000;
  }, [countdownToNextUtcMidnight, countdownDays]);
  const ms = Math.max(0, target - now);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return (
    <div style={{
      padding: 12, borderRadius: 10,
      background: `linear-gradient(135deg, ${accent}1a, rgba(10,15,25,0.6))`,
      border: `1px solid ${accent}55`,
    }}>
      <div style={{ fontFamily: '"Cinzel", serif', fontSize: 14, fontWeight: 800, color: '#fff', letterSpacing: 1 }}>{name}</div>
      <div style={{ fontSize: 11, color: LOBBY_TOKENS.muted, marginTop: 2 }}>{flavor}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
        <span style={{ fontFamily: '"Cinzel", serif', fontSize: 18, fontWeight: 900, color: accent, letterSpacing: 1.5, textShadow: `0 0 12px ${accent}66` }}>
          {String(h).padStart(2,'0')}:{String(m).padStart(2,'0')}:{String(s).padStart(2,'0')}
        </span>
        <span style={{ fontSize: 11, color: LOBBY_TOKENS.muted }}>{entrants} entrants</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FOOTER STATS BAR
// ─────────────────────────────────────────────────────────────────────────────
function FooterStatsBar({ playersOnline, openMatches, inProgress, onBack: _onBack }: {
  playersOnline: number; openMatches: number; inProgress: number; onBack: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const next = useMemo(() => { const d = new Date(); d.setUTCHours(24,0,0,0); return d.getTime(); }, []);
  const ms = Math.max(0, next - now);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return (
    <div style={{
      position: 'sticky', bottom: 0, zIndex: 10,
      borderTop: `1px solid ${LOBBY_TOKENS.border}`,
      background: 'linear-gradient(180deg, rgba(7,9,15,0.65), rgba(7,9,15,0.95))',
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      padding: '10px 22px',
    }}>
      <div style={{
        maxWidth: 1480, margin: '0 auto',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 14, flexWrap: 'wrap', fontFamily: PROFILE_FONT,
      }}>
        <FooterStat label="Players Online" value={playersOnline} color={LOBBY_TOKENS.green} />
        <FooterStat label="Open Matches" value={openMatches} color={LOBBY_TOKENS.gold} />
        <FooterStat label="In Progress" value={inProgress} color={LOBBY_TOKENS.purple} />
        <FooterStat label="Next Tournament" value={`${h}h ${m}m`} color={LOBBY_TOKENS.danger} />
      </div>
    </div>
  );
}

function FooterStat({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: color, boxShadow: `0 0 8px ${color}`,
      }} />
      <span style={{ fontSize: 11, color: LOBBY_TOKENS.muted, letterSpacing: 1, fontWeight: 700, textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 800, color: '#fff' }}>{value}</span>
    </div>
  );
}

// ── In-match seat (waits if opponent not yet present) ───────────────────────
function MatchSeat({ seat, onLeave }: { seat: Seat; onLeave: () => void }) {
  const mobile = useIsMobile(860);
  const ChainsClient = useMemo(() => Client({
    game: ChainsTCG,
    board: ChainsBoard,
    numPlayers: 2,
    multiplayer: SocketIO({ server: SERVER_BASE || undefined }),
    debug: false,
  }), []);

  // Poll match state to show "waiting for opponent" until both seats filled.
  const [match, setMatch] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const m = await lobby.getMatch(GAME_NAME, seat.matchID);
        if (alive) setMatch(m);
      } catch { /* ignore */ }
    }
    tick();
    const t = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [seat.matchID]);

  const players = (match?.players as Array<{ id: number; name?: string }>) ?? [];
  const filled = players.filter(p => p.name).length;
  const isFull = filled === 2 && players.length === 2;

  // "Opponent joined → entering the arena" interstitial before the game mounts.
  // Guarded so it fires exactly once (prevents duplicate navigation/starts).
  const [entered, setEntered] = useState(false);
  const enterOnce = useRef(false);
  useEffect(() => {
    if (isFull && !enterOnce.current) {
      enterOnce.current = true;
      const t = setTimeout(() => setEntered(true), 1700);
      return () => clearTimeout(t);
    }
  }, [isFull]);

  // Fetch real avatars for whoever is seated (host now, opponent when they join).
  const [avatars, setAvatars] = useState<Record<string, string | null>>({});
  const fetchedRef = useRef<Set<string>>(new Set());
  const nameKey = players.map(p => p.name || '').join('|');
  useEffect(() => {
    for (const p of players) {
      if (p.name && !fetchedRef.current.has(p.name)) {
        fetchedRef.current.add(p.name);
        getProfileApi(p.name).then(pr => setAvatars(a => ({ ...a, [p.name!]: pr?.avatarUrl ?? null }))).catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameKey]);

  // Leave-match flow with confirm + in-flight guard.
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveErr, setLeaveErr] = useState('');
  async function doLeave() {
    if (leaving) return;
    setLeaving(true); setLeaveErr('');
    try {
      await lobby.leaveMatch(GAME_NAME, seat.matchID, { playerID: seat.playerID, credentials: seat.credentials });
      onLeave();
    } catch {
      setLeaveErr('Could not leave the match. Please try again.');
      setLeaving(false);
    }
  }

  // Invite link (unchanged logic) + copy/share.
  const inviteUrl = window.location.origin + window.location.pathname + '#match=' + seat.matchID;
  const [copied, setCopied] = useState<'' | 'link' | 'id'>('');
  const flashCopied = (which: 'link' | 'id') => { setCopied(which); setTimeout(() => setCopied(''), 1600); };
  function fallbackCopy(text: string) {
    try { const el = document.createElement('textarea'); el.value = text; el.style.position = 'fixed'; el.style.opacity = '0';
      document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el); } catch {}
  }
  async function copyInvite() { try { await navigator.clipboard.writeText(inviteUrl); } catch { fallbackCopy(inviteUrl); } flashCopied('link'); }
  async function copyMatchId() { try { await navigator.clipboard.writeText(seat.matchID); } catch { fallbackCopy(seat.matchID); } flashCopied('id'); }
  async function share() {
    if ((navigator as any).share) {
      try { await (navigator as any).share({ title: 'On-Chain Virtual Arena', text: 'Join my match on On-Chain Virtual Arena', url: inviteUrl }); return; } catch { /* cancelled → fall through */ }
    }
    copyInvite();
  }

  // Once the interstitial elapses and both seats are filled, mount the game.
  if (entered && isFull) {
    return (
      <div style={{ background: '#000', minHeight: '100vh' }}>
        <BattleMusic />
        <WagerStatusBadge matchID={seat.matchID} compact />
        <ChainsClient matchID={seat.matchID} playerID={seat.playerID} credentials={seat.credentials} />
      </div>
    );
  }

  const youAt = Number(seat.playerID);
  const p0 = players[0]?.name ?? (youAt === 0 ? seat.playerName : undefined);
  const p1 = players[1]?.name ?? (youAt === 1 ? seat.playerName : undefined);
  const opponentJoined = isFull;

  return (
    <div style={{ position: 'fixed', inset: 0, height: '100dvh', overflow: mobile ? 'auto' : 'hidden',
      color: HUB.text, fontFamily: HUB_SANS, display: 'flex', flexDirection: 'column' }}>
      <style>{`
        @keyframes ml-spin { to { transform: rotate(360deg); } }
        @keyframes ml-spin-rev { to { transform: rotate(-360deg); } }
        @keyframes ml-pulse { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
        @keyframes ml-dash { to { stroke-dashoffset: -40; } }
        @keyframes ml-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @media (prefers-reduced-motion: reduce) {
          .ml-anim { animation: none !important; }
        }
      `}</style>
      <MatchChamberBackdrop />

      {/* Top chrome */}
      <div style={{ position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <HubEmblem size={30} />
          <div style={{ lineHeight: 1 }}>
            <div style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: 10, letterSpacing: '0.22em', color: HUB.muted }}>ON-CHAIN</div>
            <div style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: 14, letterSpacing: '0.1em', color: HUB.goldHi }}>VIRTUAL ARENA</div>
          </div>
        </div>
        <div style={{ fontFamily: HUB_SERIF, fontWeight: 700, letterSpacing: '0.32em', fontSize: 13, color: HUB.goldHi, textShadow: `0 0 16px ${HUB.gold}66` }}>◇ MATCH LOBBY ◇</div>
        <button onClick={() => setConfirmLeave(true)} style={{ padding: '9px 16px', borderRadius: 9, background: 'transparent',
          border: `1px solid ${HUB.gold}`, color: HUB.goldHi, cursor: 'pointer', fontWeight: 800, letterSpacing: '0.06em', fontSize: 12 }}>LEAVE MATCH</button>
      </div>

      {/* Centered panel */}
      <div style={{ position: 'relative', zIndex: 1, flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', padding: mobile ? '8px 12px 28px' : '4px 20px 20px' }}>
        <div style={{ position: 'relative', width: 'min(1140px, 100%)', maxHeight: '100%', overflow: mobile ? 'visible' : 'auto',
          borderRadius: 16, padding: mobile ? '22px 16px' : '30px 40px 26px',
          background: 'linear-gradient(180deg, rgba(11,14,28,0.86), rgba(7,9,18,0.9))',
          border: `1px solid ${HUB.gold}55`, boxShadow: `0 30px 90px rgba(3,4,12,0.7), 0 0 60px rgba(142,77,255,0.18), inset 0 0 0 1px rgba(255,255,255,0.02)`,
          backdropFilter: 'blur(8px)' }}>
          {(['tl', 'tr', 'bl', 'br'] as const).map((k) => <ChamberCorner key={k} pos={k} />)}

          <div style={{ textAlign: 'center' }}>
            <h1 style={{ margin: 0, fontFamily: HUB_SERIF, fontWeight: 700, letterSpacing: '0.04em',
              fontSize: mobile ? 34 : 'clamp(40px, 5vw, 60px)', lineHeight: 1.02,
              background: `linear-gradient(180deg, #f7e6b0, ${HUB.gold} 55%, #a67c2e)`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
              textShadow: `0 2px 30px ${HUB.gold}33` }}>
              {opponentJoined ? 'OPPONENT JOINED' : 'MATCH CREATED'}
            </h1>
            <div style={{ color: HUB.muted, fontSize: mobile ? 13 : 15, marginTop: 6 }}>
              {opponentJoined ? 'Entering the arena…' : 'Your arena is ready. Invite an opponent to begin.'}
            </div>

            {/* Match ID control */}
            <button onClick={copyMatchId} title="Copy match ID" style={{ marginTop: 14, display: 'inline-flex', alignItems: 'center', gap: 10,
              padding: '8px 14px', borderRadius: 10, background: 'rgba(8,10,22,0.7)', border: `1px solid ${HUB.gold}44`, color: HUB.text, cursor: 'pointer' }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', color: HUB.muted }}>MATCH ID</span>
              <span style={{ fontFamily: F.mono, fontSize: 14, color: HUB.goldHi }}>{seat.matchID.slice(0, 8)}</span>
              <span style={{ color: copied === 'id' ? HUB.green : HUB.muted }}>{copied === 'id' ? '✓' : '⧉'}</span>
            </button>
          </div>

          {/* Arcane waiting portal */}
          <ArcaneWaiting joined={opponentJoined} entering={entered} />

          {/* Seats */}
          <div style={{ display: 'flex', alignItems: 'stretch', justifyContent: 'center', gap: mobile ? 12 : 22,
            flexDirection: mobile ? 'column' : 'row', marginTop: 20 }}>
            <SeatCard seat="P0" role="HOST" name={p0} avatar={p0 ? avatars[p0] : undefined} isYou={youAt === 0} joined mobile={mobile} />
            <div style={{ display: 'grid', placeItems: 'center', flex: 'none' }}>
              <VsRune mobile={mobile} />
            </div>
            <SeatCard seat="P1" role={p1 ? 'CHALLENGER' : 'OPEN'} name={p1} avatar={p1 ? avatars[p1] : undefined} isYou={youAt === 1} joined={!!p1} mobile={mobile} />
          </div>

          <WagerStatusBadge matchID={seat.matchID} />

          {/* Invitation */}
          {!opponentJoined && (
            <div style={{ marginTop: 22, paddingTop: 18, borderTop: `1px solid ${HUB.border}` }}>
              <div style={{ textAlign: 'center', fontFamily: HUB_SERIF, fontWeight: 700, letterSpacing: '0.16em', color: HUB.goldHi, fontSize: 14 }}>◇ INVITE YOUR OPPONENT ◇</div>
              <div style={{ textAlign: 'center', color: HUB.muted, fontSize: 12.5, marginTop: 4 }}>Share this private link to fill the open seat.</div>
              <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap', alignItems: 'stretch' }}>
                <input readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link"
                  style={{ flex: '1 1 320px', minWidth: 0, padding: '12px 14px', borderRadius: 10, background: 'rgba(6,8,18,0.8)',
                    border: `1px solid ${HUB.border}`, color: HUB.cyan, fontFamily: F.mono, fontSize: 12.5, outline: 'none' }} />
                <button onClick={copyInvite} style={{ ...hubGoldBtn(false), marginTop: 0, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '12px 20px', fontSize: 13 }}>
                  ⧉ {copied === 'link' ? 'LINK COPIED' : 'COPY INVITE LINK'}
                </button>
                <button onClick={share} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '12px 20px', borderRadius: 10,
                  background: `linear-gradient(180deg, ${HUB.purple}, ${HUB.violet})`, color: '#fff', border: `1px solid ${HUB.violet}`, cursor: 'pointer', fontWeight: 800, letterSpacing: '0.04em', fontSize: 13 }}>↗ SHARE</button>
              </div>
              <div style={{ textAlign: 'center', color: HUB.muted, fontSize: 12, marginTop: 14 }}>◇ The duel will begin automatically when Player 1 joins.</div>
            </div>
          )}
        </div>
      </div>

      {confirmLeave && (
        <div onClick={() => !leaving && setConfirmLeave(false)} style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(3,4,10,0.78)', backdropFilter: 'blur(4px)', display: 'grid', placeItems: 'center', padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(440px, 100%)', borderRadius: 14, background: HUB.surface, border: `1px solid ${HUB.gold}44`, padding: 22 }}>
            <div style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: 20, color: HUB.text }}>Leave this match?</div>
            <div style={{ color: HUB.muted, fontSize: 13.5, marginTop: 8, lineHeight: 1.5 }}>The open match will be closed and the invite link will stop working.</div>
            {leaveErr && <div style={{ color: HUB.red, fontSize: 12.5, marginTop: 10 }}>{leaveErr}</div>}
            <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmLeave(false)} disabled={leaving} style={{ padding: '10px 18px', borderRadius: 10, background: HUB.raised, border: `1px solid ${HUB.border}`, color: HUB.text, cursor: leaving ? 'default' : 'pointer', fontWeight: 700, letterSpacing: '0.04em' }}>STAY</button>
              <button onClick={doLeave} disabled={leaving} style={{ padding: '10px 18px', borderRadius: 10, background: leaving ? '#5a2530' : HUB.red, border: 'none', color: '#fff', cursor: leaving ? 'default' : 'pointer', fontWeight: 800, letterSpacing: '0.04em' }}>{leaving ? 'LEAVING…' : 'LEAVE MATCH'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MatchChamberBackdrop() {
  return (
    <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, background:
        `radial-gradient(55% 45% at 50% 30%, rgba(142,77,255,0.16), transparent 70%),
         radial-gradient(120% 100% at 50% 0%, #10132a 0%, #06060f 60%, #040409 100%)` }} />
      {[[6, 40], [12, 66], [88, 44], [93, 70], [20, 82], [80, 84]].map(([l, t], i) => (
        <div key={i} className="ml-anim" style={{ position: 'absolute', left: `${l}%`, top: `${t}%`, width: 3, height: 30,
          background: 'linear-gradient(180deg, transparent, #b79cff, transparent)', opacity: 0.4, filter: 'blur(1px)',
          transform: `rotate(${i % 2 ? 16 : -12}deg)`, animation: `ml-pulse ${3 + i}s ease-in-out infinite` }} />
      ))}
      <div style={{ position: 'absolute', inset: 0, boxShadow: 'inset 0 0 260px 70px rgba(0,0,0,0.85)' }} />
    </div>
  );
}

function ChamberCorner({ pos }: { pos: 'tl' | 'tr' | 'bl' | 'br' }) {
  const base: React.CSSProperties = { position: 'absolute', width: 26, height: 26, borderColor: `${HUB.gold}aa`, borderStyle: 'solid', borderWidth: 0 };
  const map: Record<string, React.CSSProperties> = {
    tl: { top: 8, left: 8, borderTopWidth: 2, borderLeftWidth: 2, borderTopLeftRadius: 8 },
    tr: { top: 8, right: 8, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: 8 },
    bl: { bottom: 8, left: 8, borderBottomWidth: 2, borderLeftWidth: 2, borderBottomLeftRadius: 8 },
    br: { bottom: 8, right: 8, borderBottomWidth: 2, borderRightWidth: 2, borderBottomRightRadius: 8 },
  };
  return <div aria-hidden style={{ ...base, ...map[pos] }} />;
}

function ArcaneWaiting({ joined, entering }: { joined: boolean; entering: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 18 }} role="status" aria-live="polite">
      <div style={{ position: 'relative', width: 300, height: 60, display: 'grid', placeItems: 'center' }}>
        {/* orbiting rune ring */}
        <svg width="300" height="60" viewBox="0 0 300 60" style={{ position: 'absolute', inset: 0 }} aria-hidden>
          <ellipse cx="150" cy="30" rx="120" ry="26" fill="none" stroke={`${HUB.violet}66`} strokeWidth="1.5" />
          <ellipse className="ml-anim" cx="150" cy="30" rx="120" ry="26" fill="none" stroke={joined ? HUB.green : HUB.violet} strokeWidth="2"
            strokeDasharray="6 12" style={{ animation: 'ml-dash 2.4s linear infinite', filter: `drop-shadow(0 0 6px ${joined ? HUB.green : HUB.violet})` }} />
        </svg>
        {/* side runes */}
        <span className="ml-anim" style={{ position: 'absolute', left: 8, color: HUB.violet, fontSize: 18, animation: 'ml-float 3s ease-in-out infinite', filter: `drop-shadow(0 0 8px ${HUB.violet})` }}>✦</span>
        <span className="ml-anim" style={{ position: 'absolute', right: 8, color: HUB.gold, fontSize: 18, animation: 'ml-float 3.6s ease-in-out infinite', filter: `drop-shadow(0 0 8px ${HUB.gold})` }}>◈</span>
        <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.14em', color: HUB.text, textAlign: 'center', padding: '0 40px' }}>
          {entering ? 'ENTERING THE ARENA…' : joined ? 'OPPONENT JOINED' : 'WAITING FOR AN OPPONENT…'}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <span className="ml-anim" style={{ width: 8, height: 8, borderRadius: '50%', background: HUB.cyan, boxShadow: `0 0 8px ${HUB.cyan}`, animation: 'ml-pulse 1.4s ease-in-out infinite' }} />
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.14em', color: HUB.cyan }}>LIVE</span>
      </div>
    </div>
  );
}

function VsRune({ mobile }: { mobile: boolean }) {
  const s = mobile ? 54 : 76;
  return (
    <div style={{ width: s, height: s, transform: 'rotate(45deg)', borderRadius: 10, display: 'grid', placeItems: 'center',
      background: 'linear-gradient(135deg, rgba(20,16,40,0.9), rgba(40,28,80,0.9))', border: `1px solid ${HUB.gold}88`,
      boxShadow: `0 0 24px ${HUB.violet}55` }}>
      <span style={{ transform: 'rotate(-45deg)', fontFamily: HUB_SERIF, fontWeight: 800, fontSize: mobile ? 20 : 26, color: HUB.goldHi }}>VS</span>
    </div>
  );
}

function SeatCard({ seat, role, name, avatar, isYou, joined, mobile }: {
  seat: string; role: string; name?: string; avatar?: string | null; isYou: boolean; joined: boolean; mobile: boolean;
}) {
  const active = joined;
  return (
    <div style={{ flex: mobile ? '1 1 auto' : '1 1 0', maxWidth: mobile ? '100%' : 360, minWidth: mobile ? 0 : 280,
      position: 'relative', borderRadius: 14, padding: mobile ? '18px 16px' : '22px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
      background: active ? 'linear-gradient(180deg, rgba(18,15,38,0.9), rgba(10,9,22,0.9))' : 'rgba(10,10,22,0.5)',
      border: active ? `1px solid ${HUB.gold}88` : `1px dashed ${HUB.violet}88`,
      boxShadow: active ? `0 0 30px ${HUB.violet}33, inset 0 0 0 1px ${HUB.gold}33` : 'none' }}
      className={active ? undefined : 'ml-anim'}>
      {!active && <div aria-hidden className="ml-anim" style={{ position: 'absolute', inset: -1, borderRadius: 14, border: `1px solid ${HUB.violet}`, animation: 'ml-pulse 2s ease-in-out infinite', pointerEvents: 'none' }} />}
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.14em', color: active ? HUB.goldHi : HUB.violet }}>{seat} · {role}</div>

      <div style={{ position: 'relative', width: mobile ? 92 : 108, height: mobile ? 92 : 108, borderRadius: '50%', display: 'grid', placeItems: 'center',
        background: active ? `conic-gradient(from 0deg, ${HUB.gold}, ${HUB.violet}, ${HUB.gold})` : 'transparent',
        border: active ? 'none' : `2px dashed ${HUB.violet}88`, padding: active ? 3 : 0 }}>
        <div style={{ width: '100%', height: '100%', borderRadius: '50%', overflow: 'hidden', display: 'grid', placeItems: 'center',
          background: 'radial-gradient(circle at 50% 35%, #1a1636, #0a0a16)' }}>
          {joined && name
            ? (avatar ? <img src={avatar} alt={`${name} avatar`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <span style={{ fontSize: mobile ? 34 : 42, fontWeight: 800, color: HUB.violet, filter: `drop-shadow(0 0 10px ${HUB.violet})` }}>{name.slice(0, 1).toUpperCase()}</span>)
            : <span className="ml-anim" style={{ fontSize: mobile ? 34 : 42, fontWeight: 800, color: HUB.violet, animation: 'ml-pulse 2s ease-in-out infinite' }}>?</span>}
        </div>
      </div>

      {joined && name ? (
        <>
          <div style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: mobile ? 20 : 24, color: HUB.text, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {isYou && <span style={{ padding: '2px 10px', borderRadius: 6, background: `${HUB.violet}22`, border: `1px solid ${HUB.violet}88`, color: HUB.violet, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em' }}>YOU</span>}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, background: `${HUB.green}18`, border: `1px solid ${HUB.green}66`, color: HUB.green, fontSize: 11, fontWeight: 800 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: HUB.green, boxShadow: `0 0 6px ${HUB.green}` }} />READY
            </span>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: mobile ? 20 : 24, color: HUB.muted }}>WAITING…</div>
          <div style={{ fontSize: 12, color: HUB.muted }}>Opponent seat available</div>
        </>
      )}
    </div>
  );
}

/** Tiny widget that polls /api/wager/status. Renders nothing if the match has
 *  no custodial wager row (the bg.io matchID differs from the custId; we look
 *  up the match's setupData first to find the custId). */
function WagerStatusBadge({ matchID, compact }: { matchID: string; compact?: boolean }) {
  const [custId, setCustId] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [status, setStatus] = useState<null | { p0Funded: boolean; p1Funded: boolean; settled: boolean; refunded: boolean }>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const m = await lobby.getMatch(GAME_NAME, matchID);
        const w = readWager((m as any).setupData);
        if (w.kind === 'master' && w.mode === 'custodial' && w.onchainId) {
          if (alive) { setCustId(w.onchainId); setAmount(w.amount); }
        }
      } catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [matchID]);

  useEffect(() => {
    if (!custId) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${SERVER_BASE}/api/wager/status?matchID=${encodeURIComponent(custId)}`);
        const j = await r.json();
        if (alive && j?.status) setStatus(j.status);
      } catch { /* ignore */ }
    };
    poll();
    const t = setInterval(poll, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [custId]);

  if (!custId || !status) return null;
  const label =
    status.refunded ? '↩ Refunded'
    : status.settled ? '✅ Settled'
    : status.p0Funded && status.p1Funded ? '💰 Both deposited — match live'
    : status.p0Funded || status.p1Funded ? `⌛ Waiting for opponent deposit (${amount} $MASTER each)`
    : `⌛ Waiting for deposits (${amount} $MASTER each)`;
  const color =
    status.refunded ? '#aaa'
    : status.settled ? '#22c55e'
    : status.p0Funded && status.p1Funded ? '#22c55e'
    : '#f0b90b';
  if (compact) {
    return (
      <div style={{
        position: 'fixed', left: 16, top: 16, zIndex: 50,
        background: '#15192a', color, border: `1px solid ${color}`,
        borderRadius: 6, padding: '4px 10px', fontSize: 11, fontWeight: 700,
        fontFamily: 'Inter, sans-serif',
      }}>{label}</div>
    );
  }
  return (
    <div style={{
      display: 'inline-block', marginBottom: 16,
      background: '#15192a', color, border: `1px solid ${color}`,
      borderRadius: 6, padding: '8px 14px', fontSize: 13, fontWeight: 700,
      fontFamily: 'Inter, sans-serif',
    }}>{label}</div>
  );
}

// ── Root ────────────────────────────────────────────────────────────────────
type View = 'landing' | 'profile' | 'rules' | 'lobby' | 'view-profile' | 'ranked' | 'solo' | 'boosters' | 'masterquest';

/**
 * Print-mode renderer used by scripts/render-cards.mjs. Lays out every card in
 * the catalogue as a 280×400 CardPreview wrapped in a div with
 * data-card-id="<id>" so a Playwright script can grab each one individually.
 */
function PrintAllCards() {
  const all = Object.values(CARDS);
  return (
    <div style={{
      background: '#fff', padding: 16,
      display: 'flex', flexWrap: 'wrap', gap: 16,
      fontFamily: 'system-ui, sans-serif',
    }}>
      {all.map(def => (
        <div
          key={def.id}
          data-card-id={def.id}
          style={{ width: 280, height: 400, position: 'relative' }}
        >
          <CardPreview def={def} />
        </div>
      ))}
    </div>
  );
}

// Solo (vs-bot) setup modal: pick difficulty + mode + deck color, then launch
// the in-browser SoloClient. No server hops, no wager, no voice — see
// src/SoloClient.tsx + src/bot.ts.
function SoloSetupModal({
  myName, onLaunch, onClose,
}: {
  myName: string;
  onLaunch: (cfg: { difficulty: Difficulty; mode: SoloMode; color: Color; customDeck: string[] | null }) => void;
  onClose: () => void;
}) {
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [mode, setMode] = useState<SoloMode>('casual');
  const [color, setColor] = useState<Color>('sol');
  // null = use one of the 5 starter decks; otherwise the chosen saved deck id.
  const [selectedDeckId, setSelectedDeckId] = useState<number | null>(null);
  const [decks, setDecks] = useState<DeckEntry[]>([]);
  const [decksLoading, setDecksLoading] = useState<boolean>(true);
  const dateKey = todayKey();
  const best = todayBest(difficulty);

  // Load this player's saved decks so they can play vs bot with one of them.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setDecksLoading(true);
      try {
        const list = await listDecksApi(myName);
        if (cancelled) return;
        setDecks(list);
      } catch {
        if (!cancelled) setDecks([]);
      } finally {
        if (!cancelled) setDecksLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [myName]);

  const chosenCustom = selectedDeckId == null ? null : decks.find(d => d.id === selectedDeckId) ?? null;
  const customInvalid = chosenCustom ? !validateDeck(chosenCustom.cards).ok : false;

  const btn = (active: boolean, accent: string): React.CSSProperties => ({
    background: active ? accent : '#1a1730',
    color: active ? '#fff' : '#ccc',
    border: `2px solid ${active ? accent : '#3a3050'}`,
    borderRadius: 8,
    padding: '10px 14px',
    fontWeight: 700,
    cursor: 'pointer',
    fontSize: 13,
    minWidth: 80,
  });

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(2,2,8,0.78)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'linear-gradient(160deg, #150f2a, #0a0716)',
        border: '1px solid #6c4bd8',
        borderRadius: 14,
        padding: 22, maxWidth: 480, width: '100%',
        color: '#fff', fontFamily: 'Inter, sans-serif',
        boxShadow: '0 18px 50px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: 1 }}>🤖 Play vs Bot</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>Single-player, runs entirely in your browser.</div>
        </div>

        <div>
          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6, letterSpacing: 1 }}>DIFFICULTY</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['easy', 'normal', 'hard'] as Difficulty[]).map(d => (
              <button key={d} onClick={() => setDifficulty(d)}
                style={btn(difficulty === d,
                  d === 'easy' ? '#3aa66a' : d === 'normal' ? '#6c4bd8' : '#c8455d')}>
                {d.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6, letterSpacing: 1 }}>MODE</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setMode('casual')} style={btn(mode === 'casual', '#6c4bd8')}>
              CASUAL
            </button>
            <button onClick={() => setMode('daily')} style={btn(mode === 'daily', '#ffaf3a')}>
              ⭐ DAILY ({dateKey})
            </button>
          </div>
          <div style={{ fontSize: 11, opacity: 0.65, marginTop: 6 }}>
            {mode === 'daily'
              ? 'Same shuffle + bot deck for every player today. Race for the fastest win.'
              : 'Random shuffle and random bot deck every match.'}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6, letterSpacing: 1 }}>YOUR DECK</div>

          {/* Starter vs. custom deck picker. Custom decks come from the library. */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <button
              onClick={() => setSelectedDeckId(null)}
              style={{
                background: selectedDeckId == null ? '#6c4bd8' : '#1a1730',
                color: selectedDeckId == null ? '#fff' : '#ccc',
                border: `2px solid ${selectedDeckId == null ? '#6c4bd8' : '#3a3050'}`,
                borderRadius: 8, padding: '8px 12px',
                fontWeight: 700, cursor: 'pointer', fontSize: 12,
              }}
            >STARTER</button>
            {decksLoading && (
              <div style={{ fontSize: 11, opacity: 0.6, alignSelf: 'center' }}>loading decks…</div>
            )}
            {!decksLoading && decks.map(d => {
              const active = selectedDeckId === d.id;
              const ok = validateDeck(d.cards).ok;
              return (
                <button key={d.id} onClick={() => setSelectedDeckId(d.id)} style={{
                  background: active ? '#3aa66a' : '#1a1730',
                  color: active ? '#fff' : ok ? '#ccc' : '#c8455d',
                  border: `2px solid ${active ? '#3aa66a' : '#3a3050'}`,
                  borderRadius: 8, padding: '8px 12px',
                  fontWeight: 700, cursor: 'pointer', fontSize: 12,
                  opacity: ok ? 1 : 0.7,
                }} title={ok ? d.name : `${d.name} (invalid — fix in Deck Library)`}>
                  {d.name}{!ok ? ' ⚠' : ''}
                </button>
              );
            })}
            {!decksLoading && decks.length === 0 && (
              <div style={{ fontSize: 11, opacity: 0.6, alignSelf: 'center' }}>
                No saved decks yet — build one in the Deck Library.
              </div>
            )}
          </div>

          {/* Starter color picker — only meaningful when no custom deck is chosen. */}
          {selectedDeckId == null ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(['bnb', 'sol', 'eth', 'robinhood', 'base'] as Color[]).map(c => {
                const meta = COLOR_META[c];
                const active = color === c;
                return (
                  <button key={c} onClick={() => setColor(c)} style={{
                    background: active ? meta.hex : '#1a1730',
                    color: active ? meta.ink : '#ccc',
                    border: `2px solid ${active ? meta.hex : '#3a3050'}`,
                    borderRadius: 8, padding: '10px 12px',
                    fontWeight: 700, cursor: 'pointer', fontSize: 12,
                    textTransform: 'uppercase',
                  }}>{c}</button>
                );
              })}
            </div>
          ) : (
            <div style={{ fontSize: 11, opacity: 0.65 }}>
              Using saved deck: <b>{chosenCustom?.name ?? '—'}</b>
              {customInvalid && <span style={{ color: '#c8455d' }}> (invalid — fix in Deck Library)</span>}
            </div>
          )}
        </div>

        {best && (
          <div style={{
            fontSize: 11, opacity: 0.8, padding: '8px 10px',
            background: 'rgba(255,175,58,0.08)', borderRadius: 6,
            border: '1px solid rgba(255,175,58,0.3)',
          }}>
            Today's best ({difficulty}): {best.win ? `✅ won in ${Math.round(best.ms / 1000)}s · ${best.turns} turns` : `❌ lost in ${best.turns} turns`}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            disabled={customInvalid}
            onClick={() => onLaunch({
              difficulty, mode, color,
              customDeck: chosenCustom ? chosenCustom.cards : null,
            })}
            style={{
              flex: 1, background: customInvalid ? '#3a2a4a' : '#6c4bd8', color: '#fff',
              border: 'none', borderRadius: 8, padding: '12px 16px',
              fontWeight: 800, cursor: customInvalid ? 'not-allowed' : 'pointer', fontSize: 14, letterSpacing: 1,
              opacity: customInvalid ? 0.6 : 1,
            }}><ShinyButtonLabel text="START MATCH" /></button>
          <button onClick={onClose} style={{
            background: 'transparent', color: '#aaa',
            border: '1px solid #555', borderRadius: 8,
            padding: '12px 16px', cursor: 'pointer', fontWeight: 600,
          }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// One-time "Add to Home Screen" banner. Listens for Chrome's
// beforeinstallprompt; iOS Safari doesn't fire it, so we surface a textual
// hint there ("tap Share → Add to Home Screen"). Either is dismissable for
// 7 days via localStorage.
function InstallPrompt() {
  const DISMISS_KEY = 'mmtcg.installDismissedUntil';
  const [deferred, setDeferred] = useState<any>(null);
  const [showIos, setShowIos] = useState(false);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Already installed (standalone display) — never show.
    const isStandalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;
    if (isStandalone) return;
    // Honor a recent dismissal.
    const until = Number(localStorage.getItem(DISMISS_KEY) || 0);
    if (until && Date.now() < until) return;

    const onBeforeInstall = (e: any) => {
      e.preventDefault();
      setDeferred(e);
      setHidden(false);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);

    // iOS heuristic: Safari on iOS doesn't fire beforeinstallprompt.
    const ua = window.navigator.userAgent;
    const isIosSafari = /iPad|iPhone|iPod/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS/.test(ua);
    if (isIosSafari) {
      setShowIos(true);
      setHidden(false);
    }

    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall);
  }, []);

  if (hidden) return null;

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now() + 7 * 24 * 3600 * 1000)); } catch {}
    setHidden(true);
  };
  const install = async () => {
    if (!deferred) return;
    try { deferred.prompt(); await deferred.userChoice; } catch {}
    setDeferred(null);
    setHidden(true);
  };

  return (
    <div style={{
      position: 'fixed', left: 12, right: 12, bottom: 12,
      maxWidth: 460, marginLeft: 'auto', marginRight: 'auto',
      background: 'linear-gradient(135deg, #1b1230 0%, #3a1f5a 100%)',
      color: '#fff', border: '1px solid #6c4bd8', borderRadius: 10,
      padding: '10px 12px', zIndex: 90,
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', gap: 10,
      fontFamily: 'Inter, sans-serif', fontSize: 13,
    }}>
      <div style={{ fontSize: 22 }}>📲</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, marginBottom: 2 }}>Install On-Chain Virtual Arena</div>
        <div style={{ fontSize: 11, opacity: 0.85 }}>
          {showIos
            ? 'Tap the Share icon, then "Add to Home Screen" for fullscreen play.'
            : 'Add to your home screen — no browser chrome, faster loads.'}
        </div>
      </div>
      {!showIos && (
        <button onClick={install} style={{
          background: '#6c4bd8', color: '#fff', border: 'none', borderRadius: 6,
          padding: '6px 12px', fontWeight: 700, cursor: 'pointer', fontSize: 12,
        }}>Install</button>
      )}
      <button onClick={dismiss} title="Dismiss for a week" style={{
        background: 'transparent', color: '#aaa', border: 'none',
        fontSize: 18, cursor: 'pointer', padding: 0, lineHeight: 1,
      }}>×</button>
    </div>
  );
}

export default function App() {
  // Print mode: render every card as a 280×400 CardPreview in a grid for offline
  // capture by scripts/render-cards.mjs. Triggered by `#print` or `?print`.
  const printMode = (typeof window !== 'undefined') && (
    window.location.hash.includes('print') ||
    window.location.search.includes('print')
  );
  if (printMode) return <PrintAllCards />;

  const [name, setName] = useState<string>(() => local.get<string>('myName', ''));
  const [seat, setSeat] = useState<Seat | null>(() => local.get<Seat | null>('seat', null));
  const [view, setView] = useState<View>(() => sess.get<View>('view', 'landing'));
  const [pendingWallet, setPendingWallet] = useState<ConnectedWallet | null>(null);
  const [viewedProfile, setViewedProfile] = useState<string | null>(null);
  const [soloSetup, setSoloSetup] = useState<boolean>(false);
  const [soloCfg, setSoloCfg] = useState<{ difficulty: Difficulty; mode: SoloMode; color: Color; customDeck: string[] | null } | null>(null);
  const soloStartRef = useRef<number>(0);

  // Track solo match start/end for daily-best recording. Board fires
  // `mmtcg:solo-end` when a solo match resolves.
  useEffect(() => {
    function onEnd(e: any) {
      if (!soloCfg) return;
      const detail = e?.detail ?? {};
      const win = detail.winnerSeat === '0';
      const turns = Number(detail.turns ?? 0);
      const ms = Date.now() - (soloStartRef.current || Date.now());
      if (soloCfg.mode === 'daily') {
        saveDailyResult({
          date: todayKey(), win, turns, ms,
          difficulty: soloCfg.difficulty,
        });
      }
    }
    window.addEventListener('mmtcg:solo-end', onEnd);
    return () => window.removeEventListener('mmtcg:solo-end', onEnd);
  }, [soloCfg]);

  // On boot: if we have a saved seat from a previous tab, verify the match
  // still exists and our seat is still claimed by us. Otherwise clear it so
  // we don't try to reconnect to a dead match.
  useEffect(() => {
    if (!seat) return;
    let cancelled = false;
    (async () => {
      try {
        const m = await lobby.getMatch(GAME_NAME, seat.matchID);
        if (cancelled) return;
        const slot = (m.players as Array<{ id: number; name?: string }>).find(p => String(p.id) === seat.playerID);
        // If our seat was somehow freed (e.g. server restart) or claimed by someone else
        // with a different name, drop the stale seat.
        if (!slot || (slot.name && slot.name !== seat.playerName)) {
          local.del('seat'); setSeat(null);
        }
      } catch {
        // Match no longer exists.
        local.del('seat'); setSeat(null);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deep-link: ?match=ID auto-joins (or shows lobby with prefill).
  useEffect(() => {
    if (seat || !name) return;
    const hash = window.location.hash;
    const m = hash.match(/match=([\w-]+)/);
    if (!m) return;
    const matchID = m[1];
    (async () => {
      try {
        const info = await lobby.getMatch(GAME_NAME, matchID);
        const players = info.players as Array<{ id: number; name?: string }>;
        // If we're already seated in this match, reuse the saved seat instead of
        // grabbing a new (potentially wrong) one.
        const existingSeat = local.get<Seat | null>('seat', null);
        if (existingSeat && existingSeat.matchID === matchID) {
          sess.set('seat', existingSeat); local.set('seat', existingSeat); setSeat(existingSeat);
          window.history.replaceState(null, '', window.location.pathname);
          return;
        }
        const mineByName = players.find(p => p.name === name);
        if (mineByName) {
          throw new Error('You are already in this match in another tab; close it first or use that tab.');
        }
        const open = players.find(p => !p.name);
        if (!open) throw new Error('Match full');
        await upsertProfileApi(name);
        const joined = await lobby.joinMatch(GAME_NAME, matchID, { playerID: String(open.id), playerName: name });
        const s: Seat = { matchID, playerID: String(open.id), credentials: joined.playerCredentials, playerName: name };
        sess.set('seat', s); local.set('seat', s); setSeat(s);
        window.history.replaceState(null, '', window.location.pathname);
      } catch (e) { console.warn('auto-join failed', e); }
    })();
  }, [name, seat]);

  function login(n: string) {
    sess.set('myName', n); sess.set('lastName', n); local.set('myName', n); local.set('lastName', n); setName(n);
    setPendingWallet(null);
    upsertProfileApi(n).catch(() => {});
    goto('landing');
  }
  function logout() { sess.del('myName'); sess.del('seat'); sess.del('view'); local.del('myName'); local.del('seat'); setName(''); setSeat(null); setPendingWallet(null); setView('landing'); }
  function joinedSeat(s: Seat) { sess.set('seat', s); local.set('seat', s); setSeat(s); }
  function leftSeat() { sess.del('seat'); local.del('seat'); setSeat(null); goto('landing'); }
  function goto(v: View) { sess.set('view', v); setView(v); }

  if (!name) {
    if (pendingWallet) {
      return <FirstTimeProfile
        wallet={pendingWallet}
        onCreated={login}
        onCancel={() => setPendingWallet(null)}
      />;
    }
    return <Login onLogin={login} onFirstTime={setPendingWallet} />;
  }
  if (seat) return <MatchSeat seat={seat} onLeave={leftSeat} />;

  // Landing + Profile share the same audio element so music keeps playing
  // (and the user's mute state is preserved) when switching between them.
  const showMusic = view === 'landing' || view === 'profile' || view === 'rules' || view === 'lobby' || view === 'ranked' || view === 'boosters' || view === 'masterquest';
  return (
    <>
      <InstallPrompt />
      {soloCfg && (
        <SoloClient
          playerName={name || 'Player'}
          difficulty={soloCfg.difficulty}
          mode={soloCfg.mode}
          playerDeckColor={soloCfg.color}
          customDeck={soloCfg.customDeck}
          onExit={() => setSoloCfg(null)}
        />
      )}
      {soloSetup && !soloCfg && (
        <SoloSetupModal
          myName={name}
          onClose={() => setSoloSetup(false)}
          onLaunch={(cfg) => {
            soloStartRef.current = Date.now();
            setSoloCfg(cfg);
            setSoloSetup(false);
          }}
        />
      )}
      {showMusic && <MenuMusic />}
      {view === 'profile'
        ? <ProfilePage myName={name} onBack={() => goto('landing')} />
        : view === 'rules'
          ? <RulebookPage onBack={() => goto('landing')} />
          : view === 'boosters'
            ? <BoostersPage myName={name} onBack={() => goto('landing')} />
            : view === 'masterquest'
              ? <MasterquestPage myName={name} onBack={() => goto('landing')} />
            : view === 'view-profile' && viewedProfile
              ? <PublicProfile name={viewedProfile} onBack={() => goto('lobby')} />
              : view === 'ranked'
                ? <Lobby
                    myName={name}
                    onJoined={joinedSeat}
                    onBack={() => goto('landing')}
                    onViewProfile={n => { setViewedProfile(n); goto('view-profile'); }}
                    onSolo={() => setSoloSetup(true)}
                  />
                : view === 'lobby'
                  ? <Lobby
                      myName={name}
                      onJoined={joinedSeat}
                      onBack={() => goto('landing')}
                      onViewProfile={n => { setViewedProfile(n); goto('view-profile'); }}
                      onSolo={() => setSoloSetup(true)}
                    />
                  : <Landing myName={name} onPlay={() => goto('lobby')} onMasterquest={() => goto('masterquest')} onBoosters={() => goto('boosters')} onProfile={() => goto('profile')} onRules={() => goto('rules')} onLogout={logout} />}
    </>
  );
}

// ── Ranked Queue Panel ─────────────────────────────────────────────────────
// Embedded inside the Lobby so casual + ranked matchmaking live on one page.
// Reuses the Lobby's loaded deck library + selection state.
function RankedQueuePanel({
  myName, decks, selectedDeckId, setSelectedDeckId, selectedDeckCards,
  deckOk, onJoined, setError,
}: {
  myName: string;
  decks: DeckEntry[];
  selectedDeckId: number | null;
  setSelectedDeckId: (id: number) => void;
  selectedDeckCards: string[];
  deckOk: boolean;
  onJoined: (s: Seat) => void;
  setError: (msg: string) => void;
}) {
  const [profile, setProfile] = useState<PublicRankedProfile | null>(null);
  const [region, setRegion] = useState<string>(() => {
    try { return localStorage.getItem('rankedRegion') || 'global'; } catch { return 'global'; }
  });
  const [queued, setQueued] = useState<{ queuedAt: number } | null>(null);
  const [waitMs, setWaitMs] = useState(0);
  const [busy, setBusy] = useState(false);

  // Load profile once on mount (and again whenever the player name changes).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await RankedAPI.profile(myName);
        if (!cancelled) setProfile(p);
      } catch { /* leave profile null — the panel still renders the queue button */ }
    })();
    return () => { cancelled = true; };
  }, [myName]);

  // Poll queue status every 2s while queued. On match-found, auto-join the
  // boardgame.io match and bubble the seat up to the Lobby via onJoined.
  useEffect(() => {
    if (!queued) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await RankedAPI.queueStatus(myName);
        if (cancelled) return;
        setWaitMs(Date.now() - (s.queuedAt ?? Date.now()));
        if (s.match) {
          try {
            const joined = await lobby.joinMatch(GAME_NAME, s.match.matchId, {
              playerID: s.match.seat, playerName: myName,
            });
            setQueued(null);
            onJoined({
              matchID: s.match.matchId,
              playerID: s.match.seat,
              credentials: joined.playerCredentials,
              playerName: myName,
            });
          } catch (e: any) {
            setError(`Ranked match join failed: ${e?.message ?? e}`);
            setQueued(null);
          }
        } else if (!s.queued) {
          setQueued(null);
        }
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message ?? e));
      }
    };
    const id = setInterval(tick, 2000);
    void tick();
    return () => { cancelled = true; clearInterval(id); };
  }, [queued, myName, onJoined, setError]);

  async function joinQueue() {
    if (!deckOk) { setError('Pick a valid 60-card deck before entering the ranked queue.'); return; }
    setBusy(true); setError('');
    try {
      const deckPayload = selectedDeckCards.length > 0 ? JSON.stringify(selectedDeckCards) : undefined;
      const r = await RankedAPI.queueJoin(myName, region, deckPayload);
      if (!('ok' in r) || !r.ok) {
        setError((r as any).error || 'queue failed');
      } else {
        setQueued({ queuedAt: r.queuedAt ?? Date.now() });
        try { localStorage.setItem('rankedRegion', region); } catch {}
      }
    } catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }
  async function leaveQueue() {
    setBusy(true);
    try { await RankedAPI.queueLeave(myName); } catch {}
    setQueued(null); setBusy(false);
  }

  const placementRemaining = profile?.placementMatchesRemaining ?? 10;
  const inPlacements = placementRemaining > 0;
  const totalGames = (profile?.wins ?? 0) + (profile?.losses ?? 0);
  const wr = totalGames > 0 ? Math.round(((profile?.wins ?? 0) / totalGames) * 100) : 0;

  return (
    <div style={{
      padding: 16, borderRadius: 12,
      background: 'linear-gradient(135deg, #161025 0%, #1a1238 100%)',
      border: '1px solid rgba(192,132,252,0.45)',
      boxShadow: '0 0 24px rgba(123,44,191,0.18)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{
          fontFamily: '"Cinzel", "Times New Roman", serif',
          fontSize: 16, fontWeight: 800, letterSpacing: 1.2, color: '#c084fc',
        }}>🏆 RANKED LADDER</div>
        {profile && <RankBadge p={profile} size="sm" />}
      </div>

      {profile ? (
        <div style={{ marginBottom: 12, fontSize: 12, color: '#cfc4ff' }}>
          {inPlacements
            ? <span>Placement matches remaining: <b style={{ color: '#ffb347' }}>{placementRemaining}</b></span>
            : <span><b>{rankLabel(profile)}</b> · {profile.wins}W / {profile.losses}L · {wr}% WR</span>}
        </div>
      ) : (
        <div style={{ marginBottom: 12, fontSize: 12, color: '#888' }}>Loading rank…</div>
      )}

      {!queued ? (
        <>
          {decks.length > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <label style={{ fontSize: 11, color: '#aaa', minWidth: 50 }}>Deck:</label>
              <select
                value={selectedDeckId ?? ''}
                onChange={e => setSelectedDeckId(Number(e.target.value))}
                style={{ flex: 1, padding: '6px 10px', background: '#1a1a1a', color: '#eee', border: '1px solid #444', borderRadius: 4, fontSize: 12 }}
              >
                {decks.map(d => {
                  const valid = validateDeck(d.cards).ok;
                  return (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.cards.length}) {d.isActive ? '★' : ''} {valid ? '' : '⚠'}
                    </option>
                  );
                })}
              </select>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <label style={{ fontSize: 11, color: '#aaa', minWidth: 50 }}>Region:</label>
            <select value={region} onChange={e => setRegion(e.target.value)}
              style={{ flex: 1, padding: '6px 10px', background: '#1a1a1a', color: '#eee', border: '1px solid #444', borderRadius: 4, fontSize: 12 }}>
              <option value="global">Global</option>
              <option value="na">North America</option>
              <option value="eu">Europe</option>
              <option value="ap">Asia Pacific</option>
            </select>
          </div>
          <button
            onClick={joinQueue}
            disabled={busy || !deckOk}
            style={{
              width: '100%', padding: '12px 18px', fontSize: 14,
              borderRadius: 8, border: 'none', fontWeight: 800, letterSpacing: 0.6,
              background: deckOk ? 'linear-gradient(90deg, #7b2cbf, #c084fc)' : '#3a2f6a',
              color: deckOk ? '#fff' : '#888',
              cursor: deckOk ? 'pointer' : 'not-allowed',
            }}
          >🏆  ENTER RANKED QUEUE</button>
          {!deckOk && (
            <div style={{ marginTop: 8, fontSize: 11, color: '#f99', fontStyle: 'italic' }}>
              Pick a valid 60-card deck above to queue.
            </div>
          )}
        </>
      ) : (
        <div style={{ textAlign: 'center', padding: '6px 0' }}>
          <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4, fontFamily: 'serif', letterSpacing: 1.5, textTransform: 'uppercase' }}>Searching for opponent…</div>
          <div style={{
            fontSize: 28, fontWeight: 800, color: '#c084fc',
            fontVariantNumeric: 'tabular-nums',
            fontFamily: '"Cinzel", "Times New Roman", serif',
            textShadow: '0 0 16px rgba(192,132,252,0.5)',
          }}>
            {Math.floor(waitMs / 60000)}:{String(Math.floor((waitMs / 1000) % 60)).padStart(2, '0')}
          </div>
          <div style={{ fontSize: 10, color: '#888', marginTop: 4, fontStyle: 'italic' }}>
            MMR window expands ±50 every 10s
          </div>
          <button onClick={leaveQueue} disabled={busy}
            style={{ marginTop: 10, padding: '6px 14px', background: '#222', color: '#ddd', border: '1px solid #444', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
            Leave Queue
          </button>
        </div>
      )}
    </div>
  );
}

// ── Ranked Hub (legacy, kept for /ranked deep-links) ──────────────────────
function RankBadge({ p, size = 'md' }: { p: { visibleRank: PublicRankedProfile['visibleRank']; division: PublicRankedProfile['division'] }; size?: 'sm'|'md'|'lg' }) {
  const c = tierColors(p.visibleRank);
  const dim = size === 'lg' ? 80 : size === 'sm' ? 32 : 50;
  const fs  = size === 'lg' ? 16 : size === 'sm' ? 9 : 12;
  const roman = p.visibleRank === 'Mythic' ? '' : (['', 'I','II','III','IV'][p.division as number]);
  return (
    <div style={{
      width: dim, height: dim, borderRadius: '50%',
      background: c.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      color: c.fg, fontWeight: 900, lineHeight: 1,
      boxShadow: `0 0 ${size === 'lg' ? 24 : 12}px ${c.glow}`,
      border: '2px solid rgba(0,0,0,0.4)',
      flex: '0 0 auto',
      fontFamily: '"Cinzel", "Times New Roman", serif',
    }}>
      <div style={{ fontSize: fs, letterSpacing: 0.5 }}>{p.visibleRank.slice(0, size === 'sm' ? 3 : 99).toUpperCase()}</div>
      {roman && <div style={{ fontSize: fs - 2, opacity: 0.85, marginTop: 1 }}>{roman}</div>}
    </div>
  );
}

function RankedHub({
  myName, onBack, onJoined, onViewProfile,
}: { myName: string; onBack: () => void; onJoined: (s: Seat) => void; onViewProfile: (n: string) => void }) {
  const mobile = useIsMobile();
  const [profile, setProfile] = useState<PublicRankedProfile | null>(null);
  const [season, setSeason] = useState<{ id: string; name: string; startedAt: number; endsAt: number } | null>(null);
  const [leaders, setLeaders] = useState<LeaderboardEntry[]>([]);
  const [region, setRegion] = useState<string>(() => {
    try { return localStorage.getItem('rankedRegion') || 'global'; } catch { return 'global'; }
  });
  const [queued, setQueued] = useState<{ queuedAt: number } | null>(null);
  const [waitMs, setWaitMs] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deckOk, setDeckOk] = useState(false);
  const [decks, setDecks] = useState<DeckEntry[]>([]);
  const [selectedDeckId, setSelectedDeckId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [p, s, lb] = await Promise.all([
        RankedAPI.profile(myName),
        RankedAPI.season(),
        RankedAPI.leaderboard(50),
      ]);
      setProfile(p);
      setSeason({ id: s.id, name: s.name, startedAt: s.startedAt, endsAt: s.endsAt });
      setLeaders(lb);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  }, [myName]);

  useEffect(() => { refresh(); }, [refresh]);

  // Validate deck up front so we don't let a player queue with an invalid one.
  // Also load the full deck library so the player can pick which deck to queue
  // with BEFORE entering the queue (rather than always using the active deck).
  useEffect(() => {
    (async () => {
      try {
        const list = await listDecksApi(myName);
        setDecks(list);
        const active = list.find(d => d.isActive) ?? list[0];
        if (active) {
          setSelectedDeckId(active.id);
          setDeckOk(validateDeck(active.cards).ok);
        } else {
          // Legacy fallback — no library rows yet, ask the old endpoint.
          const d = await getDeckApi(myName);
          setDeckOk(validateDeck(d).ok);
        }
      } catch { setDeckOk(false); }
    })();
  }, [myName]);

  // Queue status poll — every 2s while in queue.
  useEffect(() => {
    if (!queued) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await RankedAPI.queueStatus(myName);
        if (cancelled) return;
        setWaitMs(Date.now() - (s.queuedAt ?? Date.now()));
        if (s.match) {
          // Match found — auto-join the boardgame.io match.
          try {
            const joined = await lobby.joinMatch(GAME_NAME, s.match.matchId, {
              playerID: s.match.seat, playerName: myName,
            });
            setQueued(null);
            onJoined({
              matchID: s.match.matchId,
              playerID: s.match.seat,
              credentials: joined.playerCredentials,
              playerName: myName,
            });
          } catch (e: any) {
            setError(`Match join failed: ${e?.message ?? e}`);
            setQueued(null);
          }
        } else if (!s.queued) {
          setQueued(null);
        }
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message ?? e));
      }
    };
    const id = setInterval(tick, 2000);
    void tick();
    return () => { cancelled = true; clearInterval(id); };
  }, [queued, myName, onJoined]);

  async function joinQueue() {
    if (!deckOk) { setError('Save a valid 60-card deck on your profile before queueing.'); return; }
    setBusy(true); setError('');
    try {
      // Use the user's pre-queue deck selection. Falls back to active/getDeck.
      let deckPayload: string | undefined;
      try {
        const chosen = decks.find(d => d.id === selectedDeckId);
        const cards = chosen ? chosen.cards : await getDeckApi(myName);
        if (Array.isArray(cards) && cards.length > 0) {
          deckPayload = JSON.stringify(cards);
        }
      } catch { /* server will fall back to stored deck */ }
      const r = await RankedAPI.queueJoin(myName, region, deckPayload);
      if (!('ok' in r) || !r.ok) {
        setError((r as any).error || 'queue failed');
      } else {
        setQueued({ queuedAt: r.queuedAt ?? Date.now() });
        try { localStorage.setItem('rankedRegion', region); } catch {}
      }
    } catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }
  async function leaveQueue() {
    setBusy(true);
    try { await RankedAPI.queueLeave(myName); } catch {}
    setQueued(null); setBusy(false);
  }

  const placementRemaining = profile?.placementMatchesRemaining ?? 10;
  const inPlacements = placementRemaining > 0;
  const totalGames = (profile?.wins ?? 0) + (profile?.losses ?? 0);
  const wr = totalGames > 0 ? Math.round(((profile?.wins ?? 0) / totalGames) * 100) : 0;
  const seasonDaysLeft = season ? Math.max(0, Math.ceil((season.endsAt - Date.now()) / 86400000)) : 0;

  return (
    <Screen
      title="Ranked Ladder"
      right={<button onClick={onBack} style={ghostBtn}>← Back</button>}
    >
      {error && <Banner kind="error">{error}</Banner>}

      <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : '1fr 1fr', gap: 14, marginTop: 14 }}>
        {/* Profile card */}
        <div style={{
          padding: 18, borderRadius: 10,
          background: 'linear-gradient(135deg, #161025 0%, #1a1238 100%)',
          border: '1px solid rgba(192,132,252,0.35)',
        }}>
          {profile ? (
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <RankBadge p={profile} size="lg" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: '#aaa', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'serif', fontWeight: 700 }}>{myName}</div>
                <div style={{
                  fontSize: 22, fontWeight: 800, color: '#fff', marginTop: 4,
                  fontFamily: '"Cinzel", "Times New Roman", serif',
                  letterSpacing: 1, textShadow: '0 0 12px rgba(192,132,252,0.4)',
                }}>
                  {inPlacements ? 'Placement' : rankLabel(profile)}
                </div>
                {!inPlacements && profile.visibleRank !== 'Mythic' && (
                  <div style={{ marginTop: 8, height: 8, background: '#222', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{
                      width: `${profile.rankedPoints}%`, height: '100%',
                      background: tierColors(profile.visibleRank).bg,
                    }} />
                  </div>
                )}
                <div style={{ marginTop: 8, fontSize: 13, color: '#ccc' }}>
                  {inPlacements
                    ? <span>Placement matches remaining: <b style={{ color: '#ffb347' }}>{placementRemaining}</b></span>
                    : <span>{profile.wins}W / {profile.losses}L · {wr}% WR</span>}
                </div>
              </div>
            </div>
          ) : <div style={{ color: '#888' }}>Loading profile…</div>}

          {/* Queue panel */}
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #2a2240' }}>
            {!queued ? (
              <>
                {decks.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                    <label style={{ fontSize: 12, color: '#aaa' }}>Deck:</label>
                    <select
                      value={selectedDeckId ?? ''}
                      onChange={e => {
                        const id = Number(e.target.value);
                        setSelectedDeckId(id);
                        const chosen = decks.find(d => d.id === id);
                        setDeckOk(chosen ? validateDeck(chosen.cards).ok : false);
                      }}
                      style={{ flex: 1, padding: '6px 10px', background: '#1a1a1a', color: '#eee', border: '1px solid #444', borderRadius: 4, fontSize: 13 }}
                    >
                      {decks.map(d => {
                        const valid = validateDeck(d.cards).ok;
                        return (
                          <option key={d.id} value={d.id}>
                            {d.name} ({d.cards.length}) {d.isActive ? '★' : ''} {valid ? '' : '⚠'}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                  <label style={{ fontSize: 12, color: '#aaa' }}>Region:</label>
                  <select value={region} onChange={e => setRegion(e.target.value)} style={{ padding: '6px 10px', background: '#1a1a1a', color: '#eee', border: '1px solid #444', borderRadius: 4, fontSize: 13 }}>
                    <option value="global">Global</option>
                    <option value="na">North America</option>
                    <option value="eu">Europe</option>
                    <option value="ap">Asia Pacific</option>
                  </select>
                </div>
                <button
                  onClick={joinQueue}
                  disabled={busy || !deckOk}
                  style={{
                    ...primaryBtn(!!deckOk && !busy),
                    width: '100%', padding: '12px 18px', fontSize: 16,
                    background: deckOk ? 'linear-gradient(90deg, #7b2cbf, #c084fc)' : '#444',
                    cursor: deckOk ? 'pointer' : 'not-allowed',
                  }}
                >🏆  ENTER RANKED QUEUE</button>
                {!deckOk && (
                  <div style={{ marginTop: 8, fontSize: 12, color: '#f99', fontStyle: 'italic' }}>
                    You need a valid 60-card deck on your Profile before queueing.
                  </div>
                )}
              </>
            ) : (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 13, color: '#aaa', marginBottom: 6, fontFamily: 'serif', letterSpacing: 1.5, textTransform: 'uppercase' }}>Searching for opponent…</div>
                <div style={{
                  fontSize: 32, fontWeight: 800, color: '#c084fc',
                  fontVariantNumeric: 'tabular-nums',
                  fontFamily: '"Cinzel", "Times New Roman", serif',
                  textShadow: '0 0 16px rgba(192,132,252,0.5)',
                }}>
                  {Math.floor(waitMs / 60000)}:{String(Math.floor((waitMs / 1000) % 60)).padStart(2, '0')}
                </div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 4, fontStyle: 'italic' }}>
                  MMR window expands ±50 every 10s
                </div>
                <button onClick={leaveQueue} disabled={busy}
                  style={{ ...ghostBtn, marginTop: 12, padding: '8px 16px' }}>Leave Queue</button>
              </div>
            )}
          </div>
        </div>

        {/* Season + info */}
        <div style={{
          padding: 18, borderRadius: 10,
          background: 'linear-gradient(135deg, #0e1825 0%, #122035 100%)',
          border: '1px solid #2a3a5a',
        }}>
          <div style={{ fontSize: 12, color: '#7fb', textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'serif', fontWeight: 700 }}>Current Season</div>
          <div style={{
            fontSize: 20, fontWeight: 800, color: '#fff', marginTop: 4,
            fontFamily: '"Cinzel", "Times New Roman", serif',
            letterSpacing: 1,
          }}>{season?.name ?? '—'}</div>
          <div style={{ fontSize: 13, color: '#aaa', marginTop: 4, fontStyle: 'italic' }}>
            {seasonDaysLeft} days remaining
          </div>
          <div style={{ marginTop: 14, fontSize: 12, color: '#bbb', lineHeight: 1.7 }}>
            <div><b style={{ color: '#fff' }}>Hidden MMR:</b> The matchmaker uses a hidden Glicko-2 rating you never see.</div>
            <div style={{ marginTop: 4 }}><b style={{ color: '#fff' }}>Placements:</b> 10 games to lock in your starting rank.</div>
            <div style={{ marginTop: 4 }}><b style={{ color: '#fff' }}>Soft Reset:</b> Each season your MMR collapses halfway toward 1500.</div>
            <div style={{ marginTop: 4 }}><b style={{ color: '#fff' }}>Rewards:</b> Cosmetics only — no gameplay advantages.</div>
          </div>

          {/* Season prize callout */}
          <div style={{
            marginTop: 14, padding: 12, borderRadius: 8,
            background: 'linear-gradient(135deg, rgba(255,179,71,0.16) 0%, rgba(192,132,252,0.18) 100%)',
            border: '1px solid rgba(255,179,71,0.55)',
            boxShadow: '0 0 18px rgba(255,179,71,0.18)',
          }}>
            <div style={{
              fontSize: 11, color: '#ffd86a', textTransform: 'uppercase', letterSpacing: 2,
              fontFamily: 'serif', fontWeight: 800, marginBottom: 6,
            }}>
              👑  Season Champion Prize
            </div>
            <div style={{
              fontFamily: '"Cinzel", "Times New Roman", serif',
              fontSize: 18, fontWeight: 800, color: '#fff', letterSpacing: 0.5,
              textShadow: '0 0 12px rgba(255,179,71,0.45)',
            }}>
              $1,000 of $MASTER
            </div>
            <div style={{
              fontFamily: '"Cinzel", "Times New Roman", serif',
              fontSize: 14, fontWeight: 700, color: '#ffd86a', marginTop: 2,
            }}>
              + Season Champion Title
            </div>
            <div style={{ fontSize: 11, color: '#bbb', marginTop: 6, fontStyle: 'italic' }}>
              Awarded to the #1 player on the Season Leaderboard at season end.
            </div>
          </div>
        </div>
      </div>

      {/* Leaderboard */}
      <Section title="Season Leaderboard" right={<button onClick={refresh} style={ghostBtn}>↻</button>}>
        {leaders.length === 0
          ? <div style={{ color: '#888', fontSize: 13, fontStyle: 'italic' }}>No ranked players yet — be the first.</div>
          : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ color: '#888', textAlign: 'left', fontFamily: 'serif', textTransform: 'uppercase', letterSpacing: 1.2, fontSize: 11 }}>
                    <th style={{ padding: '6px 8px', width: 40 }}>#</th>
                    <th style={{ padding: '6px 8px' }}>Player</th>
                    <th style={{ padding: '6px 8px' }}>Rank</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>W/L</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>WR</th>
                  </tr>
                </thead>
                <tbody>
                  {leaders.map(l => {
                    const games = l.wins + l.losses;
                    const lwr = games > 0 ? Math.round((l.wins / games) * 100) : 0;
                    const isMe = l.playerId === myName;
                    return (
                      <tr key={l.playerId}
                          onClick={() => onViewProfile(l.playerId)}
                          style={{
                            cursor: 'pointer',
                            background: isMe ? 'rgba(192,132,252,0.12)' : (l.rank % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent'),
                            borderTop: '1px solid #1a1a1a',
                          }}>
                        <td style={{ padding: '8px', fontWeight: 800, color: l.rank <= 3 ? '#ffd86a' : '#888', fontFamily: '"Cinzel", "Times New Roman", serif' }}>
                          {l.rank}
                        </td>
                        <td style={{ padding: '8px', color: '#fff', fontWeight: 600 }}>
                          {l.playerId}{isMe && <span style={{ color: '#c084fc', marginLeft: 6, fontStyle: 'italic', fontWeight: 400 }}>(you)</span>}
                        </td>
                        <td style={{ padding: '8px' }}>
                          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                            <RankBadge p={l} size="sm" />
                            <span style={{ fontFamily: '"Cinzel", "Times New Roman", serif', fontSize: 12, letterSpacing: 0.5 }}>{rankLabel(l)}</span>
                          </span>
                        </td>
                        <td style={{ padding: '8px', textAlign: 'right', color: '#ccc', fontVariantNumeric: 'tabular-nums' }}>{l.wins}/{l.losses}</td>
                        <td style={{ padding: '8px', textAlign: 'right', color: '#ccc', fontVariantNumeric: 'tabular-nums' }}>{lwr}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </Section>
    </Screen>
  );
}

// ── Tiny UI primitives ──────────────────────────────────────────────────────
function Screen({ title, right, children, fullBleed }: { title: string; right?: React.ReactNode; children: React.ReactNode; fullBleed?: boolean }) {
  const mobile = useIsMobile();
  const pad = fullBleed ? 0 : (mobile ? 12 : 24);
  return (
    <div style={{ fontFamily: 'system-ui', background: '#000', minHeight: '100vh', padding: pad, color: '#eee' }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: fullBleed ? 0 : 16, gap: 8, flexWrap: 'wrap',
        padding: fullBleed ? (mobile ? '8px 12px' : '10px 18px') : 0,
        position: fullBleed ? 'absolute' : 'static',
        top: 0, left: 0, right: 0, zIndex: 4,
        background: fullBleed ? 'linear-gradient(180deg, rgba(0,0,0,0.55), rgba(0,0,0,0))' : 'transparent',
      }}>
        <h1 style={{ margin: 0, fontSize: mobile ? 18 : 22, textShadow: fullBleed ? '0 2px 8px #000' : undefined }}>{title}</h1>
        <div>{right}</div>
      </div>
      {children}
    </div>
  );
}
function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 18, padding: 14, background: '#0f0f0f', border: '1px solid #2a2a2a', borderRadius: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontWeight: 700, color: '#ccc', fontSize: 14 }}>{title}</div>
        <div>{right}</div>
      </div>
      {children}
    </div>
  );
}
function Banner({ kind, children }: { kind: 'error' | 'info'; children: React.ReactNode }) {
  const bg = kind === 'error' ? '#3a0a0a' : '#0a2a3a';
  const bd = kind === 'error' ? '#844' : '#488';
  return <div style={{ padding: 10, background: bg, border: `1px solid ${bd}`, color: '#eee', borderRadius: 4, fontSize: 13, marginTop: 8 }}>{children}</div>;
}
// ── Wager helpers ───────────────────────────────────────────────────────────
// Wagers are denominated in $MASTER (Solana SPL token).
export const MASTER_TOKEN_ADDRESS = 'DpPowzjETiU6421ReuwBB8XmDB7sMyB2JGzFLssYpump';
export const SOLANA_RPC_URL =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SOLANA_RPC) ||
  'https://api.mainnet-beta.solana.com';

type Wager = { kind: 'free' } | { kind: 'master'; amount: number; onchainId?: string; mode?: 'custodial' };

function parseWager(kind: 'free' | 'master', raw: string): Wager | null {
  if (kind === 'free') return { kind: 'free' };
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return null;
  // $MASTER amounts are whole tokens (no fractional UI for now).
  return { kind: 'master', amount: Math.round(n) };
}

function readWager(setupData: any): Wager {
  const w = setupData?.wager;
  if (w && w.kind === 'free') return { kind: 'free' };
  if (w && w.kind === 'master' && typeof w.amount === 'number') {
    return { kind: 'master', amount: w.amount, onchainId: w.onchainId, mode: 'custodial' };
  }
  // Back-compat: legacy 'sol' wagers map to the new 'master' kind so that
  // matches created before the rebrand still display correctly.
  if (w && w.kind === 'sol' && typeof w.amount === 'number') {
    return { kind: 'master', amount: w.amount };
  }
  return { kind: 'free' };
}

function readMatchName(setupData: any): string {
  const n = setupData?.matchName;
  return typeof n === 'string' ? n.trim().slice(0, 40) : '';
}

function wagerLabel(w: Wager): string {
  return w.kind === 'free' ? 'Free Match' : `Wager · ${w.amount} $MASTER`;
}

function WagerControls({
  kind, amount, onKind, onAmount, compact,
}: {
  kind: 'free' | 'master'; amount: string;
  onKind: (k: 'free' | 'master') => void; onAmount: (s: string) => void;
  compact?: boolean;
}) {
  const Btn = ({ k, label }: { k: 'free' | 'master'; label: string }) => {
    const sel = kind === k;
    return (
      <button type="button" onClick={() => onKind(k)} style={{
        flex: 1, padding: compact ? '4px 6px' : '6px 8px', fontSize: 11, fontWeight: 800,
        background: sel ? '#f1e3a8' : 'transparent',
        color: sel ? '#1a1408' : '#e9e4d0',
        border: '1px solid rgba(180,150,80,0.55)', borderRadius: 3, cursor: 'pointer',
        letterSpacing: 0.5, textTransform: 'uppercase',
      }}>{label}</button>
    );
  };
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6, marginTop: compact ? 6 : 10,
      background: 'rgba(10,12,20,0.7)', padding: '6px 10px',
      border: '1px solid rgba(180,150,80,0.35)', borderRadius: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, color: '#c9b97a', minWidth: 50 }}>STAKES</span>
        <Btn k="free"   label="Free" />
        <Btn k="master" label="Wager · $MASTER" />
      </div>
      {kind === 'master' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: '#c9b97a', minWidth: 50 }}>AMOUNT</span>
          <input
            type="number" inputMode="numeric" min={0} step={1}
            value={amount}
            onChange={e => onAmount(e.target.value)}
            placeholder="1000"
            style={{
              flex: 1, padding: '4px 8px', fontSize: 12, fontWeight: 700,
              background: '#000', color: '#f1e3a8',
              border: '1px solid rgba(180,150,80,0.55)', borderRadius: 3,
            }}
          />
          <span style={{ fontSize: 11, color: '#c9b97a', fontWeight: 700 }}>$MASTER</span>
        </div>
      )}
    </div>
  );
}

function ColorChooser({ label, value, onChange }: { label: string; value: Color; onChange: (c: Color) => void }) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {COLOR_ORDER.map(c => {
          const sel = value === c; const meta = COLOR_META[c];
          return (
            <button key={c} onClick={() => onChange(c)}
              style={{
                padding: '6px 10px',
                background: sel ? meta.hex : '#181818',
                color: sel ? (meta.ink === '#fff' ? '#fff' : '#000') : meta.hex,
                border: `2px solid ${meta.hex}`,
                borderRadius: 4, fontWeight: 700, cursor: 'pointer', fontSize: 12,
              }}>{meta.name}</button>
          );
        })}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { fontSize: 11, color: '#888', marginBottom: 4 };
const inputStyle: React.CSSProperties = { flex: 1, padding: '8px 10px', background: '#000', color: '#eee', border: '1px solid #444', borderRadius: 4, fontSize: 14, minWidth: 200 };
const cardStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: 10, background: '#181818', border: '1px solid #2a2a2a', borderRadius: 4 };
const primaryBtn = (enabled: boolean): React.CSSProperties => ({
  padding: '8px 16px', background: enabled ? '#2a7' : '#333', color: '#fff',
  border: 'none', borderRadius: 4, cursor: enabled ? 'pointer' : 'not-allowed', fontWeight: 700, fontSize: 13,
});
const ghostBtn: React.CSSProperties = { padding: '6px 12px', background: '#222', color: '#ddd', border: '1px solid #444', borderRadius: 4, cursor: 'pointer', fontSize: 12 };
const disabledBtn: React.CSSProperties = { padding: '8px 16px', background: '#222', color: '#666', border: '1px solid #333', borderRadius: 4, cursor: 'not-allowed', fontSize: 13 };
// formatRecord re-exported for any other consumer; not used here.
export { formatRecord };

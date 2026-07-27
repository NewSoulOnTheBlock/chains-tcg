// src/App.tsx
// Online lobby + multiplayer client for Chains TCG.
// Flow: Login -> Lobby (create/join match) -> Waiting room -> Game.
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Client } from 'boardgame.io/react';
import { SocketIO } from 'boardgame.io/multiplayer';
import { Plaza } from './Plaza';
import { ChainsTCG } from './Game';
import { ChainsBoard } from './Board';
import { CARDS, COLOR_META, COLORS, STARTER_DECKS, BUILDABLE_CARDS, validateDeck, DECK_SIZE, MAX_COPIES_NONBASIC, isBasicNode, type Color, type CardType, type CardDef, type DeckIssue, type DeckValidation } from './cards';
import { ChainLogo } from './chain-logos';
import {
  listProfilesApi, getProfileApi, getMyProfileApi, updateMyProfileApi, getMatchHistoryApi,
  formatRecord, type Profile,
  listDecksApi, createDeckApi, updateDeckApi, deleteDeckApi, activateDeckApi, type DeckEntry,
} from './profiles';
import {
  auth, decks as decksApi, lobby as lobbyApi, session as sessionApi,
  ApiError, SOCKET_URL,
  type AuthChain, type LobbyEntry, type MatchMode, type OwnProfile, type SeatInfo,
} from './api';
import { errorText, errorHeadline, errorIssues, isDeckBlocked, isHostDeckUnowned } from './error-text';
// The competitive ladder is LIVE on `/games/ranked/*`. `ranked-client.ts` is a
// real typed client again — the transport lives in `src/api/ranked.ts` and the
// pure bits (tier colours, LP labels, the placement gate, the season countdown
// and the queue state machine) live alongside it. There is no availability gate
// any more; nothing here should be checking for one.
import {
  IDLE_QUEUE, LEADERBOARD_EMPTY_BODY, LEADERBOARD_EMPTY_TITLE, RankedAPI,
  classifyQueueError, formatEndReason, formatLp, formatLpDelta, formatRankLabel,
  formatRankedRecord, formatWait, leaderboardIsEmpty, placementBlurb, placementLabel,
  queueDepthLabel, queueElapsedMs, queuePollDelayMs, queueReducer, rankedWinRate,
  seasonProgressPct, seasonRemaining, standingOf, tierIndex, tierStyle,
  type OwnRankedProfile, type QueueState, type RankedLeaderboard, type RankedMatchEntry,
  type RankedStanding, type SeasonInfo,
} from './ranked-client';
import { connectRobinhoodChain, detectEvmWallet, shortAddr, ROBINHOOD_CHAIN } from './wallet';
// Blockscout's host, so the token link is never a hardcoded URL.
import { ROBINHOOD_EXPLORER_URL } from './pack-evm';
// Card ownership is SERVER state now (`src/api/collection.ts`). `useCollection`
// is a subscription to the cached snapshot; `ownershipIssues` mirrors the
// server's ranked/wager seating check. Ownership is shown in the deck builder,
// never enforced there — casual and solo are deliberately ungated.
import { useCollection, ownershipIssues, ownedCount, ownershipKnown, refreshCollection, syncCollection } from './collection';
// Which modes the lobby offers (casual + ranked; wager is deliberately absent)
// and whether the active deck would survive the server's ranked ownership check.
import {
  OFFERED_MODES, MODE_LABEL, MODE_BLURB, evaluateRankedDeck, shortfallLines, pickQuickMatch,
  type OfferedMode, type RankedEligibility,
} from './match-mode';
import { color as C, font as F, surface as SURF, edge as EDGE, depth as DEPTH } from './theme';
import { Button as UIButton, goldPlate, obsidianPlate, engravedPanel } from './ui';
import { SettingsPage, PREFS_EVENT } from './Settings';
import {
  ArrowRight, ArrowLeft, ArrowUp, ArrowUpRight, ArrowDown, ChevronRight, ChevronDown,
  Close, Check, Plus, Refresh, Play, Search, Copy, External, Edit as EditIcon,
  Trash, Save, Folder, Swords, Shield, ShieldCheck, Skull, Heart, Bolt, Fire, Robot,
  Wizard, Ghost, Cards, Deck as DeckIcon, Target, Gamepad, Trophy, Star,
  StarOutline, Crown, Gem, Coins, Chart, Castle, Temple, Book, Books, Globe, Moon, Orb, Medal,
  Link as LinkIcon, Chain, Warning, Info, Lock, User, Settings, Tools,
  Mobile, Fox, Backpack, Diamond, DiamondOutline, Dot, SoundOn, SoundOff, Music,
  Hourglass, EnterKey, Lizard, GridView, ListView, MedalFirst,
  Hand, Dice, Icon, type IconKey,
} from './icons';
import { CardHover, CardPreview } from './CardPreview';
import { SoloClient } from './SoloClient';
import type { Difficulty } from './bot';
import type { SoloMode } from './SoloClient';
import { saveDailyResult, todayKey, todayBest } from './dailyChallenge';
import { BoostersPage } from './Boosters';
import { MasterquestPage } from './masterquest/MasterquestPage';
import ShinyText, { ShinyBrand, ShinyButtonLabel } from './ShinyText';
// PixelTrail is lazy-loaded — it pulls in three + r3f + drei (~240KB
// gzipped), which we don't want in the in-game bundle. Loaded on demand
// only when the Landing screen mounts.
const PixelTrail = React.lazy(() => import('./PixelTrail'));
import SideRays from './SideRays';
import Iridescence from './Iridescence';

// ── Config ──────────────────────────────────────────────────────────────────
// There is no same-origin server any more. The API lives on its own origin
// (`VITE_API_BASE`, see `src/api/config.ts` and `.env.development` /
// `.env.production`), and the boardgame.io socket transport sits on that same
// gateway origin at `/socket.io/`.
//
// boardgame.io's LOBBY REST API is not mounted server-side at all — no
// `GET /games/chains-tcg`, no `/create`, no `/join`, no `/playAgain`. Every
// lobby operation goes through `lobbyApi` (`src/api/lobby.ts`).
const COLOR_ORDER: Color[] = ['bnb', 'sol', 'eth', 'robinhood', 'base'];

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

/**
 * `true` once the ownership snapshot has finished its FIRST read.
 *
 * `useCollection()` hydrates synchronously from the cached snapshot, so while
 * the opening `GET /wager/collection` is in flight a player whose cards are
 * about to arrive still reads as "we have never looked". That is a real state,
 * but it is not one we know yet — and rendering it flashes "collection not
 * scanned" at somebody whose collection is fine.
 *
 * Latching on the first settle fixes that. A LATER chain scan does not
 * un-latch it: by then the advisory is already showing its own "Scanning…"
 * and blanking the panel would just make it jump.
 */
function useCollectionSettled(collection: { loading: boolean }): boolean {
  const settled = useRef(false);
  // A latch, so writing it during render is idempotent and safe.
  if (!collection.loading) settled.current = true;
  return settled.current;
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

/**
 * The player's seat in a match.
 *
 * `playerID` and `credentials` are BOTH NULL until an opponent joins: while the
 * match is `open` the server has not materialised a boardgame.io match yet, so
 * `GET /games/:id/seat` returns `credentials: null` and omits `playerID`
 * entirely. `MatchSeat` polls until they arrive and only then mounts the
 * socket client.
 *
 * `seat` is a NUMBER (0 | 1); `playerID` is boardgame.io's STRING form of the
 * same value. They are not interchangeable.
 */
type Seat = {
  matchID: string;
  seat: 0 | 1;
  playerID: '0' | '1' | null;
  credentials: string | null;
  playerName: string;
};

/** Build a `Seat` from whatever `GET /games/:id/seat` returned. */
function seatFrom(info: SeatInfo, playerName: string): Seat {
  return {
    matchID: info.matchID,
    seat: info.seat,
    playerID: info.playerID ?? null,
    credentials: info.credentials,
    playerName,
  };
}

/**
 * The chain slug sent to `/auth/nonce`, i.e. the server's IDENTITY NAMESPACE.
 *
 * This is `robinhood` — Robinhood Chain, EIP-155 4663, the only network the
 * game runs on — and it is no longer hardcoded at the call site: `signIn()`
 * below derives the slug from the chain id the wallet reports AFTER the network
 * switch, and refuses to sign anything if that is not 4663. This constant is
 * the expected answer, checked against, not asserted.
 *
 * A profile is keyed on `(address, chain)`, so the slug is half the identity.
 * It used to be `ethereum` as a stand-in, which meant the message the user read
 * said "Chain ID: 1" while their wallet sat on 4663 and every account was filed
 * under a chain the app never touches. Backend migration 0009 moved those rows
 * to `robinhood`. Do not change this again without a matching migration.
 */
const SIGN_IN_CHAIN: AuthChain = auth.APP_AUTH_CHAIN;

// ── Login screen ────────────────────────────────────────────────────────────
//
// Identity is a WALLET SIGNATURE. There is no name field, no guest mode, no
// `?name=` deep link and nothing read out of storage: the only way in is
//
//   connect wallet → server mints a challenge → wallet signs it VERBATIM
//                  → server returns a token pair
//
// `auth.signIn()` (src/api/auth.ts) owns the three-step handshake; this
// component owns only the wallet CONNECTION and the chain choice.
//
// The chain slug is the server's own: robinhood | ethereum | base | arbitrum |
// polygon | solana. There is no `evm` — `src/wallet.ts` uses that coarser word
// for provider selection. This app uses `robinhood`, and derives it from the
// wallet's real chain id rather than naming it, so the message the user reads
// ("Chain ID: 4663") always describes the network they are actually on.

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

function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [err, setErr] = useState('');
  const [stage, setStage] = useState<'idle' | 'connecting' | 'signing'>('idle');
  const [remember, setRemember] = useState(false);

  // "Remember me on this device" is the ONLY way the refresh token reaches
  // localStorage. The default is sessionStorage — one tab, gone when it closes
  // — because the refresh token is the long-lived credential and leaving it in
  // localStorage is exactly the finding (M-4) this migration exists to fix.
  useEffect(() => {
    sessionApi.setPersistence(remember ? 'local' : 'session');
  }, [remember]);

  /**
   * Connect the wallet on Robinhood Chain, then sign the server's challenge.
   *
   * `connectRobinhoodChain()` switches (or adds) the network and does not
   * return until it has read `eth_chainId` back and confirmed 4663, so a user
   * who declines the switch gets a clear error here instead of a signature over
   * a message describing a network they are not on.
   *
   * The slug then comes FROM that chain id, not from a constant. It is the
   * server's identity namespace — `core.profiles` is `UNIQUE (address, chain)`
   * — as well as the `Chain ID:` line the user reads, and the two must agree.
   * The `!== SIGN_IN_CHAIN` check is belt and braces: `connectRobinhoodChain()`
   * already guarantees it, and if that ever regresses this refuses to sign
   * rather than quietly minting a second identity for the same wallet.
   */
  async function signIn() {
    setErr(''); setStage('connecting');
    try {
      const { address, chainId } = await connectRobinhoodChain();
      const chain = auth.authChainForEvmChainId(chainId);
      if (chain === null || chain !== SIGN_IN_CHAIN) {
        throw new Error(
          `Wrong network: your wallet is on chain ${chainId}. Switch to Robinhood Chain (${ROBINHOOD_CHAIN.chainId}) and try again.`,
        );
      }
      setStage('signing');
      await auth.signIn({ address, chain });
      onSignedIn();
    } catch (e) {
      setErr(loginErrorText(e));
    } finally { setStage('idle'); }
  }

  // ── Login-screen theme music ─────────────────────────────────────────────
  // Browsers block autoplay-with-sound until the user interacts. Strategy:
  //   1. Mount the <audio>, attempt to play() immediately.
  //   2. If the promise rejects (autoplay policy), wait for the first
  //      pointerdown anywhere on the screen and retry.
  //   3. Always render a sound-on / sound-off toggle so the user can mute.
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
    return () => { a.pause(); setPlaying(false); };
  }, []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = muted;
    local.set('loginMuted', muted);
  }, [muted]);

  const mobile = useIsMobile();
  const evm = detectEvmWallet();
  const busy = stage !== 'idle';
  const label = stage === 'connecting' ? 'Connecting…' : 'Confirm in your wallet…';

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'auto', background: '#07060f', fontFamily: F.body, color: '#F8F8F8' }}>
      <audio ref={audioRef} src="/login-theme.mp3" loop preload="auto" style={{ display: 'none' }} />
      <img src="/login-splash.png?v=2" alt="" draggable={false}
        style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center', userSelect: 'none', zIndex: 0 }} />
      <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 1, background: mobile
        ? 'linear-gradient(180deg, rgba(7,6,15,0.10) 0%, rgba(7,6,15,0.55) 55%, rgba(7,6,15,0.96) 100%)'
        : 'radial-gradient(55% 55% at 50% 66%, rgba(7,6,15,0.72), transparent 72%), linear-gradient(180deg, rgba(7,6,15,0.28), rgba(7,6,15,0.5))' }} />
      <button onClick={() => setMuted(m => !m)} aria-label={muted ? 'Unmute' : 'Mute'} style={{
        // Left edge, vertically centred — clear of the sign-in card in the
        // middle of the screen and of the notch/safe area at the top.
        position: 'fixed', top: '50%', transform: 'translateY(-50%)',
        left: 'max(14px, env(safe-area-inset-left))', zIndex: 5, width: 44, height: 44, borderRadius: 22,
        background: 'rgba(10,5,30,0.6)', border: '1px solid rgba(212,175,55,0.45)', color: '#D4AF37', fontSize: 17, cursor: 'pointer',
        backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      }}>{muted ? <SoundOff size={18} /> : (playing ? <SoundOn size={18} /> : <Music size={18} />)}</button>

      <div style={mobile ? {
        position: 'relative', zIndex: 2, marginTop: '42vh',
        padding: '18px 16px calc(20px + env(safe-area-inset-bottom))',
        display: 'flex', flexDirection: 'column', gap: 10,
      } : {
        position: 'absolute', zIndex: 2, left: '50%', top: '64%', transform: 'translate(-50%,-50%)',
        width: 'min(460px, calc(100vw - 40px))', display: 'flex', flexDirection: 'column', gap: 12,
        background: 'rgba(12,10,26,0.72)', border: '1px solid rgba(150,120,255,0.22)', borderRadius: 18,
        padding: 26, backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', boxShadow: '0 24px 70px rgba(0,0,0,0.55)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 2 }}>
          <div style={{ color: '#b794f6', letterSpacing: 3, fontWeight: 800, fontSize: 14 }}>‹ SIGN IN WITH YOUR WALLET ›</div>
          <div style={{ color: '#9a94ad', fontSize: 12, marginTop: 4 }}>
            You will be asked to sign a short message. It is free and moves no funds.
          </div>
        </div>

        <button className="ocva-btn" disabled={busy}
          onClick={() => evm.installed ? signIn() : window.open('https://metamask.io/download/', '_blank', 'noopener')}
          style={{ width: '100%', padding: '15px', fontSize: 15, background: 'linear-gradient(135deg,#F6851B,#E2761B)', color: '#1a1408' }}>
          <Fox size={18} /> {busy ? label : (evm.installed ? `Sign in with ${evm.label}` : 'Install MetaMask')}
        </button>

        <div style={{ fontSize: 11, color: '#8f89a3', textAlign: 'center', lineHeight: 1.55 }}>
          Your wallet will be switched to <b style={{ color: '#c8c2d8' }}>Robinhood Chain</b> (4663).
          The game runs on this network only.
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12, color: '#9a94ad', cursor: 'pointer', padding: '6px 2px' }}>
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} disabled={!!busy}
            style={{ width: 16, height: 16, accentColor: '#8A2BE2' }} />
          Remember me on this device
        </label>
        <div style={{ fontSize: 10.5, color: '#6f6a80', marginTop: -6, lineHeight: 1.45 }}>
          Off by default: your session lives in this tab only and ends when you close it.
        </div>

        {err && (
          <div role="alert" style={{ textAlign: 'center', fontSize: 12.5, color: '#ffb8b8', marginTop: 2, lineHeight: 1.5 }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Sign-in failures deserve slightly warmer copy than the generic mapper: the
 * most common one by far is the user closing the wallet popup, and the raw
 * provider text for that ("User rejected the request.") reads like a fault.
 */
function loginErrorText(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 4001) return 'Signature cancelled. Approve the message in your wallet to sign in.';
  if (e instanceof ApiError && e.status === 401) {
    return 'That signature was not accepted. Try again — the challenge may have expired.';
  }
  return errorText(e);
}

// ── Background music player (used for menu + battle tracks) ────────────────
function BgMusic({ src, storageKey }: { src: string; storageKey: string }) {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [muted, setMuted] = useState<boolean>(() => {
    try { return localStorage.getItem(storageKey) === '1'; } catch { return false; }
  });

  // This track is silent when either its own flag or the master mute is set.
  // Several screens blanket-assign `.muted` to every <audio> when the master
  // mute changes, which would otherwise un-mute a track the player had
  // individually silenced — so we re-assert from storage rather than trusting
  // the element's current value.
  const applyMute = useCallback(() => {
    const a = audioRef.current; if (!a) return;
    let own = false, master = false;
    try {
      own = localStorage.getItem(storageKey) === '1';
      master = localStorage.getItem('ocva.muted') === '1';
    } catch { /* storage blocked */ }
    a.muted = own || master;
  }, [storageKey]);

  useEffect(() => {
    const a = audioRef.current; if (!a) return;
    a.volume = 0.35;
    applyMute();
    a.play().catch(() => { /* autoplay blocked until user gesture */ });
  }, [muted, applyMute]);

  useEffect(() => {
    const kick = () => { audioRef.current?.play().catch(() => {}); };
    window.addEventListener('pointerdown', kick, { once: true });
    return () => window.removeEventListener('pointerdown', kick);
  }, []);

  // The Settings page (and the per-screen master-mute buttons) write these same
  // keys. Re-read on the change event — and on `storage`, i.e. another tab — so
  // the controls never drift apart.
  useEffect(() => {
    const sync = () => {
      try { setMuted(localStorage.getItem(storageKey) === '1'); } catch { /* noop */ }
      applyMute();
    };
    window.addEventListener(PREFS_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(PREFS_EVENT, sync); window.removeEventListener('storage', sync); };
  }, [storageKey, applyMute]);

  function toggle() {
    setMuted(m => {
      const next = !m;
      try { localStorage.setItem(storageKey, next ? '1' : '0'); } catch {}
      try { window.dispatchEvent(new CustomEvent(PREFS_EVENT)); } catch {}
      return next;
    });
  }

  return (
    <>
      <audio ref={audioRef} src={src} loop preload="auto" />
      {/* Docked to the vertical centre of the LEFT edge: clears the in-game
          bottom action bar, the top turn banner, and the board's right rail
          (which occupies the opposite edge). z-index sits under that rail (60)
          and under every modal, so it can never cover them. */}
      <button
        onClick={toggle}
        className="ova-plate ova-plate--obsidian ova-edge-stud ova-edge-stud--left"
        aria-label={muted ? 'Unmute music' : 'Mute music'}
        aria-pressed={muted}
        title={muted ? 'Unmute music' : 'Mute music'}
        style={{ zIndex: 50 }}
      >
        <span className="ova-stud-grip" aria-hidden />
        {muted ? <SoundOff size={19} /> : <SoundOn size={19} />}
      </button>
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

/**
 * Rules/rulebook copy stores directional arrows as the ASCII markers `->` and
 * `<-` so no pictograph ever lives in a string literal. This renders them as
 * the shared SVG arrows, keeping the on-screen wording identical.
 */
function arrowize(text: string, keyPrefix = 'a'): React.ReactNode {
  const parts = String(text).split(/(->|<-)/);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    part === '->' ? <ArrowRight key={`${keyPrefix}${i}`} size={13} style={{ margin: '0 4px' }} />
      : part === '<-' ? <ArrowLeft key={`${keyPrefix}${i}`} size={13} style={{ margin: '0 4px' }} />
      : <React.Fragment key={`${keyPrefix}${i}`}>{part}</React.Fragment>);
}

const RULES_NAV: { id: RulesSectionId; label: string; icon: IconKey }[] = [
  { id: 'goal',       label: 'Goal',           icon: 'trophy' },
  { id: 'setup',      label: 'Setup',          icon: 'swords' },
  { id: 'cards',      label: 'Card Types',     icon: 'cards' },
  { id: 'gas',        label: 'Gas System',     icon: 'fuel' },
  { id: 'turn',       label: 'Turn Order',     icon: 'refresh' },
  { id: 'advanced',   label: 'Advanced',       icon: 'book' },
  { id: 'example',    label: 'Example Turn',   icon: 'gamepad' },
  { id: 'cheatsheet', label: 'UI Cheat-sheet', icon: 'keyboard' },
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
    if (!q) return arrowize(text);
    const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
    return text.split(re).map((part, i) =>
      part.toLowerCase() === q.toLowerCase()
        ? <mark key={i} style={{ background: 'rgba(212,175,55,0.45)', color: '#fff', padding: '0 2px', borderRadius: 2 }}>{part}</mark>
        : <React.Fragment key={i}>{arrowize(part, `h${i}`)}</React.Fragment>
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
        <button onClick={onBack} style={ghostBtn}><ArrowLeft size={14} /> Back</button>
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
        ><Search size={15} /> <span style={{ opacity: 0.85 }}>Search</span><kbd style={{
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
          }}><span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}><Bolt size={18} /> LEARN IN 30 SECONDS</span></div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12,
          }}>
            {[
              { n: 1, t: 'Play Nodes',           c: RULES_TOKENS.gold },
              { n: 2, t: 'Nodes make Gas',       c: RULES_TOKENS.purple },
              { n: 3, t: 'Cast Memes',           c: RULES_TOKENS.blue },
              { n: 4, t: 'Attack Opponent',      c: RULES_TOKENS.red },
              { n: 5, t: 'Reduce Life 20 -> 0',  c: RULES_TOKENS.green },
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
                <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{arrowize(s.t, `qs${s.n}`)}</div>
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
                <Icon name={n.icon} size={16} />
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
  goal:       'Reduce your opponent\'s life from 20 -> 0. Last player standing wins.',
  setup:      '5 chains. 60-card deck. Start at 20 life with 7 cards.',
  cards:      'Nodes, Memes, Machines, Moves — your full toolkit.',
  gas:        'Tap Nodes to fuel your spells. Gas drains every turn.',
  turn:       'Untap -> Draw -> Main -> Combat -> End.',
  advanced:   'Summoning sickness, blockers, simultaneous damage, hand size.',
  example:    'Walk through Turn 1 step-by-step.',
  cheatsheet: 'Quick clicks for the in-match UI.',
};

function RuleSection({
  id, icon, title, summary, open, onClickHeader, children, _ref,
}: {
  id: RulesSectionId; icon: IconKey; title: string; summary: string;
  open: boolean; onClickHeader: () => void; children: React.ReactNode;
  _ref?: (el: HTMLDivElement | null) => void;
  // unused props kept for API stability
  onToggle?: () => void; onHeaderClick?: () => void;
}) {
  return (
    <div
      ref={_ref}
      id={`rule-${id}`}
      className="ova-panel-orn"
      style={{
        background: open ? RULES_TOKENS.panelHi : RULES_TOKENS.panel,
        border: `1px solid ${open ? RULES_TOKENS.border : RULES_TOKENS.borderSoft}`,
        borderRadius: 14, overflow: 'hidden',
        boxShadow: open
          ? `${EDGE.topHighlight}, ${DEPTH.panelHi}, 0 0 0 1px ${RULES_TOKENS.goldGlow}44`
          : `${EDGE.topHighlight}, ${DEPTH.panel}`,
        transition: 'background 250ms ease, border-color 250ms ease, box-shadow 250ms ease',
      }}>
      <button onClick={onClickHeader} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 14,
        padding: '16px 18px', background: 'transparent', border: 'none',
        cursor: 'pointer', textAlign: 'left', fontFamily: RULES_FONT,
      }}>
        <span style={{
          width: 42, height: 42, borderRadius: 11, flexShrink: 0,
          background: `linear-gradient(135deg, rgba(212,175,55,0.20), rgba(138,43,226,0.20))`,
          border: `1px solid ${RULES_TOKENS.border}`,
          boxShadow: EDGE.topHighlight,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: RULES_TOKENS.gold,
        }}><Icon name={icon} size={21} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: RULES_HEAD, fontWeight: 700, fontSize: 18,
            letterSpacing: 2, color: RULES_TOKENS.gold,
          }}>{title.toUpperCase()}</div>
          <div style={{ fontSize: 12, color: RULES_TOKENS.mute, marginTop: 2 }}>{arrowize(summary, `s-${id}`)}</div>
        </div>
        <span style={{
          color: RULES_TOKENS.gold, display: 'inline-flex', transition: 'transform 250ms ease',
          transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        }}><ChevronDown size={16} /></span>
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
              alignSelf: 'center', color: RULES_TOKENS.gold, display: 'flex',
              animation: 'rulesArrow 1.6s ease-in-out infinite',
            }}><ArrowRight size={24} /></div>
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
            <li>{highlight('Tap a Node -> +1 Gas of its color.')}</li>
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
            <li>{highlight('Click an untapped Node -> tap for Gas.')}</li>
            <li>{highlight('Click a card in hand -> play it (Moves then ask for a target).')}</li>
            <li>{highlight('Click your own untapped Meme -> mark attacker. Press "Attack with N".')}</li>
            <li>{highlight('During declare blockers -> click your Meme, then click the attacker to block.')}</li>
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
    { name: 'NODE',    icon: 'chain' as IconKey, color: RULES_TOKENS.gold,   short: 'Produces Gas',        details: 'Your "land". Free to play, but only 1 per turn. Tap on a later turn to add 1 Gas of its color to your pool.' },
    { name: 'MEME',    icon: 'frog' as IconKey, color: RULES_TOKENS.purple, short: 'Creature Card',       details: 'Your fighters. Each has Power / Toughness. Attack to deal damage to the opponent. Summoning sick the turn they enter.' },
    { name: 'MACHINE', icon: 'settings' as IconKey, color: RULES_TOKENS.blue,   short: 'Permanent Effect',    details: 'Artifact / enchantment. Stays in play with an ongoing effect until destroyed.' },
    { name: 'AURA',    icon: 'orb' as IconKey, color: RULES_TOKENS.purple, short: 'Enchant a Meme',      details: 'A spell that attaches to a single Meme. Buffs its stats or grants a keyword (haste, lifelink, etc). If the enchanted Meme dies or is bounced, the Aura is destroyed too.' },
    { name: 'MOVE',    icon: 'bolt' as IconKey, color: RULES_TOKENS.red,    short: 'Instant Action',      details: 'A one-shot spell. Resolves immediately, then goes to the graveyard.' },
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
              lineHeight: 1, marginBottom: 8, color: t.color, display: 'flex',
              filter: `drop-shadow(0 0 10px ${t.color})`,
            }}><Icon name={t.icon} size={38} /></div>
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
      <FlowNode icon="chain" label="NODE" color={RULES_TOKENS.gold} />
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
      <FlowNode icon="frog" label="CAST MEME" color={RULES_TOKENS.purple} />
    </div>
  );
}

function FlowNode({ icon, label, color }: { icon: IconKey; label: string; color: string }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 80 }}>
      <div style={{
        width: 60, height: 60, borderRadius: 12, margin: '0 auto 6px',
        background: `radial-gradient(circle, ${color}33, transparent 75%)`,
        border: `1px solid ${color}77`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', color,
        boxShadow: `0 0 20px ${color}55`,
      }}><Icon name={icon} size={28} /></div>
      <div style={{
        fontFamily: RULES_HEAD, fontSize: 11, letterSpacing: 2, fontWeight: 700, color,
      }}>{label}</div>
    </div>
  );
}

function FlowArrow() {
  return (
    <span style={{
      color: RULES_TOKENS.gold, display: 'inline-flex',
      animation: 'rulesArrow 1.6s ease-in-out infinite',
    }}><ArrowRight size={24} /></span>
  );
}

function TurnTimeline({ highlight }: { highlight: (s: string) => React.ReactNode }) {
  const phases = [
    { id: 'untap',  name: 'UNTAP',  icon: 'refresh' as IconKey, color: RULES_TOKENS.blue,   desc: 'Untap your Nodes, Memes, and Machines. Summoning sickness wears off.' },
    { id: 'draw',   name: 'DRAW',   icon: 'cards' as IconKey,   color: RULES_TOKENS.green,  desc: 'Draw 1 card (skipped on the very first turn of the game).' },
    { id: 'main',   name: 'MAIN',   icon: 'settings' as IconKey, color: RULES_TOKENS.gold,  desc: 'Play 1 Node, tap for Gas, cast Memes, Machines, and Moves in any order.' },
    { id: 'combat', name: 'COMBAT', icon: 'swords' as IconKey,  color: RULES_TOKENS.red,    desc: 'Click Memes to attack. Opponent blocks. Damage resolves simultaneously.' },
    { id: 'end',    name: 'END',    icon: 'moon' as IconKey,    color: RULES_TOKENS.purple, desc: 'Unspent Gas evaporates. Discard down to 7 cards.' },
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
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: active === p.id ? '#fff' : p.color,
                boxShadow: active === p.id ? `0 0 20px ${p.color}aa` : 'none',
                animation: active === p.id ? 'rulesPulse 2s ease-out infinite' : 'none',
                transition: 'all 250ms ease',
              }}><Icon name={p.icon} size={21} /></span>
              <span style={{
                fontFamily: RULES_HEAD, fontSize: 10, letterSpacing: 2, fontWeight: 800,
                color: active === p.id ? p.color : RULES_TOKENS.mute,
              }}>{p.name}</span>
            </button>
            {i < phases.length - 1 && (
              <span style={{
                color: RULES_TOKENS.gold, opacity: 0.55, display: 'inline-flex',
              }}><ArrowRight size={18} /></span>
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
        }}><ArrowLeft size={14} /> Previous</button>
        <button onClick={() => setI(v => Math.min(steps.length - 1, v + 1))} disabled={i === steps.length - 1} style={{
          padding: '8px 18px', background: `linear-gradient(180deg, ${RULES_TOKENS.gold}, #8a6a16)`,
          color: '#1a1408', border: 'none', borderRadius: 6,
          fontWeight: 800, fontSize: 13, letterSpacing: 1,
          cursor: i === steps.length - 1 ? 'not-allowed' : 'pointer',
          opacity: i === steps.length - 1 ? 0.4 : 1,
          boxShadow: `0 0 14px ${RULES_TOKENS.goldGlow}`,
        }}>Next <ArrowRight size={14} /></button>
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
    if (!query) return arrowize(text);
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
    return String(text).split(re).map((part, i) =>
      part.toLowerCase() === query.toLowerCase()
        ? <mark key={i} style={{ background: 'rgba(230,196,92,0.4)', color: '#fff', borderRadius: 2, padding: '0 2px' }}>{part}</mark>
        : <React.Fragment key={i}>{arrowize(part, `r${i}`)}</React.Fragment>);
  };
}

interface RBChapter { id: RBId; num: string; title: string; icon: IconKey; accent: string; summary: string; keywords: string[]; search: string; content: (h: HL) => React.ReactNode; }

const RB_CHAPTERS: RBChapter[] = [
  { id: 'goal', num: '01', title: 'Goal', icon: 'trophy', accent: RB.gold,
    summary: 'Reduce your opponent’s life from 20 -> 0. Last player standing wins.',
    keywords: ['life', 'win', 'victory', '20'], search: 'goal life 20 reduce opponent zero win last player standing victory check',
    content: (h) => (
      <div>
        <p style={{ fontSize: 18, fontWeight: 600, color: RB.text, margin: '0 0 8px' }}>
          {h('Reduce your opponent’s life from 20 to 0.')}<br />{h('Last player standing wins.')}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 26, flexWrap: 'wrap', margin: '18px 0 6px' }}>
          <LifeOrb label="Start" value={20} color={RB.success} />
          <div aria-hidden style={{ color: RB.goldBright, display: 'flex' }}><ArrowRight size={30} /></div>
          <LifeOrb label="Win" value={0} color={RB.danger} />
        </div>
        <RuleCallout title="Victory Check" text="If every opponent is at 0 life, the match ends immediately." />
      </div>
    ) },
  { id: 'setup', num: '02', title: 'Setup', icon: 'swords', accent: RB.violet,
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
  { id: 'card-types', num: '03', title: 'Card Types', icon: 'cards', accent: RB.blue,
    summary: 'Nodes, Memes, Machines, and Moves make up your toolkit.',
    keywords: ['node', 'meme', 'machine', 'aura', 'move'], search: 'card types node meme machine aura move creature power toughness permanent one-shot instant enchant',
    content: (h) => <CardTypesGrid highlight={h} /> },
  { id: 'gas-system', num: '04', title: 'Gas System', icon: 'fuel', accent: RB.violet,
    summary: 'Tap Nodes to fuel your cards. Unspent Gas drains every turn.',
    keywords: ['gas', 'mana', 'cost', 'tap', 'node'], search: 'gas mana cost tap node color pool drain end of turn empty mixed fuel',
    content: (h) => (
      <div>
        <p>{h('Nodes generate Gas. Cards cost Gas. Gas drains at end of your turn — spend it or lose it.')}</p>
        <GasFlowViz />
        <ul style={{ marginLeft: 18, marginTop: 10, lineHeight: 1.8 }}>
          <li>{h('Tap a Node -> +1 Gas of its color.')}</li>
          <li>{h('A cost can be one color or mixed.')}</li>
          <li>{h('Unspent Gas evaporates when your turn ends.')}</li>
        </ul>
      </div>
    ) },
  { id: 'turn-order', num: '05', title: 'Turn Order', icon: 'refresh', accent: RB.gold,
    summary: 'Untap -> Draw -> Main -> Combat -> End.',
    keywords: ['turn', 'phase', 'untap', 'draw', 'main', 'combat', 'end'], search: 'turn phase untap draw main combat attack block damage end discard summoning sick haste',
    content: (h) => (
      <div>
        <p style={{ marginTop: 0 }}>{h('Every turn moves through five phases in order.')}</p>
        <TurnTimeline highlight={h} />
      </div>
    ) },
  { id: 'combat', num: '06', title: 'Combat', icon: 'swords', accent: RB.danger,
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
  { id: 'advanced-rules', num: '07', title: 'Advanced Rules', icon: 'book', accent: RB.violet,
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
  { id: 'example-turn', num: '08', title: 'Example Turn', icon: 'gamepad', accent: RB.blue,
    summary: 'Walk through Turn 1 step-by-step.',
    keywords: ['example', 'walkthrough', 'turn 1'], search: 'example turn 1 play purple node tap gain gas cast pepe warrior end walkthrough',
    content: (h) => <ExampleTurn highlight={h} /> },
  { id: 'ui-cheat-sheet', num: '09', title: 'UI Cheat Sheet', icon: 'keyboard', accent: RB.gold,
    summary: 'Quick clicks for the in-match UI.',
    keywords: ['ui', 'click', 'controls', 'buttons'], search: 'ui click node tap card hand play meme attack blocker end turn button cheat sheet controls',
    content: (h) => (
      <div>
        <ul style={{ marginLeft: 18, lineHeight: 1.85 }}>
          <li>{h('Click an untapped Node -> tap for Gas.')}</li>
          <li>{h('Click a card in hand -> play it (Moves then ask for a target).')}</li>
          <li>{h('Click your own untapped Meme -> mark attacker. Press "Attack with N".')}</li>
          <li>{h('During declare blockers -> click your Meme, then click the attacker to block.')}</li>
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
  { n: 5, title: 'Reduce 20 -> 0', sub: 'Last player standing', color: RB.success, to: 'goal' },
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
    // Let <BgMusic> re-assert its own per-track mute after this blanket set.
    try { window.dispatchEvent(new CustomEvent(PREFS_EVENT)); } catch {}
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
              <Book size={15} /> {RB_CHAPTERS.length} chapters · 8 min read
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
        {muted ? <SoundOff size={19} /> : <SoundOn size={19} />}
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
        background: RB.panel, border: `1px solid ${RB.border}`, color: RB.text, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}><ArrowLeft size={14} /> Back</button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden style={{ color: RB.gold, opacity: 0.6, display: 'inline-flex' }}><DiamondOutline size={10} /></span>
        <span style={{ fontFamily: RULES_HEAD, fontWeight: 800, letterSpacing: '0.28em', fontSize: 15, color: RB.gold }}>RULEBOOK</span>
        <span aria-hidden style={{ color: RB.gold, opacity: 0.6, display: 'inline-flex' }}><DiamondOutline size={10} /></span>
      </div>
      <button onClick={onOpenSearch} aria-label="Search rules" style={{ display: 'flex', alignItems: 'center', gap: 8, width: narrow ? 'auto' : 300,
        padding: '9px 12px', borderRadius: 9, background: RB.panel, border: `1px solid ${RB.border}`, color: RB.text2, cursor: 'pointer', fontSize: 13 }}>
        <Search size={15} />
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
            border: `2px solid ${RB.goldBright}`, boxShadow: `0 0 26px ${RB.gold}88`, color: RB.goldBright, paddingLeft: 6 }}><Play size={26} /></span>
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
      <div style={{ textAlign: 'center', fontFamily: RULES_HEAD, fontWeight: 700, letterSpacing: '0.26em', fontSize: 14, color: RB.gold, marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}><DiamondOutline size={10} /> LEARN IN 30 SECONDS <DiamondOutline size={10} /></div>
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
                <div style={{ fontSize: 14, fontWeight: 800, color: s.color }}>{arrowize(s.title, `rq${s.n}`)}</div>
                <div style={{ fontSize: 12, color: RB.text2 }}>{s.sub}</div>
              </span>
            </button>
            {i < RB_QUICKSTART.length - 1 && !phone && <span aria-hidden style={{ alignSelf: 'center', color: RB.gold, opacity: 0.5, flex: 'none', display: 'inline-flex' }}><ArrowRight size={16} /></span>}
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
              <Icon name={c.icon} size={16} />
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
    <section aria-labelledby={`rb-${chapter.id}-title`} className="ova-panel-orn ova-panel-orn--hi"
      style={{ padding: 'clamp(18px, 3vw, 26px)', background: RB.panelActive, borderColor: RB.borderStrong }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14, flexWrap: 'wrap' }}>
        <span aria-hidden style={{ width: 46, height: 46, flex: 'none', borderRadius: 11, display: 'grid', placeItems: 'center', color: RB.goldBright,
          background: 'linear-gradient(135deg, rgba(230,196,92,0.2), rgba(139,92,246,0.2))', border: `1px solid ${RB.border}` }}><Icon name={chapter.icon} size={23} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.16em', color: RB.gold }}>CHAPTER {chapter.num}</div>
          <h2 id={`rb-${chapter.id}-title`} style={{ margin: 0, fontFamily: RULES_HEAD, fontWeight: 700, fontSize: 'clamp(22px, 5vw, 28px)', color: RB.text }}>{chapter.title}</h2>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onPrev} disabled={idx === 0} className="rb-anim" style={navBtn(idx === 0)}><ArrowLeft size={13} /> Previous</button>
          <button onClick={onNext} disabled={idx === total - 1} className="rb-anim" style={navBtn(idx === total - 1, true)}>Next <ArrowRight size={13} /></button>
        </div>
      </div>
      <div style={{ fontSize: 15, lineHeight: 1.7, color: RB.text }}>{chapter.content(h)}</div>
    </section>
  );
}
function navBtn(disabled: boolean, primary?: boolean): React.CSSProperties {
  if (primary && !disabled) return { ...goldPlate(false), padding: '10px 16px', fontSize: 12, letterSpacing: '0.1em' };
  return { ...obsidianPlate(disabled), padding: '10px 15px', fontSize: 12.5, whiteSpace: 'nowrap',
    cursor: disabled ? 'not-allowed' : 'pointer' };
}

function RuleAccordion({ chapter, onOpen }: { chapter: RBChapter; onOpen: () => void }) {
  return (
    <button onClick={onOpen} aria-expanded={false} aria-controls={`rb-${chapter.id}-title`} className="rb-anim"
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 16, padding: '18px 20px', marginTop: 12, borderRadius: 12, cursor: 'pointer',
        background: RB.panel, border: `1px solid ${RB.border}`, color: RB.text, textAlign: 'left', minHeight: 44,
        boxShadow: `${EDGE.topHighlight}, 0 8px 22px -16px rgba(3,2,10,0.9)`,
        transition: 'background 170ms cubic-bezier(0.2,0.8,0.2,1), border-color 170ms ease, transform 170ms cubic-bezier(0.2,0.8,0.2,1), box-shadow 190ms ease' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = RB.panelHover; e.currentTarget.style.borderColor = RB.borderStrong; e.currentTarget.style.transform = 'translateY(-2px)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = RB.panel; e.currentTarget.style.borderColor = RB.border; e.currentTarget.style.transform = 'none'; }}>
      <span style={{ fontFamily: RULES_HEAD, fontWeight: 800, fontSize: 22, color: RB.gold, flex: 'none' }}>{chapter.num}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontFamily: RULES_HEAD, fontWeight: 700, fontSize: 18, color: RB.text }}>{chapter.title}</span>
        <span style={{ display: 'block', fontSize: 13, color: RB.text2, marginTop: 2 }}>{arrowize(chapter.summary, `cs-${chapter.id}`)}</span>
      </span>
      <span aria-hidden style={{ color: RB.gold, flex: 'none', display: 'inline-flex' }}><ChevronDown size={17} /></span>
    </button>
  );
}

function RuleCallout({ title, text }: { title: string; text: string }) {
  return (
    <div style={{ marginTop: 16, display: 'flex', gap: 12, padding: '14px 16px', borderRadius: 12, background: 'rgba(230,196,92,0.06)', border: `1px solid ${RB.borderStrong}` }}>
      <span aria-hidden style={{ color: RB.gold, display: 'inline-flex', flex: 'none' }}><ShieldCheck size={20} /></span>
      <div>
        <div style={{ fontWeight: 800, color: RB.goldBright, fontSize: 14 }}>{title}</div>
        <div style={{ fontSize: 13.5, color: RB.text2, marginTop: 3 }}>{text}</div>
      </div>
    </div>
  );
}

function AtAGlance() {
  const rows = [
    { icon: 'heart' as IconKey, label: 'Starting Life', value: '20', color: RB.success },
    { icon: 'cards' as IconKey, label: 'Opening Hand', value: '7', color: RB.violet },
    { icon: 'books' as IconKey, label: 'Deck Size', value: '60', color: RB.blue },
  ];
  return (
    <div style={{ padding: 16, borderRadius: 14, background: RB.panel, border: `1px solid ${RB.border}` }}>
      <div style={{ fontFamily: RULES_HEAD, fontSize: 12, letterSpacing: '0.18em', fontWeight: 700, color: RB.gold, marginBottom: 12 }}>AT A GLANCE</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 8, borderBottom: `1px solid ${RB.border}` }}>
            <span aria-hidden style={{ color: r.color, display: 'inline-flex' }}><Icon name={r.icon} size={17} /></span>
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
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>View Example Turn <ArrowRight size={14} /></button>
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
          <span aria-hidden style={{ color: RB.gold, display: 'inline-flex' }}><Search size={17} /></span>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search rules… (combat, gas, summoning sickness)" aria-label="Search rules"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: RB.text, fontSize: 16, fontFamily: RULES_FONT }} />
          <kbd style={{ padding: '2px 7px', fontSize: 11, background: 'rgba(0,0,0,0.4)', borderRadius: 5, color: RB.text2 }}>Esc</kbd>
        </div>
        <div className="rb-scroll" role="listbox" style={{ overflowY: 'auto', padding: 8 }}>
          {results.length === 0 ? (
            <div style={{ padding: 26, textAlign: 'center', color: RB.text2 }}>
              <div style={{ marginBottom: 6, color: RB.text2 }} aria-hidden><Search size={26} /></div>
              No rules found for “{q}”. Try “combat”, “gas”, or “setup”.
            </div>
          ) : results.map((r, i) => (
            <button key={r.c.id} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => onSelect(r.c.id, q)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                background: i === sel ? RB.panelActive : 'transparent', border: `1px solid ${i === sel ? RB.borderStrong : 'transparent'}`, color: RB.text, marginBottom: 2 }}>
              <span aria-hidden style={{ flex: 'none', color: RB.gold, display: 'inline-flex' }}><Icon name={r.c.icon} size={18} /></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{hl(r.c.title)}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: RB.gold }}>CH {r.c.num}</span>
                </span>
                <span style={{ display: 'block', fontSize: 12.5, color: RB.text2, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hl(r.snippet)}</span>
              </span>
              <span aria-hidden style={{ color: RB.text2, flex: 'none', display: 'inline-flex' }}><EnterKey size={13} /></span>
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
  myName, profile, queue, onPlay, onLadder, onMasterquest, onBoosters, onProfile, onRules, onSettings,
}: {
  myName: string; profile: Profile;
  /** The ranked queue, owned by the app root so it survives a view change. */
  queue: RankedQueue;
  onPlay: () => void; onLadder: () => void; onMasterquest: () => void; onBoosters: () => void;
  onProfile: () => void; onRules: () => void; onSettings: () => void;
}) {
  const mobile = useIsMobile(767);
  const tablet = useIsMobile(1279);
  // The signed-in player's own profile is already loaded by the root — it is
  // the only shape that carries a wallet address, and re-fetching it here would
  // just be a second `GET /api/profiles/me`.
  const prof = profile;
  const [players, setPlayers] = useState<number | null>(null);
  const [activeDeck, setActiveDeck] = useState<DeckEntry | null>(null);
  const [ranked, setRanked] = useState<OwnRankedProfile | null>(null);
  const [season, setSeason] = useState<SeasonInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [muted, setMuted] = useState<boolean>(() => { try { return localStorage.getItem('ocva.muted') === '1'; } catch { return false; } });
  const [copied, setCopied] = useState(false);
  const liveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      // The ladder is live, so the hub reads it: the season window drives the
      // ranked card's countdown and the caller's own standing drives the badge.
      // Both are allowed to fail independently — a ladder outage must not stop
      // a player getting to a casual match.
      const [all, decks, me, seasonInfo] = await Promise.all([
        listProfilesApi().catch(() => [] as Profile[]),
        listDecksApi().catch(() => [] as DeckEntry[]),
        RankedAPI.getMe().catch(() => null),
        RankedAPI.getSeason().catch(() => null),
      ]);
      if (!alive) return;
      setPlayers(all.length);
      setActiveDeck(decks.find((d) => d.isActive) ?? decks[0] ?? null);
      setRanked(me);
      setSeason(seasonInfo);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [myName]);
  useEffect(() => {
    try { localStorage.setItem('ocva.muted', muted ? '1' : '0'); } catch {}
    document.querySelectorAll('audio,video').forEach((a) => { (a as HTMLMediaElement).muted = muted; });
    // Let <BgMusic> re-assert its own per-track mute after this blanket set.
    try { window.dispatchEvent(new CustomEvent(PREFS_EVENT)); } catch {}
  }, [muted]);

  const games = prof.wins + prof.losses + prof.draws;
  // `level` is derived server-side from wins; the XP bar is a local flourish
  // on top of it, not a second source of truth.
  const level = prof.level;
  const xpForLvl = (l: number) => Math.round((l + 1) * (l + 1) / 2.2);
  const xpPrev = xpForLvl(level - 1), xpNext = xpForLvl(level);
  const xpInto = games - xpPrev, xpRange = Math.max(1, xpNext - xpPrev);

  const deckCards = activeDeck?.cards ?? [];
  const deckValid = activeDeck ? validateDeck(deckCards) : null;
  // `loading` is a FOURTH state, not a flavour of `missing`. Before the deck
  // list answers, every player looks deckless; saying so would flash
  // "CHOOSE A DECK" at somebody who has one.
  const deckState: 'loading' | 'missing' | 'invalid' | 'valid' =
    loading ? 'loading' : !activeDeck ? 'missing' : deckValid!.ok ? 'valid' : 'invalid';
  const deckFaction = deriveFavoriteFaction(deckCards);

  // Ownership for the ranked advisory, on the same "do not answer until we
  // know" rule as the lobby's copy of this.
  const collection = useCollection();
  const collectionSettled = useCollectionSettled(collection);
  const [scanning, setScanning] = useState(false);
  const scanChain = useCallback(async () => {
    setScanning(true);
    try { await syncCollection(); } finally { setScanning(false); }
  }, []);
  const rankedDeck: RankedEligibility | null = useMemo(
    () => (!loading && collectionSettled
      ? evaluateRankedDeck(activeDeck?.cards, { known: ownershipKnown(), ownedCount })
      : null),
    [activeDeck, collection, loading, collectionSettled],
  );
  const standing = standingOf(ranked);

  const copyAddr = async () => {
    if (!prof?.walletAddress) return;
    try { await navigator.clipboard.writeText(prof.walletAddress); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };

  const goCollection = () => { try { window.location.hash = 'collection'; } catch {} onProfile(); };

  const play = () => {
    // The lobby is where create / join / challenge live. Deck choice is not
    // made here or there any more: the server seats you with your ACTIVE deck.
    if (liveRef.current) liveRef.current.textContent = 'Entering matchmaking.';
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
        name={prof.name} avatarUrl={prof.avatarUrl} level={level}
        xpInto={xpInto} xpRange={xpRange}
        walletAddress={prof.walletAddress} copied={copied} onCopy={copyAddr}
        muted={muted} onToggleMute={() => setMuted((m) => !m)} onSettings={onSettings}
        loading={loading} mobile={mobile}
      />

      {/* Body panels */}
      <div style={{ position: 'relative', zIndex: 3, height: mobile ? 'auto' : '100%',
        display: mobile ? 'flex' : 'block', flexDirection: 'column', gap: 12,
        padding: mobile ? '76px 12px 90px' : 0 }}>
        <div style={mobile ? {} : { position: 'absolute', left: tablet ? 20 : 'clamp(24px, 4vw, 64px)', bottom: mobile ? undefined : 108, width: 'min(380px, 42vw)' }}>
          <MatchmakingPanel deckState={deckState} deckName={activeDeck?.name ?? null}
            deckCount={deckCards.length} deckFaction={deckFaction} deckIssue={deckValid?.issues?.[0]?.message ?? null}
            players={players} onPlay={play} onChangeDeck={() => { try { window.location.hash = 'decks'; } catch {} onProfile(); }}
            loading={loading} mobile={mobile}
            queue={queue} season={season} standing={standing} rankedDeck={rankedDeck}
            scanning={scanning || collection.loading} onScanChain={() => { void scanChain(); }}
            onBoosters={onBoosters} onLadder={onLadder}
            onDeckScreen={() => { try { window.location.hash = 'decks'; } catch {} onProfile(); }} />
        </div>

        {/* The right-hand column: the token announcement sits ON TOP of the
            card stack, and the two share the column's spacing so they read as
            one thing rather than two unrelated additions. */}
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 12,
          ...(mobile ? {} : { position: 'absolute', right: tablet ? 20 : 'clamp(24px, 4vw, 64px)', bottom: 108, width: 'min(340px, 40vw)' }),
        }}>
          <TokenAnnouncement mobile={mobile} />
          <ActivityPanel onViewEvent={onMasterquest} onLadder={onLadder}
            season={season} standing={standing} loading={loading} mobile={mobile} />
        </div>
      </div>

      <NavDock onCollection={goCollection} onBoosters={onBoosters} onLadder={onLadder} onMasters={onMasterquest} onProfile={onProfile} onRules={onRules} onSettings={onSettings} mobile={mobile} />

      <img src="/built-on-robinhood.png?v=2" alt="Built on Robinhood" draggable={false}
        style={{ position: mobile ? 'static' : 'absolute', zIndex: 2, left: '50%', bottom: mobile ? undefined : 70,
          transform: mobile ? 'none' : 'translateX(-50%)', margin: mobile ? '10px auto 0' : undefined, display: 'block',
          width: mobile ? 120 : 150, height: 'auto', pointerEvents: 'none', userSelect: 'none', opacity: 0.9,
          filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.6))' }} />

    </div>
  );
}

function PlayerHUD({ name, avatarUrl, level, xpInto, xpRange, walletAddress, copied, onCopy, muted, onToggleMute, onSettings, loading, mobile }: {
  name: string; avatarUrl: string | null; level: number; xpInto: number; xpRange: number;
  walletAddress: string | null; copied: boolean; onCopy: () => void; muted: boolean; onToggleMute: () => void; onSettings: () => void; loading: boolean; mobile: boolean;
}) {
  const [notifOpen, setNotifOpen] = useState(false);
  // Still empty, but for a different reason than it used to be: the ladder is
  // back, and there is simply no notification FEED on the backend to read —
  // no route delivers "you were promoted" or "your placements finished". The
  // ladder screen and the hub card carry that news instead.
  const notifs: string[] = [];
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

/**
 * The hub's front door: CASUAL or RANKED, the active deck, and one button.
 *
 * ─── THE TWO BUTTONS DO DIFFERENT THINGS ───────────────────────────────────
 * CASUAL opens the lobby, where create / join / challenge live. RANKED does
 * NOT: it joins the ladder queue (`POST /games/ranked/queue`) and the server
 * pairs you, so there is no seat to open and no lobby to browse. Conflating
 * them would put a player in an open casual match while they believed they
 * were climbing.
 *
 * ─── THE DECK ADVISORY IS ADVISORY ─────────────────────────────────────────
 * `evaluateRankedDeck` mirrors the server's ownership check so a player is told
 * BEFORE they queue rather than by a 400 afterwards. It never disables the
 * button: the snapshot can lag a pack minted seconds ago, and the server is the
 * authority. Its three states are genuinely different — in particular "never
 * synced" prompts a chain scan and must never claim the deck is illegal.
 */
function MatchmakingPanel({
  deckState, deckName, deckCount, deckFaction, deckIssue, players, onPlay, onChangeDeck, loading, mobile,
  queue, season, standing, rankedDeck, scanning, onScanChain, onBoosters, onDeckScreen, onLadder,
}: {
  deckState: 'loading' | 'missing' | 'invalid' | 'valid';
  deckName: string | null; deckCount: number; deckFaction: { name: string; color: string } | null; deckIssue: string | null;
  players: number | null; onPlay: () => void; onChangeDeck: () => void; loading: boolean; mobile: boolean;
  queue: RankedQueue;
  season: SeasonInfo | null;
  /** `null` while the caller's ranked profile is loading or unavailable. */
  standing: RankedStanding | null;
  /** `null` until the deck list AND the ownership snapshot have answered. */
  rankedDeck: RankedEligibility | null;
  scanning: boolean; onScanChain: () => void;
  onBoosters: () => void; onDeckScreen: () => void; onLadder: () => void;
}) {
  const [mode, setMode] = useState<OfferedMode>('casual');
  const q = queue.state;
  // Once the player is in the queue the panel IS the queue — flipping back to
  // casual underneath a live ticket would be a lie about what the app is doing.
  const queueBusy = q.status !== 'idle';
  const shown: OfferedMode = queueBusy ? 'ranked' : mode;

  // The button always opens the lobby (create / join / challenge live there);
  // the label reflects the ACTIVE deck, which is what the server will seat you
  // with — there is no per-match deck choice any more. `loading` keeps the
  // neutral label rather than claiming a deck the player may well have.
  const playLabel = deckState === 'missing' ? 'CHOOSE A DECK' : deckState === 'invalid' ? 'FIX DECK & PLAY' : 'PLAY';
  const canPlay = true;
  return (
    <section aria-label="Matchmaking" style={{ padding: 18, borderRadius: 16, background: MENU.panelPurple, border: `1px solid ${MENU.border}`, backdropFilter: 'blur(12px)', boxShadow: '0 20px 50px rgba(0,0,0,0.5)' }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.18em', color: MENU.gold }}>MATCHMAKING</div>
      <h2 style={{ margin: '4px 0 14px', fontFamily: MENU_SERIF, fontWeight: 700, fontSize: mobile ? 26 : 30, color: MENU.text }}>ENTER THE ARENA</h2>

      {/* CASUAL / RANKED. A radio group, not a tab strip: it is a property of
          the match you are about to play, not navigation. */}
      <div role="radiogroup" aria-label="Match mode" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {(['casual', 'ranked'] as const).map((m) => {
          const active = shown === m;
          const gold = m === 'casual';
          return (
            <button key={m} type="button" role="radio" aria-checked={active}
              onClick={() => { if (!queueBusy) setMode(m); }} disabled={queueBusy && !active}
              style={{
                padding: '10px 8px', minHeight: 44, borderRadius: 11,
                cursor: queueBusy ? 'default' : 'pointer',
                fontFamily: F.body, fontWeight: 800, fontSize: 12.5, letterSpacing: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                background: active
                  ? (gold ? `linear-gradient(180deg, ${MENU.goldHi}, ${MENU.gold})` : 'rgba(139,92,246,0.24)')
                  : 'rgba(8,8,22,0.55)',
                color: active ? (gold ? '#20170a' : '#e6d4ff') : MENU.text2,
                border: `1px solid ${active ? (gold ? '#8a6d24' : 'rgba(139,92,246,0.65)') : MENU.border}`,
                boxShadow: active ? (gold ? '0 6px 18px -6px rgba(230,196,92,0.55)' : '0 0 20px rgba(139,92,246,0.35)') : 'none',
                transition: 'all .15s ease', opacity: queueBusy && !active ? 0.45 : 1,
              }}>
              {gold ? <Swords size={15} /> : <Trophy size={15} />} {gold ? 'CASUAL' : 'RANKED'}
            </button>
          );
        })}
      </div>

      {shown === 'casual' ? (
        <div style={{ fontSize: 12.5, color: MENU.text2, margin: '10px 2px 12px' }}>Casual play · no rank at stake</div>
      ) : (
        <div style={{ margin: '10px 2px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <RankBadge standing={standing} loading={loading} compact />
          <button onClick={onLadder} style={{
            background: 'none', border: 'none', color: MENU.violet, cursor: 'pointer',
            fontWeight: 800, fontSize: 11, letterSpacing: '0.06em', padding: 0,
            display: 'inline-flex', alignItems: 'center', gap: 5,
          }}>{season ? season.season.name.toUpperCase() : 'THE LADDER'} <ArrowRight size={12} /></button>
        </div>
      )}

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
      {deckState === 'invalid' && deckIssue && (
        <div style={{ fontSize: 11.5, color: '#FF616F', margin: '8px 2px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Warning size={12} /> {deckIssue}
        </div>
      )}

      {shown === 'ranked' && (
        <HubRankedDeckNote ranked={rankedDeck} scanning={scanning}
          onScanChain={onScanChain} onDeckScreen={onDeckScreen} onBoosters={onBoosters} />
      )}

      {shown === 'casual' ? (
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
      ) : (
        <RankedQueueControl queue={queue} onDeckScreen={onDeckScreen} onBoosters={onBoosters} />
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 12, fontSize: 12, color: MENU.text2 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: MENU.success, boxShadow: `0 0 6px ${MENU.success}` }} />
        {players == null ? '…' : players} player{players === 1 ? '' : 's'} online
      </div>
    </section>
  );
}

/**
 * The hub's compact version of the lobby's `RankedDeckNote`.
 *
 * Same three states, same rule — it NEVER disables the queue button, because
 * the server is the authority and this snapshot can lag a pack minted seconds
 * ago. A verified deck says nothing at all: silence is the reward for being
 * ready, and the panel stays short.
 */
function HubRankedDeckNote({ ranked, scanning, onScanChain, onDeckScreen, onBoosters }: {
  ranked: RankedEligibility | null; scanning: boolean;
  onScanChain: () => void; onDeckScreen: () => void; onBoosters: () => void;
}) {
  // Not known yet, or nothing to say.
  if (ranked === null || ranked.status === 'ready') return null;

  const link = (label: string, onClick: () => void, key: string) => (
    <button key={key} onClick={onClick} style={{
      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
      color: MENU.goldHi, fontWeight: 800, fontSize: 11, letterSpacing: '0.05em',
    }}>{label}</button>
  );

  const body =
    ranked.status === 'no-deck'
      ? 'Activate a deck and we will check it against the cards you own before you queue.'
      // NEVER "your deck is illegal" here. Nobody has looked yet.
      : ranked.status === 'unknown'
        ? 'Your cards have not been read from the chain yet, so we cannot tell whether this deck qualifies. Basic Nodes are free either way.'
        : `Ranked decks use cards you have minted, so the free starter decks stay casual — that is the design, not a fault. You are short ${ranked.missingCopies} cop${ranked.missingCopies === 1 ? 'y' : 'ies'} across ${ranked.missingCards} card${ranked.missingCards === 1 ? '' : 's'}.`;

  return (
    <div style={{
      marginTop: 12, padding: '10px 12px', borderRadius: 10,
      background: 'rgba(230,196,92,0.07)', border: `1px solid ${MENU.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 10.5, fontWeight: 800, letterSpacing: 1.3, color: MENU.gold }}>
        <Warning size={13} /> {
          ranked.status === 'no-deck' ? 'RANKED · NO ACTIVE DECK'
          : ranked.status === 'unknown' ? 'RANKED · COLLECTION NOT SCANNED'
          : 'RANKED · CARDS YOU DO NOT OWN YET'
        }
      </div>
      <div style={{ fontSize: 11.5, color: MENU.text2, marginTop: 5, lineHeight: 1.55 }}>{body}</div>
      <div style={{ display: 'flex', gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
        {ranked.status === 'no-deck' && link('BUILD A DECK', onDeckScreen, 'deck')}
        {ranked.status === 'short' && link('OPEN BOOSTERS', onBoosters, 'boosters')}
        {ranked.status === 'short' && link('EDIT DECK', onDeckScreen, 'edit')}
        {ranked.status !== 'no-deck' && link(scanning ? 'SCANNING…' : 'SCAN CHAIN', onScanChain, 'scan')}
      </div>
    </div>
  );
}

function ActivityPanel({ onViewEvent, onLadder, season, standing, loading, mobile }: {
  onViewEvent: () => void; onLadder: () => void;
  season: SeasonInfo | null; standing: RankedStanding | null; loading: boolean; mobile: boolean;
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

  return (
    <aside aria-label="Activity" style={{ display: 'flex', flexDirection: mobile ? 'row' : 'column', gap: 12, overflowX: mobile ? 'auto' : 'visible' }}>
      {/* The real ladder: the caller's own standing and the season window,
          both straight from `/games/ranked/*`. Placements show progress and NO
          rank, because the server sends none until they are finished. */}
      <ActCard title="RANKED LADDER" mobile={mobile}>
        <RankBadge standing={standing} loading={loading} />
        {standing?.state === 'placements' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0 2px' }}>
            <Bar pct={standing.progressPct} />
            <span style={{ fontSize: 11, color: MENU.text2, whiteSpace: 'nowrap' }}>{standing.played} / {standing.total}</span>
          </div>
        )}
        <div style={{ fontSize: 11.5, color: MENU.text2, marginTop: 6, lineHeight: 1.55 }}>
          {season ? `${season.season.name} · ${seasonRemaining(season.season.endsAt).text}` : 'Season unavailable right now.'}
        </div>
        <button onClick={onLadder} style={{ marginTop: 8, background: 'none', border: 'none', color: MENU.violet, cursor: 'pointer', fontWeight: 800, fontSize: 11.5, letterSpacing: '0.06em', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          VIEW LADDER <ArrowRight size={12} />
        </button>
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

function NavDock({ onCollection, onBoosters, onLadder, onMasters, onProfile, onRules, onSettings, mobile }: {
  onCollection: () => void; onBoosters: () => void; onLadder: () => void; onMasters: () => void; onProfile: () => void; onRules: () => void; onSettings: () => void; mobile: boolean;
}) {
  const primary = [
    { label: 'Collection', icon: mIco(<><path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" /><path d="m3 8 9 5 9-5" /><path d="M12 13v8" /></>, 20), onClick: onCollection },
    { label: 'Boosters', icon: mIco(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M4 9h16" /><path d="M12 3v18" /></>, 20), onClick: onBoosters },
    // The ladder is a first-class destination now that there is a service
    // behind it. The dock already scrolls horizontally, so a sixth primary
    // item does not change the layout on a narrow screen.
    { label: 'Ladder', icon: mIco(<><path d="M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M7 5.5H4.5A2.5 2.5 0 0 0 7 10M17 5.5h2.5A2.5 2.5 0 0 1 17 10" /><path d="M12 14v3M8.5 20h7M9.5 20l.5-3h4l.5 3" /></>, 20), onClick: onLadder },
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

// The hub's old three-row settings popover (sound / rulebook / sign out) and its
// sign-out ConfirmDialog were removed when the real Settings screen landed —
// see src/Settings.tsx. Both the NavDock gear and the PlayerHUD gear now route
// to view 'settings', which carries those three actions plus the rest.

/**
 * The $MASTER token address, kept only as a display string for the landing
 * footer. Nothing in the client transacts in it any more: the wager service is
 * EVM-only (its stake token is an ERC-20 read from `wager.getStakes()`), and
 * there is no Solana money path in this backend at all.
 */
/**
 * ── OCVA, the game's token, on Robinhood Chain ──────────────────────────────
 *
 * Verified on chain (EIP-155 4663): `name()` is "On Chain Virtual Arena",
 * `symbol()` is OCVA, `decimals()` is 18. It does NOT exist on Sepolia, which
 * is why the strip names the network — pasting this into a wallet pointed at
 * the wrong chain finds nothing.
 *
 * This replaces `ContractAddressFooter` and its `MASTER_TOKEN_ADDRESS`
 * constant, which was a SOLANA address left over from before the project moved
 * to EVM. That component was rendered nowhere, so it was invisible rather than
 * wrong — but a stale address sitting one JSX line away from being shown is a
 * hazard, not dead code, so it is deleted rather than repurposed.
 */
const OCVA_TOKEN_ADDRESS = '0x22f147eEf54Be28B0dc162309e6c202D4240B3F0';
const OCVA_SYMBOL = 'OCVA';
const OCVA_CHAIN_NAME = 'Robinhood Chain';
/**
 * The Dexscreener chart.
 *
 * THE ADDRESS IN THIS URL IS THE LIQUIDITY PAIR, NOT THE TOKEN — its `token1()`
 * is `OCVA_TOKEN_ADDRESS` above. It is a chart link and nothing else; it must
 * never be presented as an address to copy into a wallet.
 */
const OCVA_CHART_URL = 'https://dexscreener.com/robinhood/0xc4D9B15Cf9FFa807A78545c972d07D925Ad5eEe0';

/** Middle-truncate an address for display. The full value is still copied. */
function shortenAddress(addr: string, lead = 8, tail = 4): string {
  return addr.length <= lead + tail + 1 ? addr : `${addr.slice(0, lead)}\u2026${addr.slice(-tail)}`;
}

/**
 * Copy text, with a fallback for the places `navigator.clipboard` does not
 * exist: insecure origins and several in-app browsers. Returns whether it
 * actually worked, so the caller can say so rather than pretend.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

/**
 * The token announcement strip, above the hub's right-hand card stack.
 *
 * Deliberately carries NO price, market cap, holder count or supply figure.
 * Nothing here fetches them, and a hardcoded number would be wrong within the
 * hour — which is the same "render data we do not have" failure that got the
 * previous ranked UI deleted.
 */
function TokenAnnouncement({ mobile }: { mobile: boolean }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const explorerUrl = `${ROBINHOOD_EXPLORER_URL}/token/${OCVA_TOKEN_ADDRESS}`;

  async function copy() {
    const ok = await copyToClipboard(OCVA_TOKEN_ADDRESS);
    setCopyState(ok ? 'copied' : 'failed');
    // A failure stays on screen: it comes with the full address to select by
    // hand, and yanking that away after a second would be worse than useless.
    if (ok) setTimeout(() => setCopyState('idle'), 1800);
  }

  const linkStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    fontSize: 11, fontWeight: 800, letterSpacing: '0.06em',
    color: MENU.violet, textDecoration: 'none',
  };

  return (
    <section aria-label={`${OCVA_SYMBOL} token`} style={{
      padding: mobile ? 13 : 14, borderRadius: 14,
      background: `linear-gradient(160deg, rgba(230,196,92,0.13), ${MENU.panel} 62%)`,
      border: `1px solid ${MENU.borderStrong}`, backdropFilter: 'blur(10px)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.14em', color: MENU.gold }}>TOKEN LIVE</span>
        <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: MENU.success, boxShadow: `0 0 6px ${MENU.success}` }} />
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: MENU.text2 }}>
          {OCVA_CHAIN_NAME.toUpperCase()}
        </span>
      </div>

      <div style={{ fontFamily: MENU_SERIF, fontWeight: 700, fontSize: 20, color: MENU.text, margin: '5px 0 2px' }}>
        ${OCVA_SYMBOL}
      </div>
      <div style={{ fontSize: 11.5, color: MENU.text2, lineHeight: 1.5 }}>
        On Chain Virtual Arena — add it to a wallet on {OCVA_CHAIN_NAME}.
      </div>

      {/* The visible address is middle-truncated so 42 hex characters cannot
          overflow a phone. The button copies the WHOLE value, and its
          accessible name spells the whole value out. */}
      <button onClick={() => { void copy(); }} title={OCVA_TOKEN_ADDRESS}
        aria-label={`Copy the full ${OCVA_SYMBOL} contract address, ${OCVA_TOKEN_ADDRESS}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', marginTop: 10,
          padding: '9px 11px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
          background: 'rgba(8,8,22,0.6)',
          border: `1px solid ${copyState === 'copied' ? MENU.success : copyState === 'failed' ? '#FF616F' : MENU.border}`,
          color: MENU.text, transition: 'border-color .2s ease',
        }}>
        <span aria-hidden style={{
          flex: 1, minWidth: 0, fontFamily: F.mono, fontSize: mobile ? 12 : 12.5,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{shortenAddress(OCVA_TOKEN_ADDRESS)}</span>
        <span aria-hidden style={{
          flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 5,
          fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em',
          color: copyState === 'copied' ? MENU.success : copyState === 'failed' ? '#FF616F' : MENU.text2,
        }}>
          {copyState === 'copied' ? <><Check size={13} /> COPIED</>
            : copyState === 'failed' ? <><Warning size={13} /> FAILED</>
            : <><Copy size={13} /> COPY</>}
        </span>
      </button>

      {/* Copy is not available on insecure origins or in some in-app browsers.
          Say so, and hand over the full address to select by hand. */}
      {copyState === 'failed' && (
        <div role="alert" style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, color: '#FF616F', lineHeight: 1.5 }}>
            This browser would not let us copy. Select the address and copy it by hand:
          </div>
          <div style={{
            marginTop: 5, padding: '7px 9px', borderRadius: 8, userSelect: 'all',
            fontFamily: F.mono, fontSize: 11, wordBreak: 'break-all', lineHeight: 1.5,
            background: 'rgba(8,8,22,0.7)', border: `1px solid ${MENU.border}`, color: MENU.text,
          }}>{OCVA_TOKEN_ADDRESS}</div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
        <a href={OCVA_CHART_URL} target="_blank" rel="noopener noreferrer" style={linkStyle}>
          <Chart size={13} /> CHART <External size={11} />
        </a>
        <a href={explorerUrl} target="_blank" rel="noopener noreferrer" style={linkStyle}>
          <LinkIcon size={13} /> EXPLORER <External size={11} />
        </a>
      </div>
    </section>
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
  bg: '#070614', surface: '#0C0A1C', raised: '#141127',
  gold: '#E5B84B', goldHi: '#FFD86A', purple: '#8E4DFF', violet: '#C45CFF',
  cyan: '#19D3D2', green: '#39E879', red: '#E0525E', text: '#F4F2EA', muted: '#9C97B4',
  border: 'rgba(217,180,90,0.16)', borderHi: 'rgba(217,180,90,0.42)',
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

function ProfilePage({ myName, onBack, onSettings }: { myName: string; onBack: () => void; onSettings: () => void }) {
  const mobile = useIsMobile(920);
  const [prof, setProf] = useState<Profile | null>(null);
  // The caller's own ladder standing. This used to be a permanently-null `any`
  // left over from the ranked service being deleted; it is real again.
  const [ranked, setRanked] = useState<OwnRankedProfile | null>(null);
  const [decks, setDecks] = useState<DeckEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // Settings -> Account -> "Edit profile" sets this one-shot flag and navigates
  // here, so the existing edit modal is reused instead of duplicated.
  const [editing, setEditing] = useState(() => {
    try {
      if (sessionStorage.getItem('ocva.openProfileEdit') !== '1') return false;
      sessionStorage.removeItem('ocva.openProfileEdit');
      return true;
    } catch { return false; }
  });
  const [tab, setTab] = useState<HubTab>(readHubTab);
  const [muted, setMuted] = useState<boolean>(() => { try { return localStorage.getItem('ocva.muted') === '1'; } catch { return false; } });
  const [copied, setCopied] = useState(false);

  // The hub always shows the SIGNED-IN player, so read the own-profile route:
  // it is the only one that returns a wallet address, and only to its owner.
  const reload = useCallback(async () => {
    setProf(await getMyProfileApi());
  }, []);

  const reloadDecks = useCallback(async () => {
    try { setDecks(await listDecksApi()); } catch { setDecks([]); }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        await reload();
        await reloadDecks();
        // A ladder outage must not stop the profile hub from rendering.
        setRanked(await RankedAPI.getMe().catch(() => null));
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
    // Let <BgMusic> re-assert its own per-track mute after this blanket set.
    try { window.dispatchEvent(new CustomEvent(PREFS_EVENT)); } catch {}
  }, [muted]);

  const activeDeck = decks.find((d) => d.isActive) ?? null;
  const favoriteCards = activeDeck?.cards ?? [];

  const games  = prof ? prof.wins + prof.losses + prof.draws : 0;
  const winPct = games ? Math.round((prof!.wins / games) * 100) : 0;
  const level  = prof?.level ?? 1;
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
        muted={muted} onToggleMute={() => setMuted((m) => !m)} onSettings={onSettings}
      />

      {loading ? (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: HUB.muted, position: 'relative', zIndex: 1 }}>Loading profile…</div>
      ) : (
        <div style={{ position: 'relative', zIndex: 1, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
          gap: 12, padding: mobile ? '12px 12px 32px' : '14px 22px 18px', maxWidth: 1680, width: '100%', margin: '0 auto' }}>
          <IdentityBar
            name={prof?.name ?? myName} avatarUrl={prof?.avatarUrl ?? null}
            placement={ranked?.placement.inPlacements ? ranked.placement.remaining : 0}
            rankLabel={formatRankLabel(ranked?.rank ?? null)}
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
function HubTopNav({ tab, setTab, onBack, onEdit, walletAddress, copied, onCopy, muted, onToggleMute, onSettings }: {
  tab: HubTab; setTab: (t: HubTab) => void; onBack: () => void; onEdit: () => void;
  walletAddress: string | null; copied: boolean; onCopy: () => void; muted: boolean; onToggleMute: () => void;
  onSettings: () => void;
}) {
  const mobile = useIsMobile(920);
  const connected = !!walletAddress;
  const isEvm = !!walletAddress?.startsWith('0x');
  const dot = connected ? HUB.cyan : HUB.red;
  const net = connected ? (isEvm ? 'Robinhood Chain' : 'Solana') : 'Disconnected';

  const tabsNav = (
    <nav className="hub-scroll" aria-label="Profile sections"
      style={{ display: 'flex', alignItems: 'center', gap: 4,
        ...(mobile ? { width: '100%', overflowX: 'auto', WebkitOverflowScrolling: 'touch' as const, padding: '0 8px' } : {}) }}>
      {HUB_TABS.map((t) => {
        const active = tab === t;
        return (
          <button key={t} onClick={() => setTab(t)} aria-current={active ? 'page' : undefined}
            className="hub-anim"
            style={{ position: 'relative', background: 'none', border: 'none', cursor: 'pointer', flex: 'none',
              padding: mobile ? '12px 12px' : '18px 14px', fontFamily: HUB_SANS, fontWeight: 800, fontSize: 12.5, letterSpacing: '0.1em',
              color: active ? HUB.text : HUB.muted, transition: 'color .18s ease', textTransform: 'uppercase' }}>
            {t}
            {active && <span aria-hidden style={{ position: 'absolute', left: 10, right: 10, bottom: mobile ? 6 : 10, height: 2, borderRadius: 2,
              background: `linear-gradient(90deg, ${HUB.gold}, ${HUB.violet})`, boxShadow: `0 0 12px ${HUB.violet}aa` }} />}
          </button>
        );
      })}
    </nav>
  );

  const brand = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
      <HubEmblem size={28} />
      <div style={{ lineHeight: 1 }}>
        <div style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: 10, letterSpacing: '0.2em', color: HUB.muted }}>ON-CHAIN</div>
        <div style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: 13, letterSpacing: '0.1em', color: HUB.goldHi }}>VIRTUAL ARENA</div>
      </div>
      <button onClick={onBack} style={{ marginLeft: 8, background: 'none', border: 'none', color: HUB.muted, cursor: 'pointer',
        fontWeight: 700, letterSpacing: '0.08em', fontSize: 12, padding: mobile ? '12px 6px' : 0, minHeight: mobile ? 44 : undefined,
        display: 'inline-flex', alignItems: 'center', gap: 7 }}><ArrowLeft size={13} /> LOBBY</button>
    </div>
  );

  const actions = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: mobile ? 'none' : 1, justifyContent: 'flex-end', minWidth: 0 }}>
      {!mobile && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 11px', borderRadius: 999, background: HUB.raised, border: `1px solid ${HUB.border}` }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, boxShadow: `0 0 8px ${dot}` }} />
          <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{net}</span>
        </div>
      )}
      {walletAddress && !mobile && (
        <button onClick={onCopy} title="Copy wallet address" style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 11px',
          borderRadius: 999, background: HUB.raised, border: `1px solid ${HUB.border}`, color: HUB.text, cursor: 'pointer', fontFamily: F.mono, fontSize: 12 }}>
          {shortAddr(walletAddress)} <span style={{ color: copied ? HUB.green : HUB.muted, display: 'inline-flex' }}>{copied ? <Check size={13} /> : <Copy size={13} />}</span>
        </button>
      )}
      <button onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'} style={{ width: mobile ? 40 : 34, height: mobile ? 40 : 34, display: 'grid', placeItems: 'center',
        borderRadius: 9, background: HUB.raised, border: `1px solid ${HUB.gold}44`, color: HUB.goldHi, cursor: 'pointer', flex: 'none' }}>{muted ? <SoundOff size={16} /> : <SoundOn size={16} />}</button>
      <button onClick={onSettings} aria-label="Settings" title="Settings" style={{ width: mobile ? 40 : 34, height: mobile ? 40 : 34, display: 'grid', placeItems: 'center',
        borderRadius: 9, background: HUB.raised, border: `1px solid ${HUB.gold}44`, color: HUB.goldHi, cursor: 'pointer', flex: 'none' }}><Settings size={16} /></button>
      <button onClick={onEdit} style={{ padding: mobile ? '10px 12px' : '8px 14px', borderRadius: 9, background: 'transparent', border: `1px solid ${HUB.gold}`,
        color: HUB.goldHi, cursor: 'pointer', fontWeight: 800, letterSpacing: '0.06em', fontSize: 11.5, whiteSpace: 'nowrap', flex: 'none' }}>{mobile ? 'EDIT' : 'EDIT PROFILE'}</button>
    </div>
  );

  if (mobile) {
    // Two rows: brand + actions, then a horizontally scrollable tab strip.
    return (
      <div style={{ position: 'relative', zIndex: 5, display: 'flex', flexDirection: 'column',
        background: 'rgba(6,8,18,0.75)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', borderBottom: `1px solid ${HUB.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px' }}>
          {brand}
          {actions}
        </div>
        {tabsNav}
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', zIndex: 5, height: 60, flex: '0 0 60px', display: 'flex', alignItems: 'center',
      gap: 14, padding: '0 18px', background: 'rgba(6,8,18,0.75)', backdropFilter: 'blur(10px)', borderBottom: `1px solid ${HUB.border}` }}>
      {brand}
      {tabsNav}
      {actions}
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
          <span style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: 'clamp(20px, 4vw, 26px)', color: HUB.text,
            maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
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
          <span style={{ color: favoriteDeckName ? HUB.goldHi : HUB.muted, display: 'inline-flex' }} aria-hidden>{favoriteDeckName ? <Star size={20} /> : <DeckIcon size={20} />}</span>
          <span>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: HUB.muted }}>{favoriteDeckName ? 'FAVORITE DECK' : 'NO FAVORITE DECK'}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: favoriteDeckName ? HUB.text : HUB.muted, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {favoriteDeckName ?? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>Build one <ArrowRight size={12} /></span>}{favoriteFaction && favoriteDeckName ? ` · ${favoriteFaction.name}` : ''}
            </div>
          </span>
        </button>
      </div>
    </div>
  );
}

// ── Overview tab ────────────────────────────────────────────────────────────
function OverviewTab({ prof, ranked, winPct, games, favoriteDeck, favoriteFaction, onBuildDeck, mobile }: {
  prof: Profile | null; ranked: OwnRankedProfile | null; winPct: number; games: number; level: number; xpPct: number;
  favoriteDeck: DeckEntry | null; favoriteFaction: { name: string; color: string } | null; onBuildDeck: () => void; mobile: boolean;
}) {
  const standing = standingOf(ranked);
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

      {/* Real rank, real placements. While `placement.inPlacements` is true the
          server sends NO rank, so neither does this card — it shows how far
          through placements the player is and nothing else. */}
      <HubCard title="RANKED LADDER">
        <RankBadge standing={standing} loading={!ranked && !prof} />
        {standing?.state === 'placements' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '10px 0 6px' }}>
              <div style={{ flex: 1, height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.10)', overflow: 'hidden' }}>
                <div style={{ width: `${standing.progressPct}%`, height: '100%', background: `linear-gradient(90deg, ${HUB.gold}, ${HUB.purple})` }} />
              </div>
              <span style={{ fontSize: 11, color: HUB.muted, whiteSpace: 'nowrap' }}>{standing.played} / {standing.total}</span>
            </div>
            <div style={{ fontSize: 12, color: HUB.muted, lineHeight: 1.55 }}>{placementBlurb(standing)}</div>
          </>
        )}
        {standing?.state === 'ranked' && (
          <div style={{ fontSize: 12, color: HUB.muted, marginTop: 8, lineHeight: 1.55 }}>
            {formatRankedRecord(ranked!.record)} this season
            {standing.leaderboardRank !== null ? ` · #${standing.leaderboardRank} on the ladder` : ''}
          </div>
        )}
        {!standing && (
          <div style={{ fontSize: 12, color: HUB.muted, marginTop: 8, lineHeight: 1.55 }}>
            Your ladder standing could not be read just now.
          </div>
        )}
      </HubCard>

      <HubCard title="FAVORITE DECK">
        {favoriteDeck ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ color: HUB.goldHi, display: 'inline-flex' }} aria-hidden><Star size={18} /></span>
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
    <div className="ova-lift" style={{ ...engravedPanel(), padding: 20, background: HUB.raised, borderColor: HUB.border }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 12 }}>
        <div style={{ fontFamily: HUB_SANS, fontWeight: 800, fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', color: HUB.gold }}>{title}</div>
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
  return { ...goldPlate(disabled), marginTop: 12, padding: '11px 18px', fontSize: 12.5 };
}

// ── Collection tab ──────────────────────────────────────────────────────────
function CollectionTab({ walletAddress, mobile }: { walletAddress: string | null; mobile: boolean }) {
  const [chain, setChain] = useState<Color | 'all'>('all');
  const [type, setType] = useState<'all' | CardType>('all');
  const [ownedOnly, setOwnedOnly] = useState(true);
  // Ownership comes from `GET /wager/collection`, derived from the player's real
  // CardPack NFT holdings. `owned` is the display copy (server snapshot + the
  // implicit Node grant + any pack the chain indexer has not caught up with).
  const collection = useCollection();
  const owned = collection.cards;
  useEffect(() => { void refreshCollection(); }, []);
  const cards = useMemo(() => BUILDABLE_CARDS.filter((c) =>
    (chain === 'all' || c.color === chain) && (type === 'all' || c.type === type) && (!ownedOnly || (owned[c.id] ?? 0) > 0)), [chain, type, ownedOnly, owned]);
  const totalOwned = useMemo(() => BUILDABLE_CARDS.reduce((s, c) => s + (owned[c.id] ?? 0), 0), [owned]);
  const uniqueOwned = useMemo(() => BUILDABLE_CARDS.filter((c) => (owned[c.id] ?? 0) > 0).length, [owned]);
  const connected = !!walletAddress;
  // `needsSync` is NOT "you own nothing" — the server cannot yet tell a player
  // who has never synced from one who genuinely holds no cards, so an
  // unconfirmed snapshot is treated as unknown and prompts a scan instead of
  // announcing an empty collection.
  const { needsSync, loading, error, pendingCount, syncedAt, syncedBlock } = collection;
  const offline = collection.source === 'cache' && !needsSync;
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ padding: '10px 14px', borderRadius: 12, background: HUB.raised,
        border: `1px solid ${needsSync ? HUB.gold + '77' : HUB.border}`,
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: connected ? HUB.cyan : HUB.muted, flex: 'none' }} />
        <span style={{ fontSize: 13, color: HUB.text, flex: '1 1 260px', minWidth: 0 }}>
          {needsSync ? (
            <>Your collection has not been read from the chain yet. <b>Scan the chain</b> to load the cards your wallet holds — Basic Nodes are always free.</>
          ) : (
            <>You own <b style={{ color: HUB.goldHi }}>{totalOwned}</b> cards ({uniqueOwned} unique). Every collection includes 20 of each chain Node for free — open <b>Boosters</b> to unlock the rest.{connected ? ` Mints land in ${shortAddr(walletAddress!)}.` : ''}</>
          )}
        </span>
        <button onClick={() => { void syncCollection(); }} disabled={loading}
          title="Re-read your CardPack NFTs from Robinhood Chain"
          style={{ padding: '8px 13px', borderRadius: 9, flex: 'none', cursor: loading ? 'default' : 'pointer',
            background: needsSync ? `${HUB.gold}22` : HUB.surface, color: needsSync ? HUB.goldHi : HUB.text,
            border: `1px solid ${needsSync ? HUB.gold : HUB.border}`, fontSize: 11.5, fontWeight: 800, letterSpacing: '0.06em',
            opacity: loading ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Refresh size={12} /> {loading ? 'SCANNING…' : 'SCAN CHAIN'}
        </button>
      </div>

      {(error || pendingCount > 0 || offline) && (
        <div role="status" style={{ fontSize: 11.5, color: error ? HUB.red : HUB.muted, display: 'flex', alignItems: 'center', gap: 6 }}>
          {error ? <Warning size={12} /> : <Hourglass size={12} />}
          {error
            ? error
            : pendingCount > 0
              ? `${pendingCount} newly minted card${pendingCount === 1 ? '' : 's'} still being indexed on-chain — they will settle shortly.`
              : 'Showing your last saved collection.'}
        </div>
      )}
      {!error && !needsSync && syncedAt && (
        <div style={{ fontSize: 11, color: HUB.muted }}>
          Last scanned {new Date(syncedAt).toLocaleString()}
          {/* The chain's own clock — the one that means something when a
              player's wallet and this page disagree. */}
          {syncedBlock !== null && ` · block ${syncedBlock.toLocaleString()}`}.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <ChainChips value={chain} onChange={setChain} />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <TypeChips value={type} onChange={setType} />
        <button onClick={() => setOwnedOnly((v) => !v)} aria-pressed={ownedOnly} style={{ marginLeft: 'auto', padding: '7px 12px', borderRadius: 9,
          background: ownedOnly ? `${HUB.violet}22` : HUB.surface, color: ownedOnly ? HUB.violet : HUB.muted, border: `1px solid ${ownedOnly ? HUB.violet : HUB.border}`,
          cursor: 'pointer', fontSize: 11.5, fontWeight: 700 }}>{ownedOnly ? 'OWNED ONLY' : 'SHOW ALL'}</button>
        <span style={{ alignSelf: 'center', fontSize: 12, color: HUB.muted }}>{cards.length} cards</span>
      </div>

      <div className="hub-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${mobile ? 150 : 190}px, 1fr))`, gap: 12, alignContent: 'start', paddingBottom: 8 }}>
        {cards.length === 0 ? (
          <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: HUB.muted, padding: 30 }}>
            {needsSync
              ? 'We have not read your cards from the chain yet — hit SCAN CHAIN above to load them.'
              : 'No owned cards here yet — open a booster pack to start your collection.'}
          </div>
        ) : cards.map((def) => (
          <HubCardTile key={def.id} def={def} inDeck={0} cap={owned[def.id] ?? 0} owned={owned[def.id] ?? 0}
            deckFull={false} onAdd={undefined} showAdd={false} />
        ))}
      </div>
    </div>
  );
}

// ── Achievements tab ────────────────────────────────────────────────────────
function AchievementsTab({ prof, ranked, deck, mobile }: { prof: Profile | null; ranked: OwnRankedProfile | null; deck: string[]; mobile: boolean }) {
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
            <div aria-hidden style={{ display: 'flex', color: a.earned ? HUB.goldHi : HUB.muted, filter: a.earned ? `drop-shadow(0 0 8px ${HUB.gold}aa)` : 'none' }}>{a.earned ? <Icon name={a.icon} size={26} /> : <Lock size={26} />}</div>
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
        /* Logo replaces the plain accent dot; decorative, the chip is labelled. */
        <HubChip key={c} label={COLOR_META[c].name.toUpperCase()} selected={value === c} onClick={() => onChange(c)} accent={COLOR_META[c].hex}
          leading={<ChainLogo color={c} size={14} />} />
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
function HubChip({ label, selected, onClick, accent, leading }: { label: string; selected: boolean; onClick: () => void; accent?: string; leading?: React.ReactNode }) {
  const col = accent ?? HUB.violet;
  return (
    <button onClick={onClick} aria-pressed={selected} className="hub-anim" style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 9, cursor: 'pointer',
      fontSize: 11.5, fontWeight: 700, letterSpacing: '0.04em',
      background: selected ? `${col}22` : HUB.surface, color: selected ? (accent ?? HUB.text) : HUB.muted,
      border: `1px solid ${selected ? col : HUB.border}`, transition: 'all .15s ease',
    }}>
      {leading ?? (accent && <span style={{ width: 8, height: 8, borderRadius: 2, background: accent }} />)}
      {label}
    </button>
  );
}

// ── Card tile (memoized) ────────────────────────────────────────────────────
const HubCardTile = React.memo(function HubCardTile({ def, inDeck, cap, deckFull, onAdd, showAdd = true, owned, ownedHint }: {
  def: CardDef; inDeck: number; cap: number; deckFull: boolean; onAdd?: () => void; showAdd?: boolean; owned?: number;
  /**
   * Server-confirmed copies owned, shown as a NON-BLOCKING badge. Unlike
   * `owned`, it never locks the tile: the server ungates casual and solo, so
   * the builder shows the constraint rather than enforcing it.
   */
  ownedHint?: number;
}) {
  const meta = COLOR_META[def.color];
  const atCap = inDeck >= cap;
  const cost = def.cost ? Object.values(def.cost).reduce((s, n) => s + (n ?? 0), 0) : null;
  const notOwned = owned === 0;
  const capLabel = owned != null ? (owned === Infinity ? '∞' : String(owned)) : (cap === Infinity ? '∞' : String(cap));
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
            /* Decorative — the tile footer below already names the chain. */
            : <ChainLogo color={def.color} size={64} />}
          {cost != null && <span style={{ position: 'absolute', top: 6, left: 6, minWidth: 22, height: 22, padding: '0 6px', borderRadius: 8,
            background: 'rgba(0,0,0,0.72)', color: '#fff', fontSize: 12, fontWeight: 900, display: 'grid', placeItems: 'center' }}>{cost}</span>}
          <span style={{ position: 'absolute', top: 6, right: 6, padding: '2px 7px', borderRadius: 999, fontSize: 9, fontWeight: 800,
            letterSpacing: '0.06em', background: 'rgba(0,0,0,0.7)', color: '#fff', textTransform: 'uppercase' }}>{def.type}</span>
          {def.type === 'meme' && def.power != null && (
            <span style={{ position: 'absolute', bottom: 6, right: 6, padding: '2px 7px', borderRadius: 6, background: 'rgba(0,0,0,0.78)', color: '#fff', fontSize: 12, fontWeight: 900 }}>{def.power}/{def.toughness}</span>
          )}
          {inDeck > 0 && <span style={{ position: 'absolute', bottom: 6, left: 6, padding: '2px 8px', borderRadius: 999, background: meta.hex, color: meta.ink, fontSize: 11, fontWeight: 900 }}>×{inDeck}</span>}
          {notOwned && <span style={{ position: 'absolute', inset: 0, background: 'rgba(5,7,17,0.6)', display: 'grid', placeItems: 'center' }}>
            <span style={{ padding: '3px 9px', borderRadius: 999, background: 'rgba(0,0,0,0.8)', border: `1px solid ${HUB.border}`, color: HUB.muted, fontSize: 10, fontWeight: 800, letterSpacing: '0.06em' }}>NOT OWNED</span>
          </span>}
        </div>
        <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: HUB.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{def.name}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: HUB.muted }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: meta.hex }} />{meta.name}
            </span>
            <span style={{ fontSize: 10.5, color: notOwned ? '#E0525E' : atCap ? HUB.gold : HUB.muted }}>
              {owned != null ? (showAdd ? `${inDeck} / ${capLabel} owned` : `${capLabel} owned`) : `${inDeck}/${capLabel}`}
              {owned == null && ownedHint != null && (ownedHint > 0 || inDeck > ownedHint) && (
                <span title={inDeck > ownedHint ? 'Fine for casual and solo — ranked and wager need cards you own' : 'Copies in your collection'}
                  style={{ color: inDeck > ownedHint ? HUB.gold : HUB.muted, opacity: inDeck > ownedHint ? 1 : 0.8 }}>
                  {' · '}{ownedHint} owned
                </span>
              )}
            </span>
          </div>
          {showAdd && (
            <button onClick={onAdd} disabled={disabled} aria-label={notOwned ? `${def.name} — not owned` : `Add ${def.name} to deck`} className="hub-anim"
              style={{ marginTop: 2, padding: '7px 0', borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 800, fontSize: 13,
                color: disabled ? HUB.muted : '#fff', background: disabled ? HUB.raised : `linear-gradient(180deg, ${HUB.purple}, ${HUB.violet})`,
                border: `1px solid ${disabled ? HUB.border : HUB.violet}` }}>
              {notOwned ? 'LOCKED' : deckFull ? 'DECK FULL' : atCap ? 'AT LIMIT' : '+ ADD'}
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
  // Deck ids are bigint-safe decimal STRINGS. Never `parseInt` one.
  const [editingId, setEditingId] = useState<string | null>(null);
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
  /** Per-issue detail from a failed `POST /api/decks/:id/activate`. */
  const [activationIssues, setActivationIssues] = useState<string[]>([]);
  const liveRef = useRef<HTMLDivElement>(null);

  // Owned-card collection, from the server. Shown, never enforced — see the
  // note on `v60` below and `ownedIssues` further down.
  const collection = useCollection();
  useEffect(() => { void refreshCollection(); }, []);

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
        const list = await listDecksApi();
        setDecks(list);
        loadInto(list.find((d) => d.isActive) ?? list[0] ?? null);
      } catch (e) {
        setStatus({ msg: errorText(e), ok: false });
      } finally { setLoading(false); }
    })();
  }, [myName, loadInto]);

  const deckList = useMemo(() => { const out: string[] = []; for (const [id, n] of Object.entries(counts)) for (let i = 0; i < n; i++) out.push(id); return out; }, [counts]);
  const total = deckList.length;
  // FORMAT rules only: exactly 60 cards, max 4 copies of a non-node card.
  // Card OWNERSHIP is deliberately not checked here — casual play lets anyone
  // build any deck they like, from the whole catalogue, for free. Ownership is
  // a RANKED entry requirement (booster-minted cards only), and ranked is the
  // only place it may be enforced. Enforcing it in the builder locked every
  // new player to node-only decks, which is the opposite of the intent.
  const v60 = useMemo(() => validateDeck(deckList), [deckList]);
  const copyIssues = useMemo(() => validateDeck(deckList, { requireSize: false }).issues, [deckList]);
  /**
   * Ownership advisory, mirroring the server's ranked/wager seating check
   * (`400 details.reason = 'unowned_cards'`).
   *
   * ADVISORY, NOT A GATE. The server ungates casual, so this deck stays
   * savable, activatable and playable — it just cannot enter ranked or a wager
   * until the collection covers it. Returns `[]` while ownership is unknown
   * (signed out, or never synced), because "we have not looked" must never
   * render as "you own none of this".
   */
  const ownedIssues = useMemo(
    () => ownershipIssues(deckList).map((i) => i.message),
    // `collection` is the dependency that matters: the answer changes when the
    // snapshot does, not only when the decklist does.
    [deckList, collection],
  );
  /**
   * Copies the player actually owns, for a non-blocking badge in the library.
   *
   * `undefined` hides it, which is the right answer twice over: Basic Nodes are
   * free and unlimited (the server skips them entirely), and an unconfirmed
   * snapshot must never render as "0 owned".
   */
  const ownedHintFor = useCallback((id: string): number | undefined => {
    if (isBasicNode(id)) return undefined;
    if (collection.needsSync || collection.source === 'signed-out') return undefined;
    return ownedCount(id);
  }, [collection]);
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
      // Format copy limit only — nodes are unlimited, everything else caps at 4.
      // No ownership cap: see the note on `v60` above.
      const cap = isBasicNode(id) ? Infinity : MAX_COPIES_NONBASIC;
      if (next > cap) next = cap;
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

  async function refreshDecks() { try { setDecks(await listDecksApi()); } catch { /* status already shown */ } onDecksChanged(); }

  /**
   * Save WITHOUT requiring 60 cards.
   *
   * `POST /api/decks` and `PUT /api/decks/:id` validate card ids and copy
   * limits but deliberately NOT size, so a half-built deck is savable and the
   * player does not lose an hour of work to a page refresh. The 60-card gate
   * lives on `activate()` alone — see `makeActive()` below.
   */
  async function save() {
    if (saving || !deckName.trim()) return;
    setSaving(true); setStatus(null);
    try {
      if (editingId !== null) {
        const up = await updateDeckApi(editingId, { cards: deckList, name: deckName.trim() });
        setSavedSnapshot(JSON.stringify([...up.cards].sort()));
        setDecks((prev) => prev.map((d) => d.id === editingId ? { ...d, cards: up.cards, name: up.name } : d));
      } else {
        const created = await createDeckApi(deckName.trim(), deckList);
        setEditingId(created.id); setSavedSnapshot(JSON.stringify([...created.cards].sort()));
        setDecks((prev) => [...prev, created]);
      }
      setStatus({
        msg: total === DECK_SIZE ? 'Deck saved.' : `Draft saved — ${total}/${DECK_SIZE} cards.`,
        ok: true,
      });
      onDecksChanged();
    } catch (e) { setStatus({ msg: errorText(e), ok: false }); }
    finally { setSaving(false); }
  }

  /**
   * Save, then activate — the only route that enforces full legality.
   *
   * The server re-reads the STORED deck, so this saves first. On failure it
   * returns structured `issues` (`{code:'size'|'unknown'|'copies', message}`)
   * and every one of them is shown: the server knows exactly what is wrong and
   * "invalid deck" would be throwing that away.
   */
  async function makeActive() {
    if (saving || !deckName.trim()) return;
    setSaving(true); setStatus(null); setActivationIssues([]);
    try {
      let id = editingId;
      if (id === null) {
        const created = await createDeckApi(deckName.trim(), deckList);
        id = created.id;
        setEditingId(id);
        setDecks((prev) => [...prev, created]);
      } else {
        const up = await updateDeckApi(id, { cards: deckList, name: deckName.trim() });
        setDecks((prev) => prev.map((d) => d.id === up.id ? { ...d, cards: up.cards, name: up.name } : d));
      }
      setSavedSnapshot(JSON.stringify([...deckList].sort()));
      const activated = await activateDeckApi(id);
      setDecks((prev) => prev.map((d) => ({ ...d, isActive: d.id === activated.id })));
      setStatus({ msg: 'This is now your active deck — matches will seat you with it.', ok: true });
      onDecksChanged();
    } catch (e) {
      if (decksApi.isDeckLegalityError(e)) {
        setActivationIssues(decksApi.deckIssues(e).map((i) => i.message));
        setStatus({ msg: 'This deck cannot be activated yet.', ok: false });
      } else {
        setStatus({ msg: errorText(e), ok: false });
      }
    } finally { setSaving(false); }
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
    setStatus(null); setActivationIssues([]);
    try {
      await activateDeckApi(d.id);
      setDecks((prev) => prev.map((x) => ({ ...x, isActive: x.id === d.id })));
      onDecksChanged();
    } catch (e) {
      if (decksApi.isDeckLegalityError(e)) {
        setActivationIssues(decksApi.deckIssues(e).map((i) => i.message));
        setStatus({ msg: `“${d.name}” cannot be activated yet.`, ok: false });
      } else {
        setStatus({ msg: errorText(e), ok: false });
      }
    }
  }
  async function duplicate(d: DeckEntry) {
    try { const c = await createDeckApi(`${d.name} copy`, d.cards); setDecks((prev) => [...prev, c]); onDecksChanged(); }
    catch (e) { setStatus({ msg: errorText(e), ok: false }); }
  }
  async function removeDeck(d: DeckEntry) {
    if (!window.confirm(`Delete “${d.name}”? This cannot be undone.`)) return;
    setStatus(null);
    try {
      await deleteDeckApi(d.id);
      const remaining = decks.filter((x) => x.id !== d.id);
      setDecks(remaining);
      if (editingId === d.id) loadInto(remaining.find((x) => x.isActive) ?? remaining[0] ?? null);
      onDecksChanged();
    } catch (e) {
      // A deck that has ever been seated into a match cannot be deleted: the
      // server returns a bare 400 from a foreign-key violation in
      // `game.matches`, with no `details.reason` to branch on. Cancelling the
      // match does not release it. Say what actually happened and point at the
      // thing that does work, rather than failing silently as this used to.
      if (decksApi.isUndeletableDeckError(e)) {
        setStatus({
          msg: `“${d.name}” has been played, so it is kept for match history and cannot be deleted. Rename it or replace its cards instead.`,
          ok: false,
        });
      } else {
        setStatus({ msg: errorText(e), ok: false });
      }
    }
  }

  const deckFull = total >= DECK_SIZE;

  const panel = (
    <CurrentDeckPanel
      deckName={deckName} setDeckName={setDeckName} total={total} legality={legality}
      counts={counts} bump={bump} copyIssues={copyIssues} v60={v60} dirty={dirty}
      canSave={!!deckName.trim() && !saving}
      canActivate={!!deckName.trim() && total === DECK_SIZE && v60.ok && !saving}
      activationIssues={activationIssues} ownedIssues={ownedIssues}
      saving={saving} status={status} onSave={save} onActivate={makeActive} onClear={clearDeck} onNew={newDeck}
      onOpenLibrary={() => setShowLibrary(true)} savedCount={decks.length} editingId={editingId}
    />
  );

  return (
    <div style={{ height: '100%', display: 'flex', gap: 14, minHeight: 0, flexDirection: mobile ? 'column' : 'row',
      // Leave room for the fixed "CURRENT DECK" bar on mobile so it never covers the library.
      paddingBottom: mobile ? 'calc(64px + env(safe-area-inset-bottom))' : 0 }}>
      <div aria-live="polite" ref={liveRef} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }} />

      {/* Card library */}
      <div style={{ flex: mobile ? '1 1 auto' : '2 1 0', minWidth: 0, display: 'flex', flexDirection: 'column',
        borderRadius: 14, background: HUB.raised, border: `1px solid ${HUB.border}`, minHeight: 0 }}>
        <div style={{ padding: 14, borderBottom: `1px solid ${HUB.border}` }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
            <span style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: 17, color: HUB.goldHi, display: 'inline-flex', alignItems: 'center', gap: 9 }}><Diamond size={10} /> CARD LIBRARY</span>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: HUB.muted }}>BUILD A 60-CARD DECK</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180 }}>
              <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: HUB.muted, display: 'inline-flex' }} aria-hidden><Search size={14} /></span>
              <input value={rawSearch} onChange={(e) => setRawSearch(e.target.value)} placeholder="Search cards…" aria-label="Search cards"
                style={{ width: '100%', padding: '9px 10px 9px 32px', borderRadius: 9, background: HUB.surface, border: `1px solid ${HUB.border}`, color: HUB.text, fontSize: 13, outline: 'none' }} />
            </div>
            <select value={sort} onChange={(e) => setSort(e.target.value as any)} aria-label="Sort cards"
              style={{ padding: '9px 10px', borderRadius: 9, background: HUB.surface, border: `1px solid ${HUB.border}`, color: HUB.text, fontSize: 12.5 }}>
              <option value="name">SORT: NAME</option><option value="cost">SORT: COST</option>
              <option value="chain">SORT: CHAIN</option><option value="type">SORT: TYPE</option>
            </select>
            <div style={{ display: 'flex', borderRadius: 9, overflow: 'hidden', border: `1px solid ${HUB.border}` }}>
              <button onClick={() => setView('grid')} aria-label="Grid view" aria-pressed={view === 'grid'} style={{ padding: '8px 11px', background: view === 'grid' ? HUB.purple : HUB.surface, color: '#fff', border: 'none', cursor: 'pointer', display: 'grid', placeItems: 'center' }}><GridView size={15} /></button>
              <button onClick={() => setView('list')} aria-label="List view" aria-pressed={view === 'list'} style={{ padding: '8px 11px', background: view === 'list' ? HUB.purple : HUB.surface, color: '#fff', border: 'none', cursor: 'pointer', display: 'grid', placeItems: 'center' }}><ListView size={15} /></button>
            </div>
            <button onClick={() => setShowAdvanced((v) => !v)} aria-label="Advanced filters" aria-pressed={showAdvanced}
              style={{ padding: '8px 11px', borderRadius: 9, background: showAdvanced ? HUB.purple : HUB.surface, color: showAdvanced ? '#fff' : HUB.muted, border: `1px solid ${HUB.border}`, cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Settings size={15} /></button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}><ChainChips value={chain} onChange={setChain} /></div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
            <TypeChips value={type} onChange={setType} />
            <button onClick={() => { setChain('all'); setType('all'); setRawSearch(''); setOwnFilter('all'); setSort('name'); }}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: HUB.muted, cursor: 'pointer', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em', display: 'inline-flex', alignItems: 'center', gap: 6 }}>RESET <Refresh size={12} /></button>
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
                    cap={isBasicNode(def.id) ? Infinity : MAX_COPIES_NONBASIC} deckFull={deckFull} onAdd={() => bump(def.id, +1)}
                    ownedHint={ownedHintFor(def.id)} />
                ))}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {visible.map((def) => (
                  <LibraryRow key={def.id} def={def} inDeck={counts[def.id] ?? 0}
                    cap={isBasicNode(def.id) ? Infinity : MAX_COPIES_NONBASIC} deckFull={deckFull} onAdd={() => bump(def.id, +1)}
                    ownedHint={ownedHintFor(def.id)} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Current-deck panel (desktop persistent; mobile drawer) */}
      {!mobile ? <div style={{ flex: '1 1 0', minWidth: 320, maxWidth: 440, display: 'flex', minHeight: 0 }}>{panel}</div> : (
        <>
          <button onClick={() => setMobilePanel(true)} style={{ position: 'fixed', left: 12, right: 12, bottom: 'calc(12px + env(safe-area-inset-bottom))', zIndex: 50,
            padding: '14px', minHeight: 48, borderRadius: 12,
            background: `linear-gradient(180deg, ${HUB.purple}, ${HUB.violet})`, color: '#fff', border: 'none', fontWeight: 800, letterSpacing: '0.06em',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>CURRENT DECK · {total}/{DECK_SIZE} · {legality}</button>
          {mobilePanel && (
            <div onClick={() => setMobilePanel(false)} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(3,4,10,0.7)',
              backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', display: 'flex', alignItems: 'flex-end' }}>
              <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxHeight: '85dvh', display: 'flex',
                paddingBottom: 'env(safe-area-inset-bottom)', background: HUB.raised, borderRadius: '14px 14px 0 0' }}>{panel}</div>
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

function LibraryRow({ def, inDeck, cap, deckFull, onAdd, owned, ownedHint }: {
  def: CardDef; inDeck: number; cap: number; deckFull: boolean; onAdd: () => void; owned?: number;
  /** Non-blocking "N owned" badge — see `HubCardTile`. */
  ownedHint?: number;
}) {
  const meta = COLOR_META[def.color];
  const cost = def.cost ? Object.values(def.cost).reduce((s, n) => s + (n ?? 0), 0) : null;
  const atCap = inDeck >= cap;
  const notOwned = owned === 0;
  const disabled = atCap || deckFull;
  const ownLabel = owned != null ? (owned === Infinity ? '∞' : String(owned)) : (cap === Infinity ? '∞' : String(cap));
  return (
    <CardHover defId={def.id}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 9, background: HUB.surface,
        border: `1px solid ${inDeck > 0 ? meta.hex + '77' : HUB.border}` }}>
        <div style={{ width: 34, height: 44, borderRadius: 6, overflow: 'hidden', background: `linear-gradient(160deg, ${meta.hex}, #0a1020)`, flex: 'none', display: 'grid', placeItems: 'center' }}>
          {/* This row has no chain name in text (only a colour dot), so the logo
              is the sole carrier of chain identity and takes a real alt. */}
          {def.image ? <img src={def.image} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <ChainLogo color={def.color} size={26} alt={meta.name} />}
        </div>
        {cost != null && <span style={{ minWidth: 22, height: 22, borderRadius: 6, background: HUB.raised, border: `1px solid ${HUB.border}`, display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 800, flex: 'none' }}>{cost}</span>}
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{def.name}</span>
        <span style={{ fontSize: 10.5, color: HUB.muted, display: 'inline-flex', gap: 5, alignItems: 'center' }}><span style={{ width: 8, height: 8, borderRadius: 2, background: meta.hex }} />{def.type}</span>
        {notOwned && <span style={{ fontSize: 9.5, fontWeight: 800, color: '#E0525E' }}>LOCKED</span>}
        {owned == null && ownedHint != null && (ownedHint > 0 || inDeck > ownedHint) && (
          <span title={inDeck > ownedHint ? 'Fine for casual and solo — ranked and wager need cards you own' : 'Copies in your collection'}
            style={{ fontSize: 10, flex: 'none', color: inDeck > ownedHint ? HUB.gold : HUB.muted }}>{ownedHint} owned</span>
        )}
        <span style={{ fontSize: 11, color: notOwned ? '#E0525E' : atCap ? HUB.gold : HUB.muted, width: 60, textAlign: 'right' }}>{inDeck} / {ownLabel}</span>
        <button onClick={onAdd} disabled={disabled} aria-label={notOwned ? `${def.name} — not owned` : `Add ${def.name}`} style={{ width: 30, height: 30, borderRadius: 8, flex: 'none',
          background: disabled ? HUB.raised : `linear-gradient(180deg, ${HUB.purple}, ${HUB.violet})`, color: disabled ? HUB.muted : '#fff',
          border: `1px solid ${disabled ? HUB.border : HUB.violet}`, cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 900 }}>+</button>
      </div>
    </CardHover>
  );
}

function CurrentDeckPanel(props: {
  deckName: string; setDeckName: (s: string) => void; total: number; legality: 'EMPTY' | 'INCOMPLETE' | 'INVALID' | 'READY';
  counts: Record<string, number>; bump: (id: string, d: number) => void; copyIssues: DeckIssue[]; v60: DeckValidation; dirty: boolean;
  /** Saving is always allowed — the server does not enforce size on save. */
  canSave: boolean;
  /** Activating requires a full legal 60. That is the ONLY server-side gate. */
  canActivate: boolean;
  /** Per-issue detail from a rejected activation. */
  activationIssues: string[];
  /**
   * Cards this deck uses that the player's collection does not cover.
   *
   * ADVISORY ONLY. The server gates ranked and wager on ownership and leaves
   * casual ungated, so this never disables Save or Set Active — it explains
   * which modes the deck can enter.
   */
  ownedIssues: string[];
  saving: boolean; status: { msg: string; ok: boolean } | null;
  onSave: () => void; onActivate: () => void; onClear: () => void; onNew: () => void;
  onOpenLibrary: () => void; savedCount: number; editingId: string | null;
}) {
  const { deckName, setDeckName, total, legality, counts, bump, copyIssues, v60, dirty, canSave, canActivate, activationIssues, ownedIssues, saving, status, onSave, onActivate, onClear, onNew, onOpenLibrary, savedCount } = props;
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
          <span style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: 16, color: HUB.goldHi, display: 'inline-flex', alignItems: 'center', gap: 9 }}><Diamond size={10} /> CURRENT DECK</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={onNew} style={{ padding: '6px 12px', borderRadius: 8, background: 'transparent', border: `1px solid ${HUB.violet}`, color: HUB.violet, cursor: 'pointer', fontWeight: 800, fontSize: 11 }}>NEW</button>
            <button onClick={onOpenLibrary} title="Saved decks" aria-label="Open saved decks" style={{ minWidth: 32, height: 30, padding: '0 8px', borderRadius: 8, background: HUB.surface, border: `1px solid ${HUB.border}`, color: HUB.text, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
              <Folder size={15} />{savedCount > 0 && <span style={{ fontSize: 9, color: HUB.gold }}>{savedCount}</span>}
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
          <button onClick={() => setEditingName((v) => !v)} aria-label="Rename deck" style={{ background: 'none', border: 'none', color: HUB.muted, cursor: 'pointer', display: 'inline-flex' }}><EditIcon size={15} /></button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: total === DECK_SIZE ? HUB.green : HUB.text, lineHeight: 1 }}>
            {total}<span style={{ fontSize: 15, color: HUB.muted, fontWeight: 700 }}> / {DECK_SIZE}</span>
          </div>
          <div style={{ flex: 1, height: 8, borderRadius: 999, background: HUB.surface, border: `1px solid ${HUB.border}`, overflow: 'hidden' }}>
            <div className="hub-anim" style={{ width: `${pct}%`, height: '100%', transition: 'width .2s ease', background: legality === 'READY' ? `linear-gradient(90deg, ${HUB.gold}, ${HUB.green})` : `linear-gradient(90deg, ${HUB.gold}, ${HUB.violet})` }} />
          </div>
          <span style={{ padding: '4px 10px', borderRadius: 999, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', color: legColor, background: `${legColor}1c`, border: `1px solid ${legColor}66` }}>
            {legality === 'EMPTY' ? 'INCOMPLETE' : legality}{dirty ? <Dot size={5} style={{ marginLeft: 5, verticalAlign: 'middle' }} /> : null}
          </span>
        </div>
      </div>

      <div className="hub-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 14 }}>
        {total === 0 ? (
          <div style={{ height: '100%', minHeight: 180, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, textAlign: 'center',
            border: `1px dashed ${HUB.border}`, borderRadius: 12, color: HUB.muted }}>
            <div style={{ opacity: 0.5, display: 'flex' }} aria-hidden><DeckIcon size={30} /></div>
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
            {total !== DECK_SIZE && <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Dot size={7} /> {total < DECK_SIZE ? `${DECK_SIZE - total} more card${DECK_SIZE - total === 1 ? '' : 's'} needed` : `Remove ${total - DECK_SIZE} card${total - DECK_SIZE === 1 ? '' : 's'}`}</div>}
            {copyIssues.slice(0, 3).map((it, i) => <div key={i} style={{ color: HUB.red, display: 'flex', alignItems: 'center', gap: 6 }}><Dot size={7} /> {it.message}</div>)}
            {total === DECK_SIZE && v60.ok && <div style={{ color: HUB.green, display: 'flex', alignItems: 'center', gap: 6 }}><Check size={12} /> Deck is legal and ready.</div>}
          </div>
        )}
        {total === 0 && <div style={{ marginBottom: 10, fontSize: 11.5, color: HUB.muted, display: 'flex', alignItems: 'center', gap: 6 }}><Dot size={7} /> 60 cards required · No cards selected</div>}
        {status && <div role="status" style={{ marginBottom: 10, fontSize: 12, color: status.ok ? HUB.green : HUB.red }}>{status.msg}</div>}
        {/* Straight from `POST /api/decks/:id/activate` — the server names the
            exact problem per issue, so show them all rather than a summary. */}
        {activationIssues.length > 0 && (
          <ul style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 12, color: HUB.red, lineHeight: 1.6 }}>
            {activationIssues.map((msg, i) => <li key={i}>{msg}</li>)}
          </ul>
        )}
        {/* Ownership is a RANKED/WAGER entry requirement, not a deck-legality
            rule — the server ungates casual. Gold (advisory), not red, and it
            never disables the buttons below. */}
        {ownedIssues.length > 0 && (
          <div style={{ marginBottom: 10, padding: '9px 11px', borderRadius: 9,
            background: `${HUB.gold}12`, border: `1px solid ${HUB.gold}55` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, fontWeight: 800, letterSpacing: '0.04em', color: HUB.goldHi }}>
              <Warning size={13} /> PLAYABLE IN CASUAL &amp; SOLO — NOT RANKED OR WAGER
            </div>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 11.5, color: HUB.text, lineHeight: 1.55 }}>
              {ownedIssues.slice(0, 4).map((msg, i) => <li key={i}>{msg}</li>)}
              {ownedIssues.length > 4 && <li style={{ color: HUB.muted }}>…and {ownedIssues.length - 4} more.</li>}
            </ul>
            <div style={{ marginTop: 5, fontSize: 11, color: HUB.muted }}>Open boosters to mint the cards you are missing, or swap them out.</div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClear} style={{ padding: '12px 18px', borderRadius: 10, background: HUB.surface, border: `1px solid ${HUB.border}`, color: HUB.text, cursor: 'pointer', fontWeight: 700, letterSpacing: '0.06em', fontSize: 12 }}>CLEAR</button>
          <button onClick={onSave} disabled={!canSave}
            style={{ padding: '12px 18px', borderRadius: 10, background: HUB.surface, border: `1px solid ${HUB.border}`, color: HUB.text, cursor: canSave ? 'pointer' : 'default', fontWeight: 700, letterSpacing: '0.06em', fontSize: 12, opacity: canSave ? 1 : 0.5 }}>
            {saving ? 'SAVING…' : total === DECK_SIZE ? 'SAVE' : 'SAVE DRAFT'}
          </button>
          <button onClick={onActivate} disabled={!canActivate} style={{ ...hubGoldBtn(!canActivate), flex: 1, marginTop: 0, padding: '12px 18px', fontSize: 14 }}>
            {saving ? 'SAVING…' : 'SET AS ACTIVE'}
          </button>
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: HUB.muted, textAlign: 'center', lineHeight: 1.55 }}>
          {total !== DECK_SIZE
            ? `Drafts save at any size. ${DECK_SIZE} cards are required to set a deck active.`
            : 'Your active deck is the one the server seats you with — no deck is chosen per match.'}
        </div>
      </div>
    </div>
  );
}
const deckStep: React.CSSProperties = { width: 24, height: 24, borderRadius: 6, background: HUB.raised, border: `1px solid ${HUB.border}`, color: HUB.text, cursor: 'pointer', fontWeight: 900, fontSize: 14, lineHeight: 1 };

function SavedDeckLibrary({ decks, editingId, onClose, onSelect, onFavorite, onDuplicate, onDelete }: {
  decks: DeckEntry[]; editingId: string | null; onClose: () => void;
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
                      {d.isActive && <span title="Favorite deck" aria-label="Favorite" style={{ color: HUB.goldHi, display: 'inline-flex' }}><Star size={14} /></span>}
                      <span style={{ fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 10.5, color: HUB.muted }}>{d.cards.length} cards</span>
                      {faction && <span style={{ fontSize: 10.5, color: faction.color }}>{faction.name}</span>}
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: ok ? HUB.green : HUB.red }}>{ok ? 'READY' : d.cards.length === DECK_SIZE ? 'INVALID' : 'INCOMPLETE'}</span>
                    </div>
                  </button>
                  {!d.isActive && <button onClick={() => onFavorite(d)} title="Set as favorite" aria-label="Set favorite" style={libAct(HUB.gold)}><StarOutline size={15} /></button>}
                  <button onClick={() => onDuplicate(d)} title="Duplicate" aria-label="Duplicate" style={libAct(HUB.muted)}><Copy size={15} /></button>
                  <button onClick={() => onDelete(d)} title="Delete" aria-label="Delete" style={libAct(HUB.red)}><Trash size={15} /></button>
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
  return { width: 30, height: 30, borderRadius: 8, background: HUB.raised, border: `1px solid ${HUB.border}`, color, cursor: 'pointer', flex: 'none',
    display: 'grid', placeItems: 'center' };
}

// ── Design tokens for the redesigned profile screen ────────────────────────
const PROFILE_FONT = "'Inter', 'Geist', 'Satoshi', system-ui, -apple-system, sans-serif";
const PROFILE_TOKENS = {
  bg:        '#070614',
  card:      '#181433',
  cardSoft:  '#110E24',
  border:    'rgba(217,180,90,0.16)',
  borderHi:  'rgba(217,180,90,0.42)',
  accent:    '#00d18f',
  secondary: '#7c5cff',
  warning:   '#ffb84d',
  danger:    '#ff5d73',
  muted:     '#7d8aa3',
  text:      '#e9eef7',
};

// The old local `formatRankLabel` and `rankGlow` are gone. Both encoded a rank
// shape the server no longer sends (`visibleRank` / `rankedPoints`) and both
// reassembled a label the server now renders itself — including the Mythic
// special case, which it knows about and we should not have to. Use
// `formatRankLabel` and `tierStyle` from `ranked-client.ts`.

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
      <button onClick={onBack} style={profileChip(false)}><ArrowLeft size={13} /> Back</button>
      <div style={{ fontWeight: 800, letterSpacing: 4, fontSize: 12, color: PROFILE_TOKENS.muted }}>PROFILE</div>
      <button onClick={onEdit} style={profileChip(true)}><EditIcon size={13} /> Edit Profile</button>
    </div>
  );
}
function profileChip(accent: boolean): React.CSSProperties {
  return {
    ...obsidianPlate(false),
    padding: '9px 15px', fontSize: 12, letterSpacing: '0.08em',
    color: accent ? '#20170a' : PROFILE_TOKENS.text,
    ...(accent
      ? {
        background: SURF.goldPlate,
        border: `1px solid ${EDGE.bronze}`,
        textShadow: '0 1px 0 rgba(255,255,255,0.28)',
        boxShadow: `${EDGE.bevel}, ${DEPTH.goldGlow}`,
      }
      : {}),
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
          : <div style={{ color: PROFILE_TOKENS.muted, display: 'flex' }}><User size={Math.round(size * 0.5)} /></div>}
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
        <StatCard label="Win Rate" value={`${winPct}%`} color={winPct >= 50 ? PROFILE_TOKENS.accent : PROFILE_TOKENS.danger} icon="chart" />
        <StatCard label="Wins" value={wins} color={PROFILE_TOKENS.accent} icon="trophy" />
        <StatCard label="Losses" value={losses} color={PROFILE_TOKENS.danger} icon="skull" />
        <StatCard label="Games Played" value={games} color={PROFILE_TOKENS.secondary} icon="cards" />
        <StatCard label="Best Streak" value={bestStreak} color={PROFILE_TOKENS.warning} icon="fire" />
        <StatCard label="Draws" value={draws} color={PROFILE_TOKENS.muted} icon="handshake" />
        {favoriteFaction
          ? <StatCard label="Top Faction" value={favoriteFaction.name} color={favoriteFaction.color} icon="chain" small />
          : <StatCard label="Top Faction" value="—" color={PROFILE_TOKENS.muted} icon="chain" small />}
      </div>
    </SectionShell>
  );
}

function StatCard({ label, value, color, icon, small }: { label: string; value: number | string; color: string; icon: IconKey; small?: boolean }) {
  return (
    <div
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = `0 12px 28px -12px ${color}66`; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = `${EDGE.topHighlight}, ${DEPTH.panel}`; }}
      style={{
        padding: '16px 18px', borderRadius: 12,
        background: `linear-gradient(180deg, ${PROFILE_TOKENS.card}, ${PROFILE_TOKENS.cardSoft})`,
        border: `1px solid ${PROFILE_TOKENS.border}`,
        boxShadow: `${EDGE.topHighlight}, ${DEPTH.panel}`,
        transition: 'transform 180ms cubic-bezier(0.2,0.8,0.2,1), box-shadow 190ms ease, border-color 190ms ease',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 10, color: PROFILE_TOKENS.muted, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase' }}>{label}</span>
        <span style={{ color, display: 'inline-flex' }}><Icon name={icon} size={16} /></span>
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
    <section className="ova-panel-orn" style={{
      background: PROFILE_TOKENS.card,
      borderColor: PROFILE_TOKENS.border,
      padding: '22px 24px 26px',
    }}>
      <div style={{ marginBottom: 18 }}>
        {eyebrow && (
          <div style={{ fontSize: 10, color: accent, letterSpacing: '0.22em', fontWeight: 800, textTransform: 'uppercase', marginBottom: 6 }}>
            {eyebrow}
          </div>
        )}
        <div style={{
          fontFamily: '"Cinzel", "EB Garamond", Georgia, serif',
          fontSize: 25, fontWeight: 700, color: '#fff', letterSpacing: '0.03em', lineHeight: 1.1,
          display: 'flex', alignItems: 'center', gap: 14,
        }}>
          {title}
          <span aria-hidden style={{ flex: 1, height: 1, background: `linear-gradient(90deg, ${accent}77, transparent)` }} />
          <Diamond size={9} style={{ color: `${accent}`, opacity: 0.5, flex: 'none' }} />
        </div>
      </div>
      {children}
    </section>
  );
}

// ── ACHIEVEMENTS ───────────────────────────────────────────────────────────
type Achievement = { id: string; icon: IconKey; title: string; description: string; earned: boolean };

function computeAchievements({ prof, deck, ranked }: { prof: Profile | null; deck: string[]; ranked: OwnRankedProfile | null }): Achievement[] {
  const wins = prof?.wins ?? 0;
  const games = (prof?.wins ?? 0) + (prof?.losses ?? 0) + (prof?.draws ?? 0);
  const deckSize = deck.length;
  return [
    { id: 'first-victory', icon: 'trophy', title: 'First Victory', description: 'Win your first match.', earned: wins >= 1 },
    { id: 'rising-star',   icon: 'star', title: 'Rising Star',   description: 'Win 5 matches.',         earned: wins >= 5 },
    { id: 'veteran',       icon: 'medal', title: 'Veteran',       description: 'Play 25 matches.',       earned: games >= 25 },
    { id: 'streak-5',      icon: 'fire', title: '5 Win Streak',   description: 'Win 5 in a row.',         earned: wins >= 5 && games <= wins + 2 },
    { id: 'meme-lord',     icon: 'frog', title: 'Meme Lord',      description: 'Win 25 matches.',         earned: wins >= 25 },
    { id: 'deckbuilder',   icon: 'tools', title: 'Deckbuilder',    description: 'Build a 60-card deck.',  earned: deckSize >= 60 },
    { id: 'nft-collector', icon: 'gem', title: 'NFT Collector', description: 'Link a Solana wallet.',   earned: !!prof?.walletAddress && !prof.walletAddress.startsWith('0x') },
    // Read off the live ladder shape: `placement.inPlacements` is the gate and
    // `rank` is null until it clears, so an unplaced player earns none of these.
    { id: 'placed',        icon: 'medal', title: 'Placed',         description: 'Finish placement matches.', earned: !!ranked && !ranked.placement.inPlacements },
    { id: 'gold-tier',     icon: 'crown', title: 'Gold Tier',      description: 'Reach Gold or higher.',   earned: tierIndex(ranked?.rank?.tier) >= tierIndex('Gold') && tierIndex(ranked?.rank?.tier) >= 0 },
    { id: 'mythic',        icon: 'orb', title: 'Mythic',         description: 'Climb to Mythic rank.',  earned: ranked?.rank?.tier === 'Mythic' },
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
        lineHeight: 1, marginBottom: 6, display: 'flex', justifyContent: 'center',
        color: a.earned ? PROFILE_TOKENS.warning : PROFILE_TOKENS.muted,
        filter: a.earned ? `drop-shadow(0 0 8px ${PROFILE_TOKENS.warning}aa)` : 'none',
      }}>{a.earned ? <Icon name={a.icon} size={30} /> : <Lock size={30} />}</div>
      <div style={{ fontSize: 11, fontWeight: 800, color: a.earned ? '#fff' : PROFILE_TOKENS.muted, letterSpacing: 0.5 }}>{a.title}</div>
      <style>{`@keyframes achPulse{0%,100%{box-shadow:0 0 16px ${PROFILE_TOKENS.warning}33,inset 0 0 8px ${PROFILE_TOKENS.warning}22}50%{box-shadow:0 0 22px ${PROFILE_TOKENS.warning}55,inset 0 0 10px ${PROFILE_TOKENS.warning}33}}`}</style>
    </div>
  );
}

// ── FAVORITE DECK ──────────────────────────────────────────────────────────
function Mini({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: PROFILE_TOKENS.muted, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 800, color }}>{value}</div>
    </div>
  );
}

function EmptyState({ icon, title, message }: { icon: IconKey; title: string; message: string }) {
  return (
    <div style={{
      textAlign: 'center', padding: '36px 20px',
      background: PROFILE_TOKENS.cardSoft, borderRadius: 12,
      border: `1px dashed ${PROFILE_TOKENS.border}`,
    }}>
      <div style={{ opacity: 0.4, marginBottom: 10, display: 'flex', justifyContent: 'center', color: PROFILE_TOKENS.muted }}><Icon name={icon} size={44} /></div>
      <div style={{ fontSize: 16, fontWeight: 800, color: '#cfd6e3' }}>{title}</div>
      <div style={{ fontSize: 12, color: PROFILE_TOKENS.muted, marginTop: 4 }}>{message}</div>
    </div>
  );
}

// ── EDIT MODAL ─────────────────────────────────────────────────────────────
/**
 * Edit YOUR OWN profile.
 *
 * `PATCH /api/profiles/me` edits the caller and nobody else — there is no route
 * that takes a target profile — so this has no name parameter to send.
 *
 * The display name is server state now. New players are given a default
 * derived from their wallet address (e.g. `0xe8ee…de8f`); this is where they
 * change it.
 */
function ProfileEditModal({ prof, onClose, onSaved }: { prof: Profile; onClose: () => void; onSaved: () => void }) {
  const [displayName, setDisplayName] = useState(prof.name);
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
    const trimmed = displayName.trim();
    try {
      await updateMyProfileApi({
        // Only send the name when it actually changed: an unchanged value would
        // still be checked for uniqueness and 409 against the player's own row.
        ...(trimmed && trimmed !== prof.name ? { displayName: trimmed } : {}),
        bio: bio.trim() || null,
        avatarUrl: avatarUrl.trim() || null,
      });
      // The root re-reads the profile; the display name threads through every
      // screen, so it cannot just be updated locally here.
      announceProfileChanged();
      onSaved();
    } catch (e) { setErr(errorText(e)); setSaving(false); }
  }
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20, fontFamily: PROFILE_FONT,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(560px, 100%)', maxHeight: 'calc(100dvh - 40px - env(safe-area-inset-bottom))', overflow: 'auto',
        borderRadius: 16, padding: 24,
        background: `linear-gradient(180deg, ${PROFILE_TOKENS.card}, ${PROFILE_TOKENS.cardSoft})`,
        border: `1px solid ${PROFILE_TOKENS.borderHi}`,
        boxShadow: '0 30px 80px #000c',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#fff', letterSpacing: 0.5 }}>Edit Profile</div>
          <button onClick={onClose} style={profileChip(false)} aria-label="Close"><Close size={14} /></button>
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
          <label htmlFor="prof-display-name" style={{ display: 'block', fontSize: 11, color: PROFILE_TOKENS.muted, letterSpacing: 1.5, fontWeight: 700, marginBottom: 6 }}>DISPLAY NAME</label>
          <input id="prof-display-name" value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={32}
            style={{ width: '100%', padding: '10px 12px', background: PROFILE_TOKENS.bg, color: PROFILE_TOKENS.text, border: `1px solid ${PROFILE_TOKENS.border}`, borderRadius: 8, fontSize: 14, fontFamily: PROFILE_FONT, boxSizing: 'border-box' }} />
          <div style={{ fontSize: 10.5, color: PROFILE_TOKENS.muted, marginTop: 4 }}>
            3–32 characters. Letters, numbers, space and <code>_ . -</code>. Other players find you by this name.
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
        // Only the public profile. Another player's decklist is not readable by
        // anyone — `GET /api/decks` is scoped to the caller's own token, and
        // that is deliberate: a decklist is competitive information.
        const p = await getProfileApi(name);
        if (cancelled) return;
        setProf(p);
        setDeck([]);
      } catch (e) {
        if (!cancelled) setErr(errorText(e));
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
        <button onClick={onBack} style={ghostBtn}><ArrowLeft size={13} /> Back</button>
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
                  <div style={{ color: '#444', display: 'flex' }}><User size={64} /></div>
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, color: '#9cf', letterSpacing: 1.5, fontSize: 14 }}>
                  <Tools size={15} /> {prof.name.toUpperCase()}'S CUSTOM DECK ({deckGrouped.reduce((s, r) => s + r.n, 0)}/{DECK_SIZE})
                </div>
                {deck.length > 0 && (
                  <div style={{ fontSize: 11, color: deckValid.ok ? '#7fdc7f' : '#fc8' }}>
                    {deckValid.ok ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Check size={12} /> Legal</span> : 'Incomplete deck'}
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
            /* Decorative — the card footer below already names the chain. */
            : <ChainLogo color={def.color as Color} size={64} />}
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
  myName, onJoined, onBack, onViewProfile, onSolo, onDeckScreen, onBoosters, onLadder,
  linkProblem, onDismissLinkProblem,
}: {
  myName: string;
  onJoined: (seat: Seat) => void;
  onBack: () => void;
  onViewProfile: (name: string) => void;
  onSolo: () => void;
  /** Open the ranked ladder — a real screen again, not a "coming soon" card. */
  onLadder: () => void;
  /** Send the player to the deck builder — the only fix for `no_active_deck`. */
  onDeckScreen: () => void;
  /**
   * Send the player to boosters — the only way to acquire the cards a ranked
   * deck is checked against. Starter decks are free but not owned, so this is
   * the real fix for the ranked advisory's "short" state.
   */
  onBoosters: () => void;
  /**
   * Why a `#match=<id>` invite link could not be opened.
   *
   * The join happens in `App`, above this screen, but the lobby is where the
   * player is dropped and where they can act — so the banner is rendered here,
   * next to the list of matches they can actually join.
   */
  linkProblem: LinkProblem | null;
  onDismissLinkProblem: () => void;
}) {
  const mobile = useIsMobile();
  const [matches, setMatches] = useState<LobbyEntry[]>([]);
  const [invites, setInvites] = useState<LobbyEntry[]>([]);
  const [leaderboard, setLeaderboard] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  /** Set when the server refused because of the active deck. Shows a CTA, not
   *  a red box the player can do nothing about. */
  const [deckProblem, setDeckProblem] = useState<{ message: string; issues: string[] } | null>(null);
  const [busy, setBusy] = useState<null | 'create' | 'quick' | 'challenge' | string>(null);
  const [plazaOpen, setPlazaOpen] = useState(false);
  const [unlisted, setUnlisted] = useState(false);
  const [challengeTarget, setChallengeTarget] = useState('');
  const [centerTab, setCenterTab] = useState<'quick' | 'create' | 'challenge'>('quick');
  /**
   * The mode the next created match is opened in.
   *
   * Shared by Create Match and Challenge because both are the same
   * `POST /games/create` — a challenge is just a match addressed to one player.
   * Only casual and ranked are offered; see `OFFERED_MODES` for why wager is not.
   */
  const [mode, setMode] = useState<OfferedMode>('casual');

  const [myProfile, setMyProfile] = useState<Profile | null>(null);
  const [myDecks, setMyDecks] = useState<DeckEntry[]>([]);
  /**
   * `false` until `listDecksApi()` has ANSWERED.
   *
   * Without this, `myDecks` is `[]` for the frame or two after mount and
   * `activeDeck` is therefore `null` — which is indistinguishable from "this
   * player genuinely has no active deck". That one ambiguity is what made the
   * FREE STARTER DECKS panel appear and then vanish on every visit, and it
   * would do the same to the ranked deck advisory: a player with a perfectly
   * good ranked deck would be told for a moment that they have none.
   *
   * So: `null`/`[]` no longer carries two meanings. Everything derived from the
   * deck list gates on this flag and renders NOTHING rather than a verdict it
   * is about to contradict. A failed load still sets it — an error is an
   * answer, and leaving the UI in "loading" forever is worse.
   */
  const [decksLoaded, setDecksLoaded] = useState(false);
  const activeDeck = useMemo(() => myDecks.find(d => d.isActive) ?? null, [myDecks]);

  // Ownership for the ranked advisory. The lobby reads the cheap
  // `GET /wager/collection` snapshot once on entry; a full chain scan stays an
  // explicit button, because it is rate limited to 6 per 5 minutes.
  const collection = useCollection();
  useEffect(() => { void refreshCollection(); }, []);
  const collectionSettled = useCollectionSettled(collection);
  /**
   * `null` means WE DO NOT KNOW YET — the deck list or the ownership snapshot
   * has not answered. It is deliberately not `{status:'no-deck'}`, which is a
   * verdict, and a verdict we would have to take back a moment later.
   */
  const rankedDeck: RankedEligibility | null = useMemo(
    () => (decksLoaded && collectionSettled
      ? evaluateRankedDeck(activeDeck?.cards, { known: ownershipKnown(), ownedCount })
      : null),
    // `collection` is the subscription that makes this recompute after a sync;
    // the values themselves come from the module's confirmed snapshot.
    [activeDeck, collection, decksLoaded, collectionSettled],
  );
  const [scanning, setScanning] = useState(false);
  const scanChain = useCallback(async () => {
    setScanning(true);
    try { await syncCollection(); } finally { setScanning(false); }
  }, []);

  /**
   * ONE place where a thrown value becomes lobby UI.
   *
   * `no_active_deck` / `invalid_active_deck` / `unowned_cards` are not errors
   * the player can retry their way out of — they need the deck screen — so they
   * get their own state with a working button instead of a red banner.
   * `unowned_cards` also names each offending card in `details.issues`, which
   * the banner renders as a list; `errorHeadline` keeps them out of the heading
   * so they are not printed twice.
   *
   * `host_deck_unowned` is the opposite case: somebody ELSE's deck failed
   * re-validation, it deliberately carries no card detail, and there is nothing
   * for this player to fix. Plain message, and the caller refreshes the lobby.
   */
  const report = useCallback((e: unknown) => {
    if (isDeckBlocked(e)) {
      setError('');
      setDeckProblem({ message: errorHeadline(e), issues: errorIssues(e) });
      return;
    }
    setDeckProblem(null);
    setError(errorText(e));
  }, []);

  const clearErrors = useCallback(() => { setError(''); setDeckProblem(null); }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const p = await getMyProfileApi();
        if (alive) setMyProfile(p);
      } catch (e) { if (alive) report(e); }
    })();
    return () => { alive = false; };
  }, [report]);

  const reloadDecks = useCallback(async () => {
    try { setMyDecks(await listDecksApi()); }
    catch { /* the deck panel says so */ }
    finally { setDecksLoaded(true); }
  }, []);
  useEffect(() => { void reloadDecks(); }, [reloadDecks]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // `getLobby` replaces boardgame.io's `GET /games/chains-tcg`, which is not
      // mounted any more. Rows carry no setupData, no decklists and no
      // credentials — just what the lobby needs to render.
      const [open, invited, profs] = await Promise.all([
        lobbyApi.getLobby({ limit: 50 }),
        lobbyApi.getInvites().catch(() => [] as LobbyEntry[]),
        listProfilesApi().catch(() => [] as Profile[]),
      ]);
      setMatches(open);
      setInvites(invited);
      setLeaderboard(profs);
      setError('');
    } catch (e) {
      report(e);
    } finally {
      setLoading(false);
    }
  }, [report]);

  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 5000); return () => clearInterval(t); }, [refresh]);

  /** Seat the player once they hold a match id. */
  const enterMatch = useCallback(async (matchID: string) => {
    // After `create` the match is still `open`: no boardgame.io match exists,
    // so `getSeat` returns `credentials: null` and no `playerID`. That is fine
    // — the waiting room polls for them. After `join` we already have both.
    const info = await lobbyApi.getSeat(matchID);
    onJoined(seatFrom(info, myName));
  }, [myName, onJoined]);

  async function createMatch(options: { unlisted?: boolean; invitedDisplayName?: string; mode?: OfferedMode } = {}) {
    clearErrors();
    setBusy(options.invitedDisplayName ? 'challenge' : 'create');
    try {
      // NO DECK IN THE BODY. The server attaches the caller's ACTIVE deck —
      // that is the whole point of the migration, and a stray `deck` key is a
      // 400 against the strict body schema.
      //
      // `mode` decides whether that deck is ownership-checked: ranked (and
      // wager, which this client does not offer) validate every non-Node card
      // against `core.card_ownership` by quantity, and refuse with 400
      // `unowned_cards` — which `report` routes to the deck screen.
      const created = await lobbyApi.create({
        mode: options.mode ?? 'casual',
        ...(options.unlisted !== undefined ? { unlisted: options.unlisted } : {}),
        ...(options.invitedDisplayName ? { invitedDisplayName: options.invitedDisplayName } : {}),
      });
      await enterMatch(created.matchID);
    } catch (e) {
      report(e);
    } finally { setBusy(null); }
  }

  /**
   * Adopt one of the 5 free starter decks: save it, then activate it.
   *
   * The server attaches your ACTIVE deck to a match and takes no deck in the
   * request, so "playing a starter deck" now means "having a starter deck as
   * your active deck". Each starter is already a legal 60, so `activate()`
   * accepts it unchanged.
   */
  async function useStarterDeck(color: Color) {
    clearErrors();
    setBusy('starter');
    try {
      const label = `${COLOR_META[color].name} Starter`;
      // Re-adopting a starter you already saved must not 409 on the name.
      const existing = myDecks.find((d) => d.name === label);
      const deck = existing
        ? await updateDeckApi(existing.id, { cards: STARTER_DECKS[color] })
        : await createDeckApi(label, STARTER_DECKS[color]);
      await activateDeckApi(deck.id);
      await reloadDecks();
    } catch (e) {
      report(e);
    } finally { setBusy(null); }
  }

  async function joinMatch(matchID: string) {
    clearErrors();
    setBusy(matchID);
    try {
      const joined = await lobbyApi.join(matchID);
      onJoined({
        matchID, seat: joined.seat, playerID: joined.playerID,
        credentials: joined.credentials, playerName: myName,
      });
    } catch (e) {
      report(e);
      void refresh();
    } finally { setBusy(null); }
  }

  /** Join the oldest match with a free seat, or open one if there are none. */
  async function quickMatch() {
    clearErrors();
    setBusy('quick');
    try {
      const open = await lobbyApi.getLobby({ limit: 50 });
      // Prefers casual, and only offers a ranked seat to a deck that would
      // actually pass the server's ownership check — otherwise "find a match"
      // would be a button that can only 400. Our own matches are in this list
      // too; joining one is a `self_challenge`.
      // `null` (not loaded yet) is treated exactly like "not ready": Quick Match
      // must never hand a seat to a deck it has not checked.
      const candidate = pickQuickMatch(open, myName, rankedDeck?.status === 'ready');
      if (candidate) {
        const joined = await lobbyApi.join(candidate.matchID);
        onJoined({
          matchID: candidate.matchID, seat: joined.seat, playerID: joined.playerID,
          credentials: joined.credentials, playerName: myName,
        });
        return;
      }
      // Nobody to play: open a casual seat. Quick Match never opens a ranked
      // one — ranked is a deliberate choice, made in Create Match.
      const created = await lobbyApi.create({ mode: 'casual' });
      await enterMatch(created.matchID);
    } catch (e) {
      report(e);
      // The host's deck stopped being legal between listing and joining, so the
      // list on screen is stale — drop the dead entry rather than leaving a
      // button that can only fail.
      if (isHostDeckUnowned(e)) void refresh();
    } finally { setBusy(null); }
  }

  async function sendChallenge() {
    const target = challengeTarget.trim();
    if (!target) { setError("Enter the opponent's exact display name."); return; }
    // The server rejects this too (`reason: 'self_challenge'`); catching it here
    // saves a round trip and reads better.
    if (target.toLowerCase() === myName.toLowerCase()) { setError('You cannot challenge yourself.'); return; }
    // An invite is just a match addressed to one player: it is forced unlisted
    // and shows up in their `GET /games/invites`.
    await createMatch({ invitedDisplayName: target, mode });
    setChallengeTarget('');
  }

  const myGames = myProfile ? myProfile.wins + myProfile.losses + myProfile.draws : 0;
  const myWinPct = myGames ? Math.round((myProfile!.wins / myGames) * 100) : 0;
  const myLevel = myProfile?.level ?? 1;

  // Everything in `matches` is already open and listed — the server filters
  // both, so there is no client-side privacy filter to get wrong any more.
  const openMatches = matches;
  const activity = useMemo(() => buildActivityFeed(matches, leaderboard), [matches, leaderboard]);

  return (
    <div style={{
      position: 'relative', minHeight: '100vh', color: '#e9eef7',
      fontFamily: PROFILE_FONT,
      backgroundImage: 'url(/lobby-bg.png?v=2)',
      backgroundSize: 'cover', backgroundPosition: 'center', backgroundAttachment: 'fixed',
    }}>
      <div aria-hidden style={{
        position: 'fixed', inset: 0, zIndex: 0,
        background: 'linear-gradient(180deg, rgba(7,9,15,0.78) 0%, rgba(7,9,15,0.55) 50%, rgba(7,9,15,0.88) 100%)',
        pointerEvents: 'none',
      }} />
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <LobbyTopBar
          profile={myProfile} myName={myName}
          level={myLevel} winPct={myWinPct} wins={myProfile?.wins ?? 0} losses={myProfile?.losses ?? 0}
          onBack={onBack}
        />

        <button
          onClick={() => window.open('https://play.workadventu.re/@/asdasd-1775062076/asdasd/memetic-masters-hq', '_blank', 'noopener,noreferrer')}
          title="Enter Memetic Masters HQ on WorkAdventure"
          style={{
            position: 'fixed', zIndex: 50,
            ...(mobile
              ? { right: 12, bottom: 'calc(104px + env(safe-area-inset-bottom))' }
              : { right: 16, top: 16 }),
            background: 'linear-gradient(135deg,#3a1f5a,#1b1230)',
            color: '#fff', border: '1px solid #6c4bd8', borderRadius: 8,
            padding: '10px 14px', minHeight: 44, fontWeight: 700, fontSize: 13, cursor: 'pointer',
            boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
          }}
        ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Temple size={16} /> Enter Plaza</span></button>

        <button
          onClick={onSolo}
          title="Play a single-player match against the bot"
          style={{
            position: 'fixed', zIndex: 50,
            ...(mobile
              ? { right: 12, bottom: 'calc(52px + env(safe-area-inset-bottom))' }
              : { right: 16, top: 64 }),
            background: 'linear-gradient(135deg,#1f3a5a,#12203a)',
            color: '#fff', border: '1px solid #4b8ad8', borderRadius: 8,
            padding: '10px 14px', minHeight: 44, fontWeight: 700, fontSize: 13, cursor: 'pointer',
            boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
          }}
        ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Robot size={16} /> VS Bot</span></button>

        {plazaOpen && (
          <Plaza
            matches={matches}
            myName={myName}
            onClose={() => setPlazaOpen(false)}
            onJoinMatch={(m) => { setPlazaOpen(false); void joinMatch(m.matchID); }}
          />
        )}

        {linkProblem && (
          <div style={{ maxWidth: 1480, margin: '12px auto 0', padding: '0 22px', width: '100%' }}>
            <ProblemBanner
              problem={linkProblem}
              actionLabel={linkProblem.action === 'decks' ? 'Open deck builder' : 'Refresh matches'}
              onFix={() => {
                if (linkProblem.action === 'decks') { onDeckScreen(); return; }
                onDismissLinkProblem();
                void refresh();
              }}
              onDismiss={onDismissLinkProblem}
            />
          </div>
        )}

        {deckProblem && (
          <div style={{ maxWidth: 1480, margin: '12px auto 0', padding: '0 22px', width: '100%' }}>
            <ProblemBanner problem={deckProblem} actionLabel="Open deck builder" onFix={onDeckScreen} />
          </div>
        )}

        {error && (
          <div style={{ maxWidth: 1480, margin: '12px auto 0', padding: '0 22px', width: '100%' }}>
            <div role="alert" style={{
              padding: '10px 14px', borderRadius: 10,
              background: 'rgba(255,107,107,0.10)', border: '1px solid rgba(255,107,107,0.45)',
              color: '#ffb4b4', fontSize: 13,
            }}>{error}</div>
          </div>
        )}

        {invites.length > 0 && (
          <div style={{ maxWidth: 1480, margin: '12px auto 0', padding: '0 22px', width: '100%' }}>
            <InvitesBanner
              invites={invites}
              busyId={typeof busy === 'string' ? busy : null}
              onAccept={(m) => { void joinMatch(m.matchID); }}
              onDismiss={(m) => setInvites(prev => prev.filter(x => x.matchID !== m.matchID))}
            />
          </div>
        )}

        <div style={{
          flex: 1, width: '100%', maxWidth: 1480, margin: '0 auto',
          padding: mobile ? '14px 14px calc(150px + env(safe-area-inset-bottom))' : '22px 22px 100px',
          display: 'grid', gap: mobile ? 14 : 18,
          gridTemplateColumns: mobile ? '1fr' : 'minmax(280px, 340px) minmax(0, 1fr) minmax(280px, 340px)',
        }}>
          <OpenMatchesPanel
            matches={openMatches} loading={loading} myName={myName}
            busyId={typeof busy === 'string' ? busy : null}
            onRefresh={() => { void refresh(); }} onJoin={(m) => { void joinMatch(m.matchID); }}
          />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {([
                { k: 'quick',     icon: 'swords', label: 'Quick Match' },
                { k: 'create',    icon: 'plus',   label: 'Create Match' },
                { k: 'challenge', icon: 'target', label: 'Challenge' },
              ] as const).map(t => {
                const active = centerTab === t.k;
                const gold = t.k === 'quick';
                return (
                  <button key={t.k} onClick={() => { setCenterTab(t.k); clearErrors(); }} style={{
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
                    <div style={{ display: 'flex', justifyContent: 'center' }}><Icon name={t.icon} size={19} /></div>
                    <div style={{ marginTop: 4 }}>{t.label}</div>
                  </button>
                );
              })}
            </div>

            <ActiveDeckStrip deck={activeDeck} deckCount={myDecks.length} loaded={decksLoaded} onOpenDecks={onDeckScreen} />

            {/* No active deck? The 5 free starter decks are one click away.
                They are ordinary 60-card decks, so they go through exactly the
                same save + activate path as a custom deck — verified against
                production. This is what makes CASUAL playable without owning
                a single booster card.

                GATED ON `decksLoaded`, not merely on `!activeDeck`: before the
                deck list answers, every player looks deckless, and this panel
                would appear and then vanish on every visit. "We do not know
                yet" renders nothing. */}
            {decksLoaded && !activeDeck && (
              <StarterDeckPicker
                busy={busy === 'starter'}
                onPick={(color) => { void useStarterDeck(color); }}
              />
            )}

            {centerTab === 'quick' && (
              <QuickMatchPanel busy={busy === 'quick'} onQuickMatch={() => { void quickMatch(); }} onLadder={onLadder} />
            )}
            {centerTab === 'create' && (
              <CreateMatchPanel
                unlisted={unlisted} setUnlisted={setUnlisted}
                mode={mode} setMode={setMode}
                ranked={rankedDeck} scanning={scanning || collection.loading}
                onScanChain={() => { void scanChain(); }}
                onDeckScreen={onDeckScreen} onBoosters={onBoosters}
                busy={busy === 'create'}
                onCreate={() => { void createMatch({ unlisted, mode }); }}
              />
            )}
            {centerTab === 'challenge' && (
              <ChallengePanel
                target={challengeTarget} setTarget={setChallengeTarget}
                mode={mode} setMode={setMode}
                ranked={rankedDeck} scanning={scanning || collection.loading}
                onScanChain={() => { void scanChain(); }}
                onDeckScreen={onDeckScreen} onBoosters={onBoosters}
                busy={busy === 'challenge'} onSend={() => { void sendChallenge(); }}
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
          inProgress={0}
          onBack={onBack}
        />
      </div>
    </div>
  );
}

/**
 * The server refused to seat the player, and there is exactly one useful next
 * step.
 *
 * Deliberately not a red error box. `no_active_deck`, `invalid_active_deck` and
 * `unowned_cards` are all fixed in the deck builder; a dead invite link is
 * fixed by picking another match. In every case the banner's job is to name the
 * problem and hand over a working button, so the action label is the caller's.
 * Reasons that carry per-issue detail (`unowned_cards` names each card) list it
 * rather than collapsing to a summary.
 */
function ProblemBanner({ problem, onFix, actionLabel, onDismiss }: {
  problem: { message: string; issues: string[] }; onFix: () => void; actionLabel: string;
  /** When given, adds a dismiss control. Used for advisories the player can ignore. */
  onDismiss?: () => void;
}) {
  return (
    <div role="alert" style={{
      padding: '14px 16px', borderRadius: 12,
      background: 'rgba(217,184,95,0.10)', border: '1px solid rgba(217,184,95,0.55)',
      color: '#f0e2b8', display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap',
    }}>
      <span aria-hidden style={{ color: '#d9b85f', display: 'inline-flex' }}><Warning size={20} /></span>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontWeight: 800, fontSize: 13.5 }}>{problem.message}</div>
        {problem.issues.length > 0 && (
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, color: '#d9c98e', lineHeight: 1.6 }}>
            {problem.issues.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        )}
      </div>
      <button onClick={onFix} style={LOBBY_GOLD_BTN}>{actionLabel}</button>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss"
          style={{ background: 'none', border: 'none', color: '#d9c98e', cursor: 'pointer', display: 'inline-flex', padding: 4 }}>
          <Close size={16} />
        </button>
      )}
    </div>
  );
}

/**
 * Which deck the server will seat you with.
 *
 * The client no longer chooses at match time — `POST /games/create` and
 * `/join` take no deck and attach the caller's ACTIVE one — so the lobby's job
 * is to make it obvious which deck that is before the match starts.
 */
function ActiveDeckStrip({ deck, deckCount, loaded, onOpenDecks }: {
  deck: DeckEntry | null; deckCount: number;
  /** `false` until the deck list has answered — see `decksLoaded` in `Lobby`. */
  loaded: boolean;
  onOpenDecks: () => void;
}) {
  const ok = loaded && deck !== null && deck.cards.length === DECK_SIZE;
  // While the list is loading this strip keeps its shape but makes no claim
  // about the player's decks, so nothing has to be taken back a frame later.
  if (!loaded) {
    return (
      <div style={{ ...LOBBY_GLASS, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span aria-hidden style={{
          width: 30, height: 30, borderRadius: '50%', display: 'grid', placeItems: 'center', flex: 'none',
          background: 'rgba(159,170,191,0.10)', border: `1px solid ${LOBBY_TOKENS.border}`, color: LOBBY_TOKENS.muted,
        }}><DeckIcon size={15} /></span>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontSize: 10, letterSpacing: 2, color: LOBBY_TOKENS.gold, fontWeight: 800 }}>ACTIVE DECK</div>
          <div style={{ fontSize: 13, color: LOBBY_TOKENS.muted, marginTop: 4 }}>Loading your decks…</div>
        </div>
      </div>
    );
  }
  return (
    <div style={{
      ...LOBBY_GLASS, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    }}>
      <span aria-hidden style={{
        width: 30, height: 30, borderRadius: '50%', display: 'grid', placeItems: 'center', flex: 'none',
        background: ok ? 'rgba(0,209,143,0.12)' : 'rgba(217,184,95,0.12)',
        border: `1px solid ${ok ? LOBBY_TOKENS.green : LOBBY_TOKENS.gold}`,
        color: ok ? LOBBY_TOKENS.green : LOBBY_TOKENS.gold,
      }}>{ok ? <Check size={15} /> : <Warning size={15} />}</span>
      <div style={{ flex: 1, minWidth: 160 }}>
        <div style={{ fontSize: 10, letterSpacing: 2, color: LOBBY_TOKENS.gold, fontWeight: 800 }}>ACTIVE DECK</div>
        <div style={{ fontSize: 14, fontWeight: 800, color: '#fff', marginTop: 2 }}>
          {deck ? deck.name : deckCount > 0 ? 'None activated' : 'No decks yet'}
        </div>
        <div style={{ fontSize: 11.5, color: LOBBY_TOKENS.muted, marginTop: 2 }}>
          {deck
            ? `${deck.cards.length} / ${DECK_SIZE} cards · the server seats you with this deck`
            : 'Build a 60-card deck and activate it to play'}
        </div>
      </div>
      <button onClick={onOpenDecks} style={LOBBY_GHOST_BTN}>{deck ? 'Change' : 'Build a deck'}</button>
    </div>
  );
}

/**
 * The 5 free starter decks, one click each.
 *
 * These are the casual-mode on-ramp: a new player has no booster cards and no
 * custom deck, and without this the server correctly refuses to seat them
 * (`no_active_deck`). Picking one saves it as a real deck and makes it active.
 */
function StarterDeckPicker({ busy, onPick }: { busy: boolean; onPick: (c: Color) => void }) {
  return (
    <div style={{ ...LOBBY_GLASS, padding: 16 }}>
      <div style={{
        fontFamily: '"Cinzel", serif', fontSize: 15, fontWeight: 800, letterSpacing: 1.1,
        color: LOBBY_TOKENS.gold, display: 'flex', alignItems: 'center', gap: 9,
      }}><DeckIcon size={16} /> FREE STARTER DECKS</div>
      <div style={{ fontSize: 12.5, color: LOBBY_TOKENS.muted, margin: '7px 0 12px', lineHeight: 1.6 }}>
        Pick a chain to play casual right away — no boosters needed. You can
        build your own deck later; this just becomes your active one.
      </div>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))' }}>
        {COLORS.map((c) => {
          const meta = COLOR_META[c];
          return (
            <button key={c} onClick={() => onPick(c)} disabled={busy}
              title={`Play the ${meta.name} starter deck`}
              style={{
                padding: '11px 8px', minHeight: 44, borderRadius: 10, cursor: busy ? 'default' : 'pointer',
                background: 'rgba(10,15,25,0.75)', color: meta.hex,
                border: `1px solid ${meta.hex}77`, fontFamily: PROFILE_FONT,
                fontWeight: 800, fontSize: 12.5, letterSpacing: 0.3, opacity: busy ? 0.6 : 1,
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
              }}>
              {/* Decorative — the chain name is the button's own label. */}
              <ChainLogo color={c} size={22} />
              {meta.name}
              <div style={{ fontSize: 10, color: LOBBY_TOKENS.muted, marginTop: 3, fontWeight: 600 }}>
                {DECK_SIZE} cards
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Join the first match with a free seat, or open one if the lobby is empty. */
function QuickMatchPanel({ busy, onQuickMatch, onLadder }: { busy: boolean; onQuickMatch: () => void; onLadder: () => void }) {
  return (
    <div style={{ ...LOBBY_GLASS, padding: 18 }}>
      <div style={{
        fontFamily: '"Cinzel", serif', fontSize: 16, fontWeight: 800, letterSpacing: 1.2,
        color: LOBBY_TOKENS.gold, display: 'flex', alignItems: 'center', gap: 10,
      }}><Swords size={17} /> QUICK MATCH</div>
      <div style={{ fontSize: 12.5, color: LOBBY_TOKENS.muted, margin: '8px 0 14px', lineHeight: 1.6 }}>
        Takes the first open casual seat in the lobby — or a ranked one, if your
        active deck already qualifies. If nobody is waiting, it opens a casual
        match and waits for a challenger.
      </div>
      <button onClick={onQuickMatch} disabled={busy} className="ova-plate ova-plate--gold"
        style={{ width: '100%', padding: '14px 18px', fontSize: 13.5, letterSpacing: '0.18em' }}>
        <Swords size={16} /> {busy ? 'FINDING A MATCH…' : 'FIND A MATCH'}
      </button>

      {/* Quick Match takes a SEAT in the lobby. The ladder is a QUEUE the
          server pairs, with LP and a season behind it — a different thing,
          reached from its own screen rather than mixed into this button. */}
      <div style={{
        marginTop: 14, padding: '12px 14px', borderRadius: 10,
        background: 'rgba(143,92,255,0.08)', border: '1px solid rgba(143,92,255,0.45)',
      }}>
        <div style={{
          fontSize: 11, fontWeight: 800, letterSpacing: 1.6, color: '#c8a3ff',
          display: 'flex', alignItems: 'center', gap: 8,
        }}><Trophy size={14} /> RANKED LADDER</div>
        <div style={{ fontSize: 12, color: LOBBY_TOKENS.muted, marginTop: 6, lineHeight: 1.6 }}>
          Climbing is a separate queue: the server pairs you by rating, results
          move your LP, and the season leaderboard lists everyone who has
          finished their placement matches.
        </div>
        <button onClick={onLadder} style={{ ...LOBBY_GHOST_BTN, marginTop: 10, padding: '9px 13px', fontSize: 12 }}>
          <Trophy size={13} /> Open the ladder
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// LOBBY DESIGN TOKENS + REUSABLE BUTTONS
// ─────────────────────────────────────────────────────────────────────────────
const LOBBY_TOKENS = {
  bg:       '#07090f',
  panel:    'rgba(12,11,26,0.78)',
  panelHi:  'rgba(20,18,42,0.86)',
  border:   'rgba(217,184,95,0.18)',
  borderHi: 'rgba(217,184,95,0.52)',
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
  borderRadius: 16,
  backdropFilter: 'blur(14px)',
  WebkitBackdropFilter: 'blur(14px)',
  boxShadow: `${EDGE.topHighlight}, ${DEPTH.panel}`,
};

/** Forged gold plate — the lobby's primary call to action. */
const LOBBY_GOLD_BTN: React.CSSProperties = {
  ...goldPlate(false),
  padding: '12px 20px',
  fontSize: 13,
};

/** Obsidian secondary plate with an engraved gold hairline. */
const LOBBY_GHOST_BTN: React.CSSProperties = {
  ...obsidianPlate(false),
  padding: '10px 15px',
  fontSize: 12.5,
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
          display: 'flex', alignItems: 'center', gap: 10,
        }}><Swords size={16} /> Matchmaking Lobby</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onBack} style={LOBBY_GHOST_BTN}><ArrowLeft size={13} /> Home</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OPEN MATCHES PANEL (left column)
// ─────────────────────────────────────────────────────────────────────────────
function OpenMatchesPanel({ matches, loading, myName, busyId, onRefresh, onJoin }: {
  matches: LobbyEntry[]; loading: boolean; myName: string; busyId: string | null;
  onRefresh: () => void; onJoin: (m: LobbyEntry) => void;
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
        }} title="Refresh" aria-label="Refresh open matches">{loading ? '…' : <Refresh size={14} />}</button>
      </div>
      <div style={{ overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {matches.length === 0 ? (
          <EmptyMatchesState />
        ) : matches.map(m => (
          <MatchCard key={m.matchID} m={m} myName={myName} busy={busyId === m.matchID} onJoin={() => onJoin(m)} />
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
      <div style={{ opacity: 0.5, marginBottom: 8, color: LOBBY_TOKENS.muted, display: 'flex', justifyContent: 'center' }}><Castle size={48} /></div>
      <div style={{ fontFamily: '"Cinzel", serif', fontSize: 15, color: '#fff', fontWeight: 700, letterSpacing: 1 }}>No Open Matches</div>
      <div style={{ fontSize: 12, color: LOBBY_TOKENS.muted, marginTop: 6, lineHeight: 1.5 }}>
        Create the first match and challenge<br/>other players to a duel.
      </div>
    </div>
  );
}

/**
 * One row of `GET /games/lobby`.
 *
 * The row is deliberately thin: `{matchID, mode, seats[{filled, displayName}],
 * createdAt}` and an optional `wagerAmount`. No `setupData`, no decklists, no
 * player ids, no credentials — so there is no chain colour to show any more,
 * because the server does not tell the lobby what anyone is playing.
 */
function MatchCard({ m, myName, busy, onJoin }: {
  m: LobbyEntry; myName: string; busy: boolean; onJoin: () => void;
}) {
  const filled = m.seats.filter(s => s.filled).length;
  const host = m.seats.find(s => s.filled)?.displayName ?? null;
  const isMine = m.seats.some(s => s.displayName === myName);
  const full = filled >= m.seats.length;
  const createdAt = Date.parse(m.createdAt) || Date.now();
  const waitMin = Math.max(0, Math.round((Date.now() - createdAt) / 60000));
  const wagered = m.wagerAmount !== undefined;
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 15, fontWeight: 800, color: '#fff', lineHeight: 1.2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{host ?? 'Open Seat'}</div>
          <div style={{ fontSize: 11, color: LOBBY_TOKENS.muted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Match {m.matchID.slice(0, 8)}
          </div>
        </div>
        <span style={{
          padding: '3px 9px', borderRadius: 999, fontSize: 10, fontWeight: 800,
          background: 'rgba(217,184,95,0.12)', color: '#d9c98e', border: '1px solid rgba(217,184,95,0.45)',
          letterSpacing: 1, textTransform: 'uppercase', flex: '0 0 auto',
        }}>{m.mode}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        {wagered && (
          <span style={{
            padding: '3px 8px', borderRadius: 6, fontSize: 10, fontWeight: 800,
            background: 'rgba(143,92,255,0.18)', color: '#c8a3ff',
            border: '1px solid rgba(143,92,255,0.55)',
            letterSpacing: 0.5, textTransform: 'uppercase',
          }}>Staked</span>
        )}
        <span style={{ fontSize: 11, color: LOBBY_TOKENS.muted }}>
          {filled}/{m.seats.length} · {waitMin > 0 ? `${waitMin}m waiting` : 'just now'}
        </span>
      </div>
      <button onClick={onJoin} disabled={full || isMine || busy}
        className="ova-plate ova-plate--gold"
        style={{
          marginTop: 12, width: '100%', padding: '10px 0',
          fontSize: 12, letterSpacing: '0.16em', borderRadius: 9,
        }}>{
          isMine ? 'YOUR MATCH'
          : full ? 'IN PROGRESS'
          : busy ? 'JOINING…'
          : <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>JOIN MATCH <ArrowRight size={13} /></span>
        }</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MATCH MODE
// ─────────────────────────────────────────────────────────────────────────────
/**
 * CASUAL or RANKED, sent as `POST /games/create {mode}`.
 *
 * Two options, not three: WAGER is not offered at all — no option, no disabled
 * teaser — because its money path is currently pointed at the wrong chain. See
 * `src/match-mode.ts`.
 *
 * Rendered as a radio group rather than a tab strip: this is a property of the
 * match being created, not navigation, and screen readers should say so.
 */
function MatchModePicker({ mode, setMode }: { mode: OfferedMode; setMode: (m: OfferedMode) => void }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, letterSpacing: 1.5, color: LOBBY_TOKENS.muted, fontWeight: 800, marginBottom: 7 }}>
        MATCH MODE
      </div>
      <div role="radiogroup" aria-label="Match mode" style={{
        display: 'grid', gridTemplateColumns: `repeat(${OFFERED_MODES.length}, minmax(0, 1fr))`, gap: 8,
      }}>
        {OFFERED_MODES.map((m) => {
          const active = mode === m;
          const gold = m === 'casual';
          return (
            <button key={m} type="button" role="radio" aria-checked={active}
              onClick={() => setMode(m)}
              style={{
                padding: '11px 8px', minHeight: 44, borderRadius: 11, cursor: 'pointer',
                fontFamily: PROFILE_FONT, fontWeight: 800, fontSize: 12.5, letterSpacing: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                background: active
                  ? (gold ? 'linear-gradient(180deg,#f0d27a,#c69533)' : 'rgba(143,92,255,0.22)')
                  : 'rgba(10,15,25,0.72)',
                color: active ? (gold ? '#1a1408' : '#e6d4ff') : LOBBY_TOKENS.muted,
                border: `1px solid ${active ? (gold ? '#8a6d24' : 'rgba(143,92,255,0.6)') : LOBBY_TOKENS.border}`,
                boxShadow: active ? (gold ? '0 6px 18px -6px #d9b85f88' : '0 0 20px rgba(143,92,255,0.35)') : 'none',
                transition: 'all .15s ease',
              }}>
              {gold ? <Swords size={15} /> : <Trophy size={15} />} {MODE_LABEL[m]}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 11.5, color: LOBBY_TOKENS.muted, marginTop: 8, lineHeight: 1.6 }}>
        {MODE_BLURB[mode]}
      </div>
    </div>
  );
}

/**
 * Whether the active deck will survive the ranked ownership check — said BEFORE
 * the player presses the button rather than as a 400 afterwards.
 *
 * The three states are answers to three different questions and are styled to
 * match: gold "we have not looked" (scan the chain), gold "you are short these
 * cards" (open boosters), green "verified". Nothing here ever DISABLES creating
 * the match: the server is the authority, this snapshot can lag a pack minted
 * seconds ago, and a client-side refusal would be a dead end. If it turns out to
 * be right, `unowned_cards` comes back and `ProblemBanner` names every card.
 */
function RankedDeckNote({ ranked, scanning, onScanChain, onDeckScreen, onBoosters }: {
  /** `null` while the deck list or the ownership snapshot is still loading. */
  ranked: RankedEligibility | null; scanning: boolean;
  onScanChain: () => void; onDeckScreen: () => void; onBoosters: () => void;
}) {
  // Not known yet is not a verdict. Hold the panel's shape and say only that.
  if (ranked === null) {
    return (
      <div style={{
        marginBottom: 12, padding: '12px 14px', borderRadius: 10,
        background: 'rgba(159,170,191,0.06)', border: `1px solid ${LOBBY_TOKENS.border}`,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 11, fontWeight: 800, letterSpacing: 1.4, color: LOBBY_TOKENS.muted,
        }}><Hourglass size={14} /> RANKED · CHECKING YOUR DECK</div>
        <div style={{ fontSize: 12, color: LOBBY_TOKENS.muted, marginTop: 6, lineHeight: 1.6 }}>
          Reading your active deck and the cards you own.
        </div>
      </div>
    );
  }
  const ok = ranked.status === 'ready';
  const accent = ok ? LOBBY_TOKENS.green : LOBBY_TOKENS.gold;
  const heading =
    ranked.status === 'ready'   ? 'RANKED · DECK VERIFIED'
    : ranked.status === 'no-deck' ? 'RANKED · NO ACTIVE DECK'
    : ranked.status === 'unknown' ? 'RANKED · COLLECTION NOT SCANNED'
    : 'RANKED · CARDS YOU DO NOT OWN YET';

  return (
    <div style={{
      marginBottom: 12, padding: '12px 14px', borderRadius: 10,
      background: ok ? 'rgba(0,209,143,0.07)' : 'rgba(217,184,95,0.07)',
      border: `1px solid ${accent}66`,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 11, fontWeight: 800, letterSpacing: 1.4, color: accent,
      }}>
        {ok ? <Check size={14} /> : <Warning size={14} />} {heading}
      </div>

      <div style={{ fontSize: 12, color: LOBBY_TOKENS.muted, marginTop: 6, lineHeight: 1.6 }}>
        {ranked.status === 'no-deck' && (
          <>Activate a deck and we will check it against the cards you own before you open the match.</>
        )}
        {/* NEVER "your deck is illegal" here. Nobody has looked yet. */}
        {ranked.status === 'unknown' && (
          <>Your cards have not been read from the chain yet, so we cannot tell whether this deck
            qualifies. Scan the chain and we will check it — Basic Nodes are free either way.</>
        )}
        {ranked.status === 'ready' && (ranked.checked === 0 ? (
          // A deck of nothing but Nodes is legal and owns itself — the server
          // skips `node_*` entirely, so there is nothing to verify.
          <>Your active deck is {ranked.nodes} Basic Nodes, which are free, unlimited and never
            checked. You are clear to open a ranked match.</>
        ) : (
          <>All {ranked.checked} non-Node card{ranked.checked === 1 ? '' : 's'} in your active deck
            are yours{ranked.nodes > 0 ? `, alongside ${ranked.nodes} free Basic Node${ranked.nodes === 1 ? '' : 's'}` : ''}.
            You are clear to open a ranked match.</>
        ))}
        {ranked.status === 'short' && (
          <>Ranked decks are built from cards you have minted from booster packs, so the free
            starter decks stay casual — that is the design, not a fault. You are short{' '}
            <b style={{ color: '#f0e2b8' }}>{ranked.missingCopies} cop{ranked.missingCopies === 1 ? 'y' : 'ies'}</b>{' '}
            across {ranked.missingCards} card{ranked.missingCards === 1 ? '' : 's'}. Basic Nodes are free and
            unlimited, so a ranked deck can be mostly Nodes plus the cards you have actually pulled.</>
        )}
      </div>

      {ranked.status === 'short' && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 11.5, color: '#d9c98e', lineHeight: 1.65 }}>
          {shortfallLines(ranked.shortfall).map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      )}

      {ranked.status !== 'ready' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {ranked.status === 'no-deck' && (
            <button onClick={onDeckScreen} style={{ ...LOBBY_GHOST_BTN, padding: '8px 12px', fontSize: 11.5 }}>
              <DeckIcon size={13} /> Build a deck
            </button>
          )}
          {ranked.status === 'short' && (
            <>
              <button onClick={onBoosters} style={{ ...LOBBY_GHOST_BTN, padding: '8px 12px', fontSize: 11.5 }}>
                <Gem size={13} /> Open boosters
              </button>
              <button onClick={onDeckScreen} style={{ ...LOBBY_GHOST_BTN, padding: '8px 12px', fontSize: 11.5 }}>
                <DeckIcon size={13} /> Edit deck
              </button>
            </>
          )}
          {ranked.status !== 'no-deck' && (
            /* The one control that can change the answer: the snapshot lags a
               pack minted seconds ago, and a never-synced player needs it. */
            <button onClick={onScanChain} disabled={scanning}
              title="Re-read your CardPack NFTs from Robinhood Chain"
              style={{
                ...LOBBY_GHOST_BTN, padding: '8px 12px', fontSize: 11.5,
                opacity: scanning ? 0.6 : 1, cursor: scanning ? 'default' : 'pointer',
              }}>
              <Refresh size={13} /> {scanning ? 'Scanning…' : 'Scan chain'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE MATCH PANEL (center column)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Opening a match asks for two things: the MODE, and whether it is listed.
 *
 * Everything else is decided elsewhere or not at all: the DECK comes from your
 * active deck (`POST /games/create` takes no deck), the CHAIN COLOUR is gone
 * because the server seats both players with real decklists and
 * `colors: [null, null]`, so nobody enters the colour-pick phase, and the SEAT
 * is fixed — the creator is always seat 0.
 *
 * Stakes are a separate, currently-gated flow: see `WagerControls`.
 */
function CreateMatchPanel({
  unlisted, setUnlisted, mode, setMode, ranked, scanning,
  onScanChain, onDeckScreen, onBoosters, busy, onCreate,
}: {
  unlisted: boolean; setUnlisted: (v: boolean) => void;
  mode: OfferedMode; setMode: (m: OfferedMode) => void;
  ranked: RankedEligibility | null; scanning: boolean;
  onScanChain: () => void; onDeckScreen: () => void; onBoosters: () => void;
  busy: boolean; onCreate: () => void;
}) {
  return (
    <div style={{ ...LOBBY_GLASS, padding: 18 }}>
      <div style={{
        fontFamily: '"Cinzel", serif', fontSize: 16, fontWeight: 800, letterSpacing: 1.2,
        color: LOBBY_TOKENS.gold, display: 'flex', alignItems: 'center', gap: 10,
      }}><Plus size={17} /> CREATE MATCH</div>
      <div style={{ fontSize: 12.5, color: LOBBY_TOKENS.muted, margin: '8px 0 14px', lineHeight: 1.6 }}>
        Opens a match with you in seat 0 and waits for a challenger. You can have
        3 open matches at a time.
      </div>

      <MatchModePicker mode={mode} setMode={setMode} />
      {mode === 'ranked' && (
        <RankedDeckNote ranked={ranked} scanning={scanning}
          onScanChain={onScanChain} onDeckScreen={onDeckScreen} onBoosters={onBoosters} />
      )}

      <label style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10,
        background: 'rgba(0,0,0,0.3)', border: `1px solid ${LOBBY_TOKENS.border}`, cursor: 'pointer',
      }}>
        <input type="checkbox" checked={unlisted} onChange={e => setUnlisted(e.target.checked)}
          style={{ width: 16, height: 16, accentColor: LOBBY_TOKENS.purple }} />
        <span style={{ flex: 1 }}>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: '#fff' }}>Unlisted</span>
          <span style={{ display: 'block', fontSize: 11.5, color: LOBBY_TOKENS.muted, marginTop: 2 }}>
            Nobody else sees it in the lobby — share the invite link from the
            waiting room. You will still see it in your own list.
          </span>
        </span>
      </label>

      <WagerControls />

      {/* Never disabled on the ranked advisory — the server decides who owns
          what, and a stale snapshot must not lock the player out of trying. */}
      <button onClick={onCreate} disabled={busy} className="ova-plate ova-plate--gold"
        style={{ width: '100%', marginTop: 14, padding: '14px 18px', fontSize: 13.5, letterSpacing: '0.18em' }}>
        <Plus size={16} /> {busy ? 'CREATING…' : `CREATE ${MODE_LABEL[mode]} MATCH`}
      </button>
    </div>
  );
}

/**
 * Challenge a specific player by display name.
 *
 * This replaces the old `/api/challenges` inbox, which no longer exists. An
 * invite IS a match: `POST /games/create {invitedDisplayName}` creates one that
 * is forced unlisted and addressed to that player, who sees it in
 * `GET /games/invites`. Accepting is just joining it.
 *
 * There is therefore no "decline" to send and no outgoing-challenge list to
 * poll — declining is local, and cancelling is done from the waiting room.
 */
function ChallengePanel({
  target, setTarget, mode, setMode, ranked, scanning,
  onScanChain, onDeckScreen, onBoosters, busy, onSend,
}: {
  target: string; setTarget: (s: string) => void;
  mode: OfferedMode; setMode: (m: OfferedMode) => void;
  ranked: RankedEligibility | null; scanning: boolean;
  onScanChain: () => void; onDeckScreen: () => void; onBoosters: () => void;
  busy: boolean; onSend: () => void;
}) {
  return (
    <div style={{ ...LOBBY_GLASS, padding: 18 }}>
      <div style={{
        fontFamily: '"Cinzel", serif', fontSize: 16, fontWeight: 800, letterSpacing: 1.2,
        color: LOBBY_TOKENS.gold, display: 'flex', alignItems: 'center', gap: 10,
      }}><Target size={17} /> CHALLENGE A PLAYER</div>
      <div style={{ fontSize: 12.5, color: LOBBY_TOKENS.muted, margin: '8px 0 14px', lineHeight: 1.6 }}>
        Creates an unlisted match only they can see. It appears in their invites
        the next time their lobby refreshes.
      </div>

      <label htmlFor="challenge-target" style={{ fontSize: 11, letterSpacing: 1.5, color: LOBBY_TOKENS.muted, fontWeight: 800 }}>
        OPPONENT DISPLAY NAME
      </label>
      <input id="challenge-target" value={target} onChange={e => setTarget(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && target.trim() && !busy) onSend(); }}
        placeholder="Exact display name" autoComplete="off"
        style={challengeInputStyle()} />

      {/* A challenge is the same `POST /games/create`, so it takes the same
          mode — and the same ownership check when that mode is ranked. */}
      <div style={{ marginTop: 14 }}>
        <MatchModePicker mode={mode} setMode={setMode} />
      </div>
      {mode === 'ranked' && (
        <RankedDeckNote ranked={ranked} scanning={scanning}
          onScanChain={onScanChain} onDeckScreen={onDeckScreen} onBoosters={onBoosters} />
      )}

      <WagerControls />

      <button onClick={onSend} disabled={busy || !target.trim()} className="ova-plate ova-plate--gold"
        style={{ width: '100%', marginTop: 14, padding: '14px 18px', fontSize: 13.5, letterSpacing: '0.18em' }}>
        <Target size={16} /> {busy ? 'SENDING…' : `SEND ${MODE_LABEL[mode]} CHALLENGE`}
      </button>
    </div>
  );
}

/**
 * Matches addressed to you (`GET /games/invites`).
 *
 * Accepting is a plain `join`. "Dismiss" is local only — there is no route that
 * declines an invite, and pretending otherwise would leave the challenger
 * waiting on a signal that never comes. Their match simply stays open until
 * they cancel it.
 */
function InvitesBanner({ invites, busyId, onAccept, onDismiss }: {
  invites: LobbyEntry[]; busyId: string | null;
  onAccept: (m: LobbyEntry) => void; onDismiss: (m: LobbyEntry) => void;
}) {
  return (
    <div style={{
      ...glassPanelStyle(), padding: '12px 14px',
      border: '1px solid rgba(143,92,255,0.55)', background: 'rgba(143,92,255,0.10)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.6, color: '#c8a3ff', marginBottom: 8 }}>
        {invites.length} CHALLENGE{invites.length === 1 ? '' : 'S'} WAITING
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {invites.map(m => {
          const from = m.seats.find(s => s.filled)?.displayName ?? 'Someone';
          return (
            <div key={m.matchID} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ flex: 1, minWidth: 160, fontSize: 13.5, color: '#e9eef7' }}>
                <b style={{ color: '#fff' }}>{from}</b> challenged you
                {m.wagerAmount !== undefined && <span style={{ color: '#c8a3ff' }}> · staked</span>}
              </span>
              <button onClick={() => onAccept(m)} disabled={busyId === m.matchID} style={LOBBY_GOLD_BTN}>
                {busyId === m.matchID ? 'Joining…' : 'Accept'}
              </button>
              <button onClick={() => onDismiss(m)} style={LOBBY_GHOST_BTN}>Dismiss</button>
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
type ActivityItem = { id: string; icon: IconKey; text: React.ReactNode; ts?: number };

function buildActivityFeed(matches: LobbyEntry[], leaderboard: Profile[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const m of matches.slice(0, 6)) {
    const creator = m.seats.find(s => s.filled)?.displayName ?? 'Someone';
    // `wagerAmount` is ABSENT (not null) on a match with no stake. It is
    // advisory metadata for display — it does not mean an escrow exists.
    const staked = m.wagerAmount !== undefined;
    items.push({
      id: `m-${m.matchID}`,
      icon: staked ? 'gem' : 'swords',
      text: <><b style={{ color: '#fff' }}>{creator}</b> opened {staked ? <span style={{ color: '#c8a3ff' }}>a staked match</span> : `a ${m.mode} match`}</>,
    });
  }
  const topPlayer = leaderboard[0];
  if (topPlayer) {
    items.push({
      id: 'lb-top',
      icon: 'crown',
      text: <><b style={{ color: '#d9b85f' }}>{topPlayer.name}</b> is the current top player ({topPlayer.wins}W)</>,
    });
  }
  for (const p of leaderboard.slice(1, 4)) {
    items.push({
      id: `lb-${p.name}`,
      icon: 'star',
      text: <><b style={{ color: '#fff' }}>{p.name}</b> sits at {p.wins}W · {p.losses}L</>,
    });
  }
  if (items.length === 0) {
    items.push({ id: 'idle', icon: 'moon', text: <span style={{ color: '#9faabf' }}>The realm is quiet… for now.</span> });
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
              <span style={{ lineHeight: 1.2, color: LOBBY_TOKENS.gold, display: 'inline-flex' }}><Icon name={a.icon} size={14} /></span>
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
function MatchSeat({ seat, myName, onLeave }: { seat: Seat; myName: string; onLeave: () => void }) {
  const mobile = useIsMobile(860);
  // The socket transport is the ONLY boardgame.io surface left on the server;
  // it lives on the same gateway origin as the API (`SOCKET_URL`). Its lobby
  // REST API is not mounted, which is why every other call here is `lobbyApi`.
  const ChainsClient = useMemo(() => Client({
    game: ChainsTCG,
    board: ChainsBoard,
    numPlayers: 2,
    multiplayer: SocketIO({ server: SOCKET_URL }),
    debug: false,
  }), []);

  /**
   * `GET /games/:id/seat` is the whole waiting room.
   *
   * While `status === 'open'` it returns `credentials: null` and no
   * `playerID` — the boardgame.io match does not exist yet, so there is
   * nothing to connect to. The moment someone joins, the server materialises
   * it and the same call starts returning both. So: poll until the
   * credentials arrive, then stop and mount the client.
   */
  const [info, setInfo] = useState<SeatInfo | null>(null);
  const [seatError, setSeatError] = useState('');
  const credentials = info?.credentials ?? seat.credentials;
  const playerID = info?.playerID ?? seat.playerID;
  const status = info?.status ?? (credentials ? 'live' : 'open');
  const isFull = status !== 'open' && credentials !== null && playerID !== null;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    async function tick() {
      try {
        const next = await lobbyApi.getSeat(seat.matchID);
        if (!alive) return;
        setInfo(next);
        setSeatError('');
        // Terminal or playable: nothing further to learn by asking again.
        if (next.status !== 'open' && timer) { clearInterval(timer); timer = null; }
      } catch (e) {
        // 404 here means the match is gone (cancelled, or never ours).
        if (alive && e instanceof ApiError && e.isNotFound) {
          setSeatError('This match no longer exists.');
          if (timer) { clearInterval(timer); timer = null; }
        }
      }
    }
    void tick();
    timer = setInterval(() => { void tick(); }, 2000);
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [seat.matchID]);

  // The lobby row is the only place the opponent's name is exposed while the
  // match is open; once it is live the board gets both names from the game
  // state. Nothing in the seat response names the other player.
  const players: Array<{ id: number; name?: string }> = useMemo(() => {
    const mine = seat.seat;
    const out: Array<{ id: number; name?: string }> = [{ id: 0 }, { id: 1 }];
    out[mine] = { id: mine, name: myName };
    if (isFull) out[mine === 0 ? 1 : 0] = { id: mine === 0 ? 1 : 0, name: 'Opponent' };
    return out;
  }, [seat.seat, myName, isFull]);

  // "Opponent joined -> entering the arena" interstitial before the game mounts.
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

  // Leave-match flow with confirm + in-flight guard. Shared by the waiting-room
  // LEAVE MATCH button and the in-game exit stud below — one state, one API
  // call, one dialog, so both routes behave identically.
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveErr, setLeaveErr] = useState('');
  async function doLeave() {
    if (leaving) return;
    setLeaving(true); setLeaveErr('');
    try {
      // `POST /games/:id/cancel` only works on YOUR OWN still-open match; it is
      // a 404 for anything else, including a match already in progress. There
      // is no "leave a live match" route — conceding is an in-game move, and
      // the game service writes the result itself. So: cancel if we can, and
      // either way stop occupying the seat locally.
      await lobbyApi.cancel(seat.matchID);
    } catch (e) {
      if (!(e instanceof ApiError && e.isNotFound)) {
        setLeaveErr(errorText(e));
        setLeaving(false);
        return;
      }
    }
    onLeave();
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
      try { await (navigator as any).share({ title: 'On-Chain Virtual Arena', text: 'Join my match on On-Chain Virtual Arena', url: inviteUrl }); return; } catch { /* cancelled -> fall through */ }
    }
    copyInvite();
  }

  // Shared confirmation. `live` swaps the copy for the in-game case, where
  // leaving abandons a match in progress rather than closing an open lobby.
  const renderLeaveDialog = (live: boolean) => !confirmLeave ? null : (
    <div onClick={() => !leaving && setConfirmLeave(false)} style={{
      position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(3,4,10,0.78)',
      backdropFilter: 'blur(4px)', display: 'grid', placeItems: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="leave-match-title" style={{
        width: 'min(440px, 100%)', borderRadius: 14, background: HUB.surface,
        border: `1px solid ${HUB.gold}44`, padding: 22,
      }}>
        <div id="leave-match-title" style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: 20, color: HUB.text }}>
          {live ? 'Forfeit this match?' : 'Leave this match?'}
        </div>
        <div style={{ color: HUB.muted, fontSize: 13.5, marginTop: 8, lineHeight: 1.5 }}>
          {live
            ? 'The match is in progress. Leaving now forfeits it — you give up the duel, your seat is released and you cannot rejoin.'
            : 'The open match will be closed and the invite link will stop working.'}
        </div>
        {leaveErr && <div style={{ color: HUB.red, fontSize: 12.5, marginTop: 10 }}>{leaveErr}</div>}
        <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
          <button onClick={() => setConfirmLeave(false)} disabled={leaving} style={{ padding: '10px 18px', minHeight: 44, borderRadius: 10, background: HUB.raised, border: `1px solid ${HUB.border}`, color: HUB.text, cursor: leaving ? 'default' : 'pointer', fontWeight: 700, letterSpacing: '0.04em' }}>STAY</button>
          <button onClick={doLeave} disabled={leaving} style={{ padding: '10px 18px', minHeight: 44, borderRadius: 10, background: leaving ? '#5a2530' : HUB.red, border: 'none', color: '#fff', cursor: leaving ? 'default' : 'pointer', fontWeight: 800, letterSpacing: '0.04em' }}>
            {leaving ? 'LEAVING…' : (live ? 'FORFEIT & LEAVE' : 'LEAVE MATCH')}
          </button>
        </div>
      </div>
    </div>
  );

  // Once the interstitial elapses and both seats are filled, mount the game.
  if (entered && isFull && playerID !== null && credentials !== null) {
    return (
      <div style={{ background: '#000', minHeight: '100vh' }}>
        <BattleMusic />
        <ChainsClient matchID={seat.matchID} playerID={playerID} credentials={credentials} />
        {/* In-game exit. Before this the only way out of a live match was the
            browser's back button. It reuses the waiting room's confirmLeave /
            doLeave path exactly — same lobby API call, same in-flight guard.
            Placement: the top-right corner, which the board's TurnBanner
            already reserves (see its `paddingRight`) for the host app's exit
            control, so it covers neither the banner, the hand, nor the action
            bar at 390px. z-index 200 puts it above the board's bars (90–150)
            and keeps it reachable during the mulligan overlay (199). */}
        <button
          onClick={() => { setLeaveErr(''); setConfirmLeave(true); }}
          className="brd-stud"
          aria-label="Leave match"
          title="Leave match (forfeits the duel)"
          style={{
            position: 'fixed', zIndex: 200,
            top: 'max(12px, env(safe-area-inset-top))',
            right: 'max(12px, env(safe-area-inset-right))',
            width: 44, height: 44,
          }}
        ><Close size={19} /></button>
        {renderLeaveDialog(true)}
      </div>
    );
  }

  const youAt = seat.seat;
  const p0 = players[0]?.name;
  const p1 = players[1]?.name;
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
      <div style={{ position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        padding: mobile ? '12px 14px' : '16px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <HubEmblem size={30} />
          <div style={{ lineHeight: 1 }}>
            <div style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: 10, letterSpacing: '0.22em', color: HUB.muted }}>ON-CHAIN</div>
            <div style={{ fontFamily: HUB_SERIF, fontWeight: 700, fontSize: 14, letterSpacing: '0.1em', color: HUB.goldHi }}>VIRTUAL ARENA</div>
          </div>
        </div>
        {!mobile && <div style={{ fontFamily: HUB_SERIF, fontWeight: 700, letterSpacing: '0.32em', fontSize: 13, color: HUB.goldHi, textShadow: `0 0 16px ${HUB.gold}66`,
          display: 'flex', alignItems: 'center', gap: 12 }}><DiamondOutline size={9} /> MATCH LOBBY <DiamondOutline size={9} /></div>}
        <button onClick={() => setConfirmLeave(true)} style={{ padding: '9px 16px', minHeight: 44, borderRadius: 9, background: 'transparent', flex: 'none',
          border: `1px solid ${HUB.gold}`, color: HUB.goldHi, cursor: 'pointer', fontWeight: 800, letterSpacing: '0.06em', fontSize: 12, whiteSpace: 'nowrap' }}>LEAVE MATCH</button>
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
              <span style={{ color: copied === 'id' ? HUB.green : HUB.muted, display: 'inline-flex' }}>{copied === 'id' ? <Check size={13} /> : <Copy size={13} />}</span>
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

          {seatError && (
            <div role="alert" style={{ marginTop: 16, color: HUB.red, fontSize: 13, textAlign: 'center' }}>{seatError}</div>
          )}

          {/* Invitation */}
          {!opponentJoined && (
            <div style={{ marginTop: 22, paddingTop: 18, borderTop: `1px solid ${HUB.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, fontFamily: HUB_SERIF, fontWeight: 700, letterSpacing: '0.16em', color: HUB.goldHi, fontSize: 14 }}><DiamondOutline size={9} /> INVITE YOUR OPPONENT <DiamondOutline size={9} /></div>
              <div style={{ textAlign: 'center', color: HUB.muted, fontSize: 12.5, marginTop: 4 }}>Share this private link to fill the open seat.</div>
              <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap', alignItems: 'stretch' }}>
                <input readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link"
                  style={{ flex: '1 1 320px', minWidth: 0, padding: '12px 14px', borderRadius: 10, background: 'rgba(6,8,18,0.8)',
                    border: `1px solid ${HUB.border}`, color: HUB.cyan, fontFamily: F.mono, fontSize: 12.5, outline: 'none' }} />
                <button onClick={copyInvite} style={{ ...hubGoldBtn(false), marginTop: 0, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '12px 20px', fontSize: 13 }}>
                  <Copy size={14} /> {copied === 'link' ? 'LINK COPIED' : 'COPY INVITE LINK'}
                </button>
                <button onClick={share} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '12px 20px', borderRadius: 10,
                  background: `linear-gradient(180deg, ${HUB.purple}, ${HUB.violet})`, color: '#fff', border: `1px solid ${HUB.violet}`, cursor: 'pointer', fontWeight: 800, letterSpacing: '0.04em', fontSize: 13 }}><ArrowUpRight size={14} /> SHARE</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: HUB.muted, fontSize: 12, marginTop: 14 }}><DiamondOutline size={8} /> The duel will begin automatically when Player 1 joins.</div>
            </div>
          )}
        </div>
      </div>

      {renderLeaveDialog(false)}
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
      <div style={{ position: 'relative', width: 'min(300px, 100%)', height: 60, display: 'grid', placeItems: 'center' }}>
        {/* orbiting rune ring */}
        <svg viewBox="0 0 300 60" preserveAspectRatio="xMidYMid meet" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} aria-hidden>
          <ellipse cx="150" cy="30" rx="120" ry="26" fill="none" stroke={`${HUB.violet}66`} strokeWidth="1.5" />
          <ellipse className="ml-anim" cx="150" cy="30" rx="120" ry="26" fill="none" stroke={joined ? HUB.green : HUB.violet} strokeWidth="2"
            strokeDasharray="6 12" style={{ animation: 'ml-dash 2.4s linear infinite', filter: `drop-shadow(0 0 6px ${joined ? HUB.green : HUB.violet})` }} />
        </svg>
        {/* side runes */}
        <span className="ml-anim" style={{ position: 'absolute', left: 8, color: HUB.violet, display: 'inline-flex', animation: 'ml-float 3s ease-in-out infinite', filter: `drop-shadow(0 0 8px ${HUB.violet})` }}><Diamond size={16} /></span>
        <span className="ml-anim" style={{ position: 'absolute', right: 8, color: HUB.gold, display: 'inline-flex', animation: 'ml-float 3.6s ease-in-out infinite', filter: `drop-shadow(0 0 8px ${HUB.gold})` }}><Diamond size={16} /></span>
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

// ── Root ────────────────────────────────────────────────────────────────────
type View = 'landing' | 'profile' | 'rules' | 'lobby' | 'view-profile' | 'ranked' | 'solo' | 'boosters' | 'masterquest' | 'settings';

/**
 * The match id from an invite deep link (`…/#match=<id>`), or `null`.
 *
 * The hash is shared with the profile hub's tab state, so read it early and
 * hold the result — see the `matchLink` state in `App`.
 */
function readMatchLink(): string | null {
  try {
    const m = window.location.hash.match(/match=([\w-]+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * Drop the `#match=` hash once the link has been resolved one way or another,
 * so a refresh does not re-attempt a join that already failed. The query string
 * is preserved — it can carry things this app does not own.
 */
function clearMatchLink(): void {
  try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* ignore */ }
}

/**
 * Why an invite link did not open, and the one thing worth doing about it.
 *
 * Always rendered in the LOBBY, whatever the cause. Bouncing the player
 * straight to the deck builder — which is what a `no_active_deck` link used to
 * do — is silent: they arrive somewhere they did not ask to be with no idea the
 * invite was the reason. A banner beside the match list says what happened and
 * still hands them the right button.
 */
type LinkProblem = {
  message: string;
  issues: string[];
  /** `'decks'` when the player's own deck is what the server refused. */
  action: 'lobby' | 'decks';
};

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
  // Deck ids are bigint-safe decimal strings.
  const [selectedDeckId, setSelectedDeckId] = useState<string | null>(null);
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
        const list = await listDecksApi();
        if (cancelled) return;
        setDecks(list);
        // Single-player requires an owned custom deck — default to the first valid one.
        const firstLegal = list.find(d => validateDeck(d.cards).ok);
        setSelectedDeckId(firstLegal ? firstLegal.id : null);
      } catch {
        if (!cancelled) setDecks([]);
      } finally {
        if (!cancelled) setDecksLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [myName]);

  const chosenCustom = selectedDeckId == null ? null : decks.find(d => d.id === selectedDeckId) ?? null;
  // Single-player requires a custom deck built only from owned (booster) cards.
  const chosenOwnedOk = chosenCustom ? validateDeck(chosenCustom.cards).ok : false;
  const canStart = selectedDeckId != null && chosenOwnedOk;

  const btn = (active: boolean, accent: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
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
        maxHeight: 'calc(100dvh - 32px - env(safe-area-inset-bottom))', overflowY: 'auto',
        color: '#fff', fontFamily: 'Inter, sans-serif',
        boxShadow: '0 18px 50px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 20, fontWeight: 800, letterSpacing: 1 }}><Robot size={21} /> Play vs Bot</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>Single-player, runs entirely in your browser.</div>
        </div>

        <div>
          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6, letterSpacing: 1 }}>DIFFICULTY</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setMode('casual')} style={btn(mode === 'casual', '#6c4bd8')}>
              CASUAL
            </button>
            <button onClick={() => setMode('daily')} style={btn(mode === 'daily', '#ffaf3a')}>
              <Star size={13} /> DAILY ({dateKey})
            </button>
          </div>
          <div style={{ fontSize: 11, opacity: 0.65, marginTop: 6 }}>
            {mode === 'daily'
              ? 'Same shuffle + bot deck for every player today. Race for the fastest win.'
              : 'Random shuffle and random bot deck every match.'}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6, letterSpacing: 1 }}>YOUR DECK · CUSTOM ONLY</div>

          {/* Single-player requires a custom deck built only from owned cards. */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {decksLoading && (
              <div style={{ fontSize: 11, opacity: 0.6, alignSelf: 'center' }}>loading decks…</div>
            )}
            {!decksLoading && decks.map(d => {
              const active = selectedDeckId === d.id;
              const ok = validateDeck(d.cards).ok;
              return (
                <button key={d.id} onClick={() => ok && setSelectedDeckId(d.id)} disabled={!ok} style={{
                  background: active ? '#3aa66a' : '#1a1730',
                  color: active ? '#fff' : ok ? '#ccc' : '#c8455d',
                  border: `2px solid ${active ? '#3aa66a' : '#3a3050'}`,
                  borderRadius: 8, padding: '8px 12px',
                  fontWeight: 700, cursor: ok ? 'pointer' : 'not-allowed', fontSize: 12,
                  opacity: ok ? 1 : 0.6, display: 'inline-flex', alignItems: 'center',
                }} title={ok ? d.name : `${d.name} — needs ${DECK_SIZE} cards (build in Profile › Decks)`}>
                  {d.name}{!ok ? <Warning size={12} style={{ marginLeft: 5 }} /> : null}
                </button>
              );
            })}
            {!decksLoading && decks.length === 0 && (
              <div style={{ fontSize: 11, opacity: 0.7, alignSelf: 'center' }}>
                No decks yet — build one from your collection in Profile › Decks.
              </div>
            )}
          </div>

          <div style={{ fontSize: 11, opacity: 0.7 }}>
            Single-player uses a custom deck built only from cards you own — booster pulls plus your 20 starter Nodes of each chain.
          </div>
        </div>

        {best && (
          <div style={{
            fontSize: 11, opacity: 0.8, padding: '8px 10px',
            background: 'rgba(255,175,58,0.08)', borderRadius: 6,
            border: '1px solid rgba(255,175,58,0.3)',
          }}>
            Today's best ({difficulty}): {best.win
              ? <><Check size={12} /> won in {Math.round(best.ms / 1000)}s · {best.turns} turns</>
              : <><Close size={12} /> lost in {best.turns} turns</>}
          </div>
        )}

        {!canStart && (
          <div style={{ fontSize: 11, color: '#ffb84d', opacity: 0.9 }}>
            Build a valid 60-card deck from your collection to play single-player.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            disabled={!canStart}
            onClick={() => canStart && onLaunch({
              difficulty, mode, color,
              customDeck: chosenCustom!.cards,
            })}
            style={{
              flex: 1, background: !canStart ? '#3a2a4a' : '#6c4bd8', color: '#fff',
              border: 'none', borderRadius: 8, padding: '12px 16px',
              fontWeight: 800, cursor: !canStart ? 'not-allowed' : 'pointer', fontSize: 14, letterSpacing: 1,
              opacity: !canStart ? 0.6 : 1,
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
// hint there ("tap Share -> Add to Home Screen"). Either is dismissable for
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
      position: 'fixed', left: 12, right: 12, bottom: 'calc(12px + env(safe-area-inset-bottom))',
      maxWidth: 460, marginLeft: 'auto', marginRight: 'auto',
      background: 'linear-gradient(135deg, #1b1230 0%, #3a1f5a 100%)',
      color: '#fff', border: '1px solid #6c4bd8', borderRadius: 10,
      padding: '10px 12px', zIndex: 90,
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', gap: 10,
      fontFamily: 'Inter, sans-serif', fontSize: 13,
    }}>
      <div style={{ display: 'flex', color: '#c8a3ff' }}><Mobile size={22} /></div>
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
      <button onClick={dismiss} title="Dismiss for a week" aria-label="Dismiss install prompt" style={{
        background: 'transparent', color: '#aaa', border: 'none',
        cursor: 'pointer', padding: 0, lineHeight: 1, display: 'inline-flex',
      }}><Close size={17} /></button>
    </div>
  );
}

/**
 * Fired on `window` after a successful `PATCH /api/profiles/me` so the root can
 * re-read the profile. The display name is server state now, and several
 * screens can change it, so a broadcast beats threading a callback through six
 * levels of props.
 */
export const PROFILE_CHANGED_EVENT = 'ocva:profile-changed';

/** Tell the app the signed-in player's profile has changed server-side. */
export function announceProfileChanged() {
  try { window.dispatchEvent(new CustomEvent(PROFILE_CHANGED_EVENT)); } catch { /* SSR / no DOM */ }
}

/**
 * Shown while the signed-in player's profile is loading, and when that load
 * failed for a reason that is not "your session is dead" — a network blip, a
 * 5xx, a rate limit. Anything auth-shaped has already cleared the session and
 * the login screen is mounting instead.
 */
function SessionBootstrap({ error, onRetry, onSignOut }: {
  error: string; onRetry: () => void; onSignOut: () => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'grid', placeItems: 'center',
      background: '#07060f', color: '#e9eef7', fontFamily: F.body, padding: 24,
    }}>
      <div style={{ textAlign: 'center', maxWidth: 460 }}>
        <LoginEmblem size={64} />
        {error ? (
          <>
            <div role="alert" style={{ marginTop: 18, fontSize: 14, color: '#ffb4b4', lineHeight: 1.6 }}>{error}</div>
            <div style={{ marginTop: 18, display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button onClick={onRetry} style={LOBBY_GOLD_BTN}>Try again</button>
              <button onClick={onSignOut} style={LOBBY_GHOST_BTN}>Sign out</button>
            </div>
          </>
        ) : (
          <div style={{ marginTop: 18, fontSize: 14, color: '#9faabf', letterSpacing: 1 }}>Loading your profile…</div>
        )}
      </div>
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

  // ── Session ───────────────────────────────────────────────────────────────
  // `signedIn` is driven by `onSessionChange`, which fires on sign-in, on
  // explicit sign-out, AND when a 401 could not be recovered by refreshing
  // (`SessionExpiredError`). That last case is why this is a subscription and
  // not a boolean set once at login: a token can die while the player is deep
  // in a screen, and the app has to land back on the login page rather than
  // render half-broken pages against a dead session.
  const [signedIn, setSignedIn] = useState<boolean>(() => sessionApi.isSignedIn());
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState<string>('');

  const [seat, setSeat] = useState<Seat | null>(() => sess.get<Seat | null>('seat', null));
  const [view, setView] = useState<View>(() => sess.get<View>('view', 'landing'));
  const [viewedProfile, setViewedProfile] = useState<string | null>(null);
  const [soloSetup, setSoloSetup] = useState<boolean>(false);
  const [soloCfg, setSoloCfg] = useState<{ difficulty: Difficulty; mode: SoloMode; color: Color; customDeck: string[] | null } | null>(null);
  const soloStartRef = useRef<number>(0);

  // ── Invite deep link ──────────────────────────────────────────────────────
  //
  // `#match=<id>` is read ONCE, in this initialiser, which runs during App's
  // very first render — before any child effect exists and therefore before
  // anything else can rewrite the hash. The profile hub also owns the hash
  // (`#overview` / `#decks` / …) and rewrites it whenever its tab changes; it
  // happens not to fire on mount for a `#match=` hash today, but relying on
  // that is one tab click away from eating every invite link.
  //
  // Holding it in state rather than re-reading the URL also makes the link
  // survive sign-in: App stays mounted while `<Login>` is on screen, so the id
  // captured before the wallet signature is still here after it.
  const [matchLink, setMatchLink] = useState<string | null>(() => readMatchLink());
  /** Why the last invite link could not be opened. Rendered by the lobby. */
  const [linkProblem, setLinkProblem] = useState<LinkProblem | null>(null);
  /**
   * `true` once the seat restored from session storage has been re-verified
   * against the server (or there was nothing to verify).
   *
   * The deep-link effect waits for this. Without it, a seat cached from a match
   * that has since finished would make an invite look like "you are already in
   * a match" for the second or two before the check comes back.
   */
  const [seatChecked, setSeatChecked] = useState(false);

  // A second invite arriving in the same session (clicking another link).
  useEffect(() => {
    const onHash = () => { const id = readMatchLink(); if (id) { setMatchLink(id); setLinkProblem(null); } };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => sessionApi.onSessionChange((s) => {
    setSignedIn(s !== null);
    if (s === null) {
      // Signed out, or the refresh chain failed. Drop every scrap of per-player
      // state so the next player on this machine starts clean.
      setProfile(null);
      setSeat(null);
      setViewedProfile(null);
      setSoloCfg(null);
      setSoloSetup(false);
      setView('landing');
      setLinkProblem(null);
      setSeatChecked(false);
      sess.del('seat'); sess.del('view');
    }
  }), []);

  // The display name lives on the SERVER now. First-time players are given a
  // default derived from their address; they rename it in Settings -> Edit
  // profile, which calls `PATCH /api/profiles/me`.
  const reloadProfile = useCallback(async () => {
    if (!sessionApi.isSignedIn()) return;
    try {
      setProfile(await getMyProfileApi());
      setProfileError('');
    } catch (e) {
      // A 401 here has already cleared the session and fired onSessionChange,
      // so there is nothing to show — the login screen is about to mount.
      if (e instanceof ApiError && e.isAuthError) return;
      setProfileError(errorText(e));
    }
  }, []);
  useEffect(() => { if (signedIn) void reloadProfile(); }, [signedIn, reloadProfile]);

  // Card ownership is server state keyed to the wallet, so it has to be re-read
  // whenever the identity changes. Cheap (no chain access) and non-blocking: a
  // failure leaves the cached snapshot on screen rather than emptying it.
  useEffect(() => { if (signedIn) void refreshCollection(); }, [signedIn]);

  // Any screen can ask for a profile re-read after renaming.
  useEffect(() => {
    const onChanged = () => { void reloadProfile(); };
    window.addEventListener(PROFILE_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PROFILE_CHANGED_EVENT, onChanged);
  }, [reloadProfile]);

  const name = profile?.name ?? '';

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

  // On boot: re-verify a saved seat against the server. `GET /games/:id/seat`
  // is the authority on whether we are still in that match — and a
  // non-participant gets 404 (never 403), so any error means "drop it".
  useEffect(() => {
    if (!signedIn) return;
    if (!seat) { setSeatChecked(true); return; }
    let cancelled = false;
    (async () => {
      try {
        const info = await lobbyApi.getSeat(seat.matchID);
        if (cancelled) return;
        if (info.status === 'finished' || info.status === 'void') {
          sess.del('seat'); setSeat(null);
        } else {
          setSeat(seatFrom(info, seat.playerName));
        }
      } catch {
        if (cancelled) return;
        sess.del('seat'); setSeat(null);
      } finally {
        if (!cancelled) setSeatChecked(true);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  // Deep-link: `#match=ID` joins that match. The server decides the seat — the
  // client cannot name one, and cannot send a deck either.
  //
  // ─── EVERY OUTCOME IS VISIBLE ───────────────────────────────────────────────
  // This used to swallow a failure into `console.warn`, which is the worst
  // possible answer: the player clicks an invite, the page looks like it
  // ignored them, and the hash has already been stripped so a refresh does not
  // even retry. The overwhelmingly common case is a 409 `match_not_open` —
  // somebody else took the second seat while the link sat in a chat window —
  // and the server is right to refuse it. So: name the reason, drop the player
  // in the lobby where there are other matches, and let them retry from there.
  useEffect(() => {
    if (!matchLink || !signedIn || !name || !seatChecked) return;

    // ─── ALREADY SITTING IN A MATCH ─────────────────────────────────────────
    // Previously this was a bare `if (seat) return`, so a seat cached in
    // session storage from an older match swallowed every invite with no
    // feedback whatsoever. Two deliberate outcomes now:
    //
    //   same match  — the link is where they already are; consume it.
    //   other match — HOLD the link. Following it would abandon a live game,
    //                 so it never wins the race, but it is not thrown away
    //                 either: this effect re-runs when the seat clears
    //                 (`leftSeat`, or the boot re-verification dropping a
    //                 finished one) and the join is attempted then. Either it
    //                 works, or the lobby banner below names the reason. The
    //                 one thing that cannot happen any more is silence.
    if (seat) {
      if (seat.matchID === matchLink) { clearMatchLink(); setMatchLink(null); setLinkProblem(null); }
      return;
    }

    const matchID = matchLink;
    let cancelled = false;
    (async () => {
      /** Land the player in the lobby with the reason on screen and a way out. */
      const fail = (message: string, issues: string[] = [], action: LinkProblem['action'] = 'lobby') => {
        if (cancelled) return;
        setLinkProblem({ message, issues, action });
        goto('lobby');
      };

      try {
        // Already seated? `getSeat` tells us, and hands back our credentials.
        try {
          const mine = await lobbyApi.getSeat(matchID);
          if (cancelled) return;
          clearMatchLink(); setMatchLink(null); setLinkProblem(null);
          joinedSeat(seatFrom(mine, name));
          return;
        } catch (e) {
          // 404 means "not seated in it" — fall through and try to join.
          if (!(e instanceof ApiError && e.isNotFound)) throw e;
        }
        const joined = await lobbyApi.join(matchID);
        if (cancelled) return;
        clearMatchLink(); setMatchLink(null); setLinkProblem(null);
        joinedSeat({
          matchID, seat: joined.seat, playerID: joined.playerID,
          credentials: joined.credentials, playerName: name,
        });
      } catch (e) {
        if (cancelled) return;
        clearMatchLink();
        setMatchLink(null);

        // The joiner's OWN deck is the problem (`no_active_deck`,
        // `invalid_active_deck`, `unowned_cards`). The deck builder is the only
        // fix, and `unowned_cards` names each offending card — show them.
        if (isDeckBlocked(e)) {
          fail(errorHeadline(e), errorIssues(e), 'decks');
          return;
        }

        // Seated between the `getSeat` 404 and the join — take the seat we now
        // hold rather than reporting a conflict the player cannot act on.
        if (e instanceof ApiError && e.reason === 'already_seated') {
          try {
            const mine = await lobbyApi.getSeat(matchID);
            if (cancelled) return;
            setLinkProblem(null);
            joinedSeat(seatFrom(mine, name));
            return;
          } catch { /* fall through to the generic message */ }
        }

        // No `details.reason` on this one: a match that does not exist and one
        // that is private-and-not-for-you are the SAME 404 by design, so the
        // client must not claim to know which.
        if (e instanceof ApiError && e.isNotFound) {
          fail('That invite link is not valid any more.',
            ['The match may have been cancelled, or the invite was for somebody else.']);
          return;
        }

        // Everything else — `match_not_open`, `match_incomplete`,
        // `host_deck_unowned`, `setup_rejected`, rate limits, network failures.
        // `errorHeadline` keeps any per-issue detail out of the heading so the
        // list below it does not repeat the same text.
        fail(errorHeadline(e), errorIssues(e));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchLink, signedIn, name, seat, seatChecked]);

  /**
   * The ranked queue lives at the ROOT, not inside a panel.
   *
   * Two reasons, both of which the ladder gets wrong if it lives lower down:
   *
   *  1. REFRESH MID-QUEUE. On mount the hook reads `GET /games/ranked/queue`
   *     once. Because that read is idempotent, a player who reloaded while
   *     queued is still queued, and a player who was PAIRED while the page was
   *     reloading gets their pairing back and is seated — whichever view the
   *     session restored them to. Owning it here is what makes that true for
   *     the hub, the lobby and the ladder screen alike.
   *  2. It survives navigation. Queueing from the hub and then opening the
   *     ladder must not silently drop the ticket.
   *
   * Disabled while already seated in a match: there is nothing to queue for,
   * and the seat handoff would fight the match that is already on screen.
   */
  const enterMatchFromQueue = useCallback((s: Seat) => { sess.set('seat', s); setSeat(s); }, []);
  const rankedQueue = useRankedQueue({
    enabled: signedIn && profile !== null && seat === null,
    playerName: profile?.name ?? '',
    onEnterMatch: enterMatchFromQueue,
  });

  async function logout() {
    sess.del('seat'); sess.del('view');
    // `auth.logout()` revokes the family server-side and always clears locally,
    // even if the network call fails. `onSessionChange` does the UI reset.
    try { await auth.logout(); } catch { sessionApi.clearSession(); }
  }
  function joinedSeat(s: Seat) { sess.set('seat', s); setSeat(s); }
  function leftSeat() { sess.del('seat'); setSeat(null); goto('landing'); }
  function goto(v: View) { sess.set('view', v); setView(v); }

  // Signed out is a real app state, not an absence of one. It is also where an
  // expired session lands, because `onSessionChange` fires for that too.
  if (!signedIn) return <Login onSignedIn={() => { setView('landing'); void reloadProfile(); }} />;

  // Signed in but the profile has not arrived: hold rather than render screens
  // that all take a display name we do not have yet.
  if (!profile) {
    return (
      <SessionBootstrap
        error={profileError}
        onRetry={() => { setProfileError(''); void reloadProfile(); }}
        onSignOut={logout}
      />
    );
  }

  if (seat) return <MatchSeat seat={seat} myName={name} onLeave={leftSeat} />;

  // Landing + Profile share the same audio element so music keeps playing
  // (and the user's mute state is preserved) when switching between them.
  const showMusic = view === 'landing' || view === 'profile' || view === 'rules' || view === 'lobby' || view === 'ranked' || view === 'boosters' || view === 'masterquest' || view === 'settings';

  // Settings -> Account -> "Edit profile" hands off to the profile hub's
  // existing ProfileEditModal rather than duplicating the edit form.
  function editProfile() {
    try { sessionStorage.setItem('ocva.openProfileEdit', '1'); } catch {}
    goto('profile');
  }
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
      {view === 'settings'
        ? <SettingsPage
            myName={name}
            onBack={() => goto('landing')}
            onRules={() => goto('rules')}
            onLogout={logout}
            onEditProfile={editProfile}
          />
        : view === 'profile'
        ? <ProfilePage myName={name} onBack={() => goto('landing')} onSettings={() => goto('settings')} />
        : view === 'rules'
          ? <RulebookPage onBack={() => goto('landing')} />
          : view === 'boosters'
            ? <BoostersPage onBack={() => goto('landing')} />
            : view === 'masterquest'
              ? <MasterquestPage myName={name} onBack={() => goto('landing')} />
            : view === 'view-profile' && viewedProfile
              ? <PublicProfile name={viewedProfile} onBack={() => goto('lobby')} />
              // The `ranked` deep-link resolves to the real ladder again.
              : view === 'ranked'
                ? <RankedPage
                    myName={name}
                    queue={rankedQueue}
                    onBack={() => goto('landing')}
                    onDeckScreen={() => { try { window.location.hash = 'decks'; } catch {} goto('profile'); }}
                    onBoosters={() => goto('boosters')}
                    onViewProfile={n => { setViewedProfile(n); goto('view-profile'); }}
                  />
              : view === 'lobby'
                  ? <Lobby
                      myName={name}
                      onJoined={joinedSeat}
                      onBack={() => goto('landing')}
                      onViewProfile={n => { setViewedProfile(n); goto('view-profile'); }}
                      onSolo={() => setSoloSetup(true)}
                      onDeckScreen={() => { try { window.location.hash = 'decks'; } catch {} goto('profile'); }}
                      onBoosters={() => goto('boosters')}
                      onLadder={() => goto('ranked')}
                      linkProblem={linkProblem}
                      onDismissLinkProblem={() => setLinkProblem(null)}
                    />
                  : <Landing myName={name} profile={profile} queue={rankedQueue} onPlay={() => goto('lobby')} onLadder={() => goto('ranked')} onMasterquest={() => goto('masterquest')} onBoosters={() => goto('boosters')} onProfile={() => goto('profile')} onRules={() => goto('rules')} onSettings={() => goto('settings')} />}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// RANKED
// ═══════════════════════════════════════════════════════════════════════════
//
// The ladder is live on `/games/ranked/*`. Everything below renders what the
// server actually sends and nothing else: no hidden MMR, no win streak, no
// queue ETA, and no rank at all for a player still in placements.

/**
 * Tier + division + LP, or placement progress, or an honest absence.
 *
 * The label is the SERVER'S ("Gold II", "Mythic") — never reassembled here,
 * because Mythic has no division and the server already knows that.
 */
function RankBadge({ standing, loading, compact }: {
  standing: RankedStanding | null;
  /** The ranked profile is still being read. Say nothing rather than "Unranked". */
  loading?: boolean;
  compact?: boolean;
}) {
  const pad = compact ? '5px 10px' : '7px 12px';
  const fontSize = compact ? 12 : 14;

  const shell = (style: TierStyleLike, children: React.ReactNode, icon: React.ReactNode) => (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 8, padding: pad, borderRadius: 999,
      background: style.fill, border: `1px solid ${style.border}`, color: style.color,
      fontWeight: 800, fontSize, letterSpacing: '0.04em', lineHeight: 1.2,
    }}>
      <span aria-hidden style={{ display: 'inline-flex' }}>{icon}</span>
      {children}
    </span>
  );

  // "We have not looked yet" is not "you have no rank". Both are real; only one
  // of them is true right now, and rendering the wrong one flashes a lie.
  if (loading && !standing) {
    return shell(tierStyle(null), 'LOADING…', <Hourglass size={compact ? 13 : 15} />);
  }
  if (!standing) {
    return shell(tierStyle(null), 'RANK UNAVAILABLE', <Warning size={compact ? 13 : 15} />);
  }
  if (standing.state === 'placements') {
    return shell(tierStyle(null), placementLabel(standing).toUpperCase(), <Hourglass size={compact ? 13 : 15} />);
  }
  if (standing.state === 'unranked') {
    return shell(tierStyle(null), 'UNRANKED', <Shield size={compact ? 13 : 15} />);
  }

  const { rank } = standing;
  const st = tierStyle(rank.tier);
  const icon = rank.tier === 'Mythic' || rank.tier === 'Grandmaster'
    ? <Crown size={compact ? 13 : 15} />
    : <Shield size={compact ? 13 : 15} />;
  return shell(st, (
    <>
      {formatRankLabel(rank).toUpperCase()}
      <span style={{ opacity: 0.75, fontWeight: 700 }}>{formatLp(rank.lp)}</span>
      {standing.leaderboardRank !== null && (
        <span style={{ opacity: 0.75, fontWeight: 700 }}>#{standing.leaderboardRank}</span>
      )}
    </>
  ), icon);
}

/** Structural shape of `tierStyle()`'s result, so `RankBadge` need not import it. */
type TierStyleLike = { color: string; fill: string; border: string };

// ── The queue ───────────────────────────────────────────────────────────────

/** What `useRankedQueue` hands to the UI. */
interface RankedQueue {
  state: QueueState;
  /** A poll failed. Advisory: a failed GET does not dequeue anybody. */
  pollError: string;
  /** The seat handoff failed and is being retried. */
  handoffError: string;
  join: () => void;
  leave: () => void;
  dismiss: () => void;
}

/**
 * Join the ladder queue, watch it, leave it — and hand off to the match.
 *
 * ─── THE HANDOFF ───────────────────────────────────────────────────────────
 * `GET /games/ranked/queue` returns a `match` with your seat but NO
 * credentials. Those come from the EXISTING `GET /games/:id/seat`, which is the
 * same call the lobby's join path makes, so there is exactly one way into a
 * match in this app and this is not a second one.
 *
 * That read is a plain database lookup, which makes it idempotent — and that is
 * what makes REFRESHING MID-QUEUE work. On mount this hook reads the queue
 * once; a player who was queued is still queued, and a player who was paired
 * while the page was reloading gets their pairing back and lands in the match
 * rather than losing it.
 *
 * ─── THE POLL ──────────────────────────────────────────────────────────────
 * The budget is 180 requests per 60s per profile. This polls on a CHAINED
 * TIMEOUT (never an interval, which would stack requests if one hung) at
 * `QUEUE_POLL_MS`, makes no request at all while the tab is hidden, stops on
 * unmount, and backs off to `QUEUE_BACKOFF_MS` on a 429.
 *
 * A FAILED POLL NEVER MOVES THE STATE MACHINE. The server-side queue entry is
 * unaffected by a GET that did not arrive, so a dropped connection must not
 * tell a queued player they are not queued.
 */
function useRankedQueue({ enabled, playerName, onEnterMatch }: {
  enabled: boolean;
  playerName: string;
  onEnterMatch: (seat: Seat) => void;
}): RankedQueue {
  const [state, dispatch] = useReducer(queueReducer, IDLE_QUEUE);
  const [pollError, setPollError] = useState('');
  const [handoffError, setHandoffError] = useState('');

  // Refs so the loops below do not have to list every changing value as a
  // dependency and restart themselves on each render.
  const stateRef = useRef(state); stateRef.current = state;
  const enterRef = useRef(onEnterMatch); enterRef.current = onEnterMatch;
  const nameRef = useRef(playerName); nameRef.current = playerName;
  const retryAfterRef = useRef<number | null>(null);

  /** The resume read. Also the reconnect path — see the note above. */
  const resume = useCallback(async () => {
    try {
      const status = await RankedAPI.getQueueStatusOrIdle();
      setPollError('');
      dispatch({ type: 'status', status });
    } catch (e) {
      // Best effort. Failing this must never claim the player is not queued.
      setPollError(errorText(e));
    }
  }, []);

  useEffect(() => { if (enabled) void resume(); }, [enabled, resume]);

  const status = state.status;
  useEffect(() => {
    if (!enabled) return;
    if (status !== 'queued' && status !== 'matched') return;

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (!alive) return;
      const delay = queuePollDelayMs(stateRef.current, retryAfterRef.current);
      if (delay === null) return;
      timer = setTimeout(() => { void tick(); }, delay);
    };

    async function tick() {
      if (!alive) return;
      // A hidden tab spends none of the rate-limit budget. The timer keeps
      // running so the queue resumes promptly, but no request goes out.
      if (typeof document !== 'undefined' && document.hidden) { schedule(); return; }
      try {
        const next = await RankedAPI.getQueueStatus();
        if (!alive) return;
        retryAfterRef.current = null;
        setPollError('');
        dispatch({ type: 'status', status: next });
      } catch (e) {
        if (!alive) return;
        retryAfterRef.current = e instanceof ApiError && e.isRateLimited ? (e.retryAfter ?? 30) : null;
        setPollError(errorText(e));
      }
      schedule();
    }

    // Coming back to a visible tab should not wait out a full interval.
    const onVisible = () => {
      if (typeof document === 'undefined' || document.hidden) return;
      if (timer) { clearTimeout(timer); timer = null; }
      void tick();
    };

    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, status]);

  // ── The seat handoff ──────────────────────────────────────────────────────
  useEffect(() => {
    if (state.status !== 'matched') return;
    const { matchID } = state.match;

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function attempt() {
      try {
        const info = await lobbyApi.getSeat(matchID);
        if (!alive) return;
        // The queue read is idempotent, so it can keep offering a pairing for a
        // match that has since ended. Do not throw the player back into one.
        if (info.status === 'finished' || info.status === 'void') {
          dispatch({ type: 'reset' });
          return;
        }
        setHandoffError('');
        enterRef.current(seatFrom(info, nameRef.current));
        // The machine's work is done; the app owns the seat from here.
        dispatch({ type: 'reset' });
      } catch (e) {
        if (!alive) return;
        setHandoffError(errorText(e));
        // Bounded retry — one attempt every few seconds, never a spin.
        timer = setTimeout(() => { void attempt(); }, 3000);
      }
    }

    void attempt();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [state]);

  const join = useCallback(() => {
    const s = stateRef.current.status;
    if (s === 'joining' || s === 'queued' || s === 'matched' || s === 'leaving') return;
    setPollError(''); setHandoffError('');
    dispatch({ type: 'join' });
    void (async () => {
      try {
        // No region. `global` is the default and the only sane choice: the
        // pairer only pairs WITHIN a region.
        const ticket = await RankedAPI.joinQueue();
        dispatch({ type: 'joined', ticket });
      } catch (e) {
        dispatch({ type: 'error', error: e });
      }
    })();
  }, []);

  const leave = useCallback(() => {
    const s = stateRef.current.status;
    if (s !== 'queued' && s !== 'joining') return;
    dispatch({ type: 'leave' });
    void (async () => {
      try {
        // `wasQueued: false` is a success — it is what a double-click looks like.
        await RankedAPI.leaveQueue();
        dispatch({ type: 'left' });
      } catch (e) {
        dispatch({ type: 'error', error: e });
      }
    })();
  }, []);

  const dismiss = useCallback(() => {
    dispatch({ type: 'reset' });
    // We may have failed while still queued server-side. Re-read; do not guess.
    void resume();
  }, [resume]);

  return { state, pollError, handoffError, join, leave, dismiss };
}

/**
 * The queue's one control, in whatever panel is hosting it.
 *
 * Every state answers the same question — what is happening, and what can I do
 * about it — with real numbers only. `queueDepth` and the elapsed wait are
 * server facts; there is deliberately no estimated wait, because the server
 * does not send one and inventing one is how a queue starts lying.
 */
function RankedQueueControl({ queue, onDeckScreen, onBoosters }: {
  queue: RankedQueue; onDeckScreen: () => void; onBoosters: () => void;
}) {
  const now = useNow(1000);
  const q = queue.state;

  const plate = (label: string, onClick: (() => void) | null, tone: 'gold' | 'quiet', icon: React.ReactNode) => (
    <button onClick={onClick ?? undefined} disabled={onClick === null} className="menu-anim"
      style={{
        width: '100%', marginTop: 14, padding: '15px', borderRadius: 12,
        cursor: onClick ? 'pointer' : 'default',
        fontFamily: MENU_SERIF, fontWeight: 800, fontSize: 16, letterSpacing: '0.06em',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        color: tone === 'gold' ? '#20170a' : MENU.text,
        background: tone === 'gold'
          ? `linear-gradient(180deg, ${MENU.goldHi}, ${MENU.gold} 55%, #b8912f)`
          : 'rgba(8,8,22,0.6)',
        border: `1px solid ${tone === 'gold' ? '#8a6d24' : MENU.border}`,
        boxShadow: tone === 'gold' ? '0 8px 26px rgba(230,196,92,0.4)' : 'none',
        transition: 'transform .15s ease, box-shadow .2s ease',
      }}>
      <span aria-hidden style={{ display: 'inline-flex' }}>{icon}</span>{label}
    </button>
  );

  if (q.status === 'matched') {
    return (
      <div aria-live="polite" style={{
        marginTop: 14, padding: '14px 16px', borderRadius: 12,
        background: 'rgba(57,230,176,0.10)', border: '1px solid rgba(57,230,176,0.5)',
      }}>
        <div style={{ fontFamily: MENU_SERIF, fontWeight: 800, fontSize: 16, color: MENU.success }}>
          OPPONENT FOUND
        </div>
        <div style={{ fontSize: 12.5, color: MENU.text2, marginTop: 5, lineHeight: 1.55 }}>
          {q.match.opponentDisplayName
            ? <>Paired with <b style={{ color: MENU.text }}>{q.match.opponentDisplayName}</b>. Taking your seat…</>
            : <>Taking your seat…</>}
        </div>
        {queue.handoffError && (
          <div style={{ fontSize: 11.5, color: '#FFC46B', marginTop: 7, lineHeight: 1.5 }}>
            {queue.handoffError} Retrying — your match is safe, it is waiting for you.
          </div>
        )}
      </div>
    );
  }

  if (q.status === 'failed') {
    const b = q.block;
    return (
      <div role="alert" style={{
        marginTop: 14, padding: '14px 16px', borderRadius: 12,
        background: 'rgba(230,196,92,0.10)', border: `1px solid ${MENU.borderStrong}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontWeight: 800, letterSpacing: 1.4, color: MENU.gold }}>
          <Warning size={14} /> COULD NOT QUEUE
        </div>
        <div style={{ fontSize: 12.5, color: MENU.text, marginTop: 6, lineHeight: 1.55 }}>{b.message}</div>
        {b.issues.length > 0 && (
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 11.5, color: MENU.text2, lineHeight: 1.6 }}>
            {b.issues.slice(0, 4).map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        )}
        <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
          {(b.kind === 'no-deck' || b.kind === 'invalid-deck') && (
            <button onClick={onDeckScreen} style={queueLinkStyle}>OPEN DECKS</button>
          )}
          {b.kind === 'unowned-cards' && (
            <>
              <button onClick={onBoosters} style={queueLinkStyle}>OPEN BOOSTERS</button>
              <button onClick={onDeckScreen} style={queueLinkStyle}>EDIT DECK</button>
            </>
          )}
          <button onClick={queue.dismiss} style={queueLinkStyle}>
            {b.kind === 'rate-limited' || b.kind === 'network' ? 'TRY AGAIN' : 'DISMISS'}
          </button>
        </div>
      </div>
    );
  }

  if (q.status === 'queued' || q.status === 'leaving') {
    const elapsed = queueElapsedMs(q, now);
    return (
      <div style={{
        marginTop: 14, padding: '14px 16px', borderRadius: 12,
        background: 'rgba(139,92,246,0.10)', border: '1px solid rgba(139,92,246,0.45)',
      }}>
        <div aria-live="polite" style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.5, color: '#c8a3ff' }}>SEARCHING FOR AN OPPONENT</span>
          <span style={{ fontFamily: F.mono, fontSize: 20, fontWeight: 700, color: MENU.text }}>{formatWait(elapsed)}</span>
        </div>
        <div style={{ fontSize: 12, color: MENU.text2, marginTop: 6, lineHeight: 1.55 }}>
          {q.status === 'queued' ? queueDepthLabel(q.queueDepth) : 'Leaving the queue…'}
          {/* The server's own number, shown as its own number. It is not framed
              as "±N around your rating" — that would be an interpretation of a
              field the API only names, and the search widens over time anyway. */}
          {q.status === 'queued' && q.mmrWindow !== null && ` · rating window ${q.mmrWindow}`}
        </div>
        {queue.pollError && (
          <div style={{ fontSize: 11.5, color: '#FFC46B', marginTop: 6, lineHeight: 1.5 }}>
            {queue.pollError} You are still in the queue — this is just the status check.
          </div>
        )}
        {plate(q.status === 'leaving' ? 'LEAVING…' : 'LEAVE QUEUE', q.status === 'leaving' ? null : queue.leave, 'quiet', <Close size={16} />)}
      </div>
    );
  }

  if (q.status === 'joining') {
    return plate('JOINING QUEUE…', null, 'gold', <Hourglass size={17} />);
  }

  return plate('FIND RANKED MATCH', queue.join, 'gold', <Trophy size={17} />);
}

const queueLinkStyle: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: MENU.goldHi, fontWeight: 800, fontSize: 11.5, letterSpacing: '0.05em',
};

// ── The ladder screen ───────────────────────────────────────────────────────

function LadderCard({ title, icon, children, right }: {
  title: string; icon: React.ReactNode; children: React.ReactNode; right?: React.ReactNode;
}) {
  return (
    <section style={{ ...LOBBY_GLASS, padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
        <h2 style={{
          margin: 0, fontFamily: '"Cinzel", serif', fontSize: 15, fontWeight: 800, letterSpacing: 1.2,
          color: LOBBY_TOKENS.gold, display: 'flex', alignItems: 'center', gap: 10,
        }}><span aria-hidden style={{ display: 'inline-flex' }}>{icon}</span>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

/**
 * The season: its window, and the reward COPY exactly as the server words it.
 *
 * `season.rewards` is rendered verbatim. It is titles and cardback identifiers
 * — there is no payout path behind any of it, so nothing here promises one and
 * nothing counts down to money.
 */
function SeasonPanel({ info, standing }: { info: SeasonInfo | null; standing: RankedStanding | null }) {
  if (!info) {
    return (
      <LadderCard title="SEASON" icon={<Castle size={16} />}>
        <div style={{ fontSize: 12.5, color: LOBBY_TOKENS.muted, lineHeight: 1.6 }}>
          The season could not be read just now. The ladder itself is unaffected.
        </div>
      </LadderCard>
    );
  }
  const { season } = info;
  const countdown = seasonRemaining(season.endsAt);
  const pct = seasonProgressPct(season.startedAt, season.endsAt);
  // The reward for the tier the player is ACTUALLY in. Nothing is shown for a
  // player in placements: they have no tier, so they have no tier reward.
  const myTier = standing?.state === 'ranked' ? standing.rank.tier : null;
  const myReward = myTier ? season.rewards.tiers[myTier] : undefined;

  return (
    <LadderCard title="SEASON" icon={<Castle size={16} />}
      right={<span style={{ fontSize: 11.5, fontWeight: 800, color: countdown.ended ? LOBBY_TOKENS.muted : LOBBY_TOKENS.gold }}>{countdown.text}</span>}>
      <div style={{ fontFamily: '"Cinzel", serif', fontSize: 20, fontWeight: 700, color: '#fff' }}>{season.name}</div>
      <div style={{ fontSize: 11.5, color: LOBBY_TOKENS.muted, marginTop: 3 }}>
        {new Date(season.startedAt).toLocaleDateString()} — {new Date(season.endsAt).toLocaleDateString()}
        {season.balancePatch ? ` · patch ${season.balancePatch}` : ''}
      </div>
      <div style={{ height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.10)', overflow: 'hidden', margin: '10px 0 14px' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: `linear-gradient(90deg, ${LOBBY_TOKENS.gold}, ${LOBBY_TOKENS.purple})` }} />
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        {myReward && (
          <RewardRow icon={<Medal size={15} />} eyebrow={`${myTier} REWARD`}
            title={myReward.title} body={`Cardback: ${myReward.cardback}`} />
        )}
        <RewardRow icon={<Crown size={15} />} eyebrow="CHAMPION"
          title={season.rewards.champion.title} body={season.rewards.champion.description} />
      </div>

      <div style={{ fontSize: 11.5, color: LOBBY_TOKENS.muted, marginTop: 12, lineHeight: 1.6 }}>
        {info.placementMatches} placement matches, then {info.tiers.length} tiers from {info.tiers[0]} to {info.tiers[info.tiers.length - 1]}.
        Next season starts you back toward the middle (soft reset {season.softResetFactor}).
      </div>
    </LadderCard>
  );
}

function RewardRow({ icon, eyebrow, title, body }: {
  icon: React.ReactNode; eyebrow: string; title: string; body: string;
}) {
  return (
    <div style={{
      display: 'flex', gap: 11, padding: '10px 12px', borderRadius: 10,
      background: 'rgba(0,0,0,0.28)', border: `1px solid ${LOBBY_TOKENS.border}`,
    }}>
      <span aria-hidden style={{ color: LOBBY_TOKENS.gold, display: 'inline-flex', flex: 'none', marginTop: 2 }}>{icon}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.4, color: LOBBY_TOKENS.gold }}>{eyebrow}</div>
        <div style={{ fontSize: 13.5, fontWeight: 800, color: '#fff', marginTop: 3 }}>{title}</div>
        <div style={{ fontSize: 11.5, color: LOBBY_TOKENS.muted, marginTop: 2, lineHeight: 1.55 }}>{body}</div>
      </div>
    </div>
  );
}

/**
 * The season ladder.
 *
 * AN EMPTY LIST IS THE CORRECT ANSWER for a season nobody has finished
 * placements in — which is exactly where the live season is today. It gets a
 * deliberate empty state, not a table with no rows in it and not an error.
 */
function LeaderboardPanel({ board, loading, error, myName, onViewProfile }: {
  board: RankedLeaderboard | null; loading: boolean; error: string;
  myName: string; onViewProfile: (name: string) => void;
}) {
  return (
    <LadderCard title="SEASON LEADERBOARD" icon={<Chart size={16} />}
      right={board && board.entries.length > 0
        ? <span style={{ fontSize: 11.5, color: LOBBY_TOKENS.muted }}>Top {board.entries.length}</span>
        : undefined}>
      {loading ? (
        <div style={{ fontSize: 12.5, color: LOBBY_TOKENS.muted }}>Reading the ladder…</div>
      ) : error ? (
        <div style={{ fontSize: 12.5, color: LOBBY_TOKENS.danger, lineHeight: 1.6 }}>{error}</div>
      ) : leaderboardIsEmpty(board) ? (
        <div style={{
          padding: '22px 18px', borderRadius: 12, textAlign: 'center',
          background: 'rgba(0,0,0,0.28)', border: `1px dashed ${LOBBY_TOKENS.border}`,
        }}>
          <div aria-hidden style={{ color: LOBBY_TOKENS.gold, display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
            <Trophy size={26} />
          </div>
          <div style={{ fontFamily: '"Cinzel", serif', fontSize: 16, fontWeight: 700, color: '#fff' }}>
            {LEADERBOARD_EMPTY_TITLE}
          </div>
          <div style={{ fontSize: 12.5, color: LOBBY_TOKENS.muted, marginTop: 7, lineHeight: 1.65, maxWidth: 420, marginInline: 'auto' }}>
            {LEADERBOARD_EMPTY_BODY}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {board!.entries.map((e) => {
            const st = tierStyle(e.tier);
            const mine = e.displayName === myName;
            return (
              <button key={e.profileId} onClick={() => onViewProfile(e.displayName)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left',
                  padding: '9px 11px', borderRadius: 10, cursor: 'pointer',
                  background: mine ? 'rgba(217,184,95,0.12)' : 'rgba(0,0,0,0.26)',
                  border: `1px solid ${mine ? LOBBY_TOKENS.borderHi : LOBBY_TOKENS.border}`,
                  color: LOBBY_TOKENS.text, fontFamily: PROFILE_FONT,
                }}>
                <span style={{
                  minWidth: 30, textAlign: 'right', fontFamily: F.mono, fontSize: 13, fontWeight: 800,
                  color: e.rank <= 3 ? LOBBY_TOKENS.gold : LOBBY_TOKENS.muted,
                }}>{e.rank}</span>
                <span aria-hidden style={{ color: st.color, display: 'inline-flex', flex: 'none' }}>
                  {e.rank === 1 ? <MedalFirst size={16} /> : <Shield size={15} />}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13.5, fontWeight: 800, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.displayName}{mine ? ' · you' : ''}
                  </span>
                  <span style={{ display: 'block', fontSize: 11, color: LOBBY_TOKENS.muted, marginTop: 2 }}>
                    {formatRankedRecord(e.record)}
                  </span>
                </span>
                <span style={{ textAlign: 'right', flex: 'none' }}>
                  {/* The server's own label — Mythic has no division and it knows. */}
                  <span style={{ display: 'block', fontSize: 12, fontWeight: 800, color: st.color }}>{e.label}</span>
                  <span style={{ display: 'block', fontSize: 11, color: LOBBY_TOKENS.muted, marginTop: 2 }}>{formatLp(e.lp)}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </LadderCard>
  );
}

/** Ranked match history, with the LP delta the generic history does not carry. */
function RankedHistoryPanel({ matches, loading, error }: {
  matches: RankedMatchEntry[] | null; loading: boolean; error: string;
}) {
  return (
    <LadderCard title="RANKED HISTORY" icon={<Swords size={16} />}>
      {loading ? (
        <div style={{ fontSize: 12.5, color: LOBBY_TOKENS.muted }}>Reading your matches…</div>
      ) : error ? (
        <div style={{ fontSize: 12.5, color: LOBBY_TOKENS.danger, lineHeight: 1.6 }}>{error}</div>
      ) : !matches || matches.length === 0 ? (
        <div style={{ fontSize: 12.5, color: LOBBY_TOKENS.muted, lineHeight: 1.65 }}>
          No ranked matches yet. Your first one starts your placements.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {matches.map((m) => {
            const accent = m.outcome === 'win' ? LOBBY_TOKENS.green
              : m.outcome === 'loss' ? LOBBY_TOKENS.danger : LOBBY_TOKENS.muted;
            return (
              <div key={m.matchID} style={{
                display: 'flex', alignItems: 'center', gap: 11, padding: '9px 11px', borderRadius: 10,
                background: 'rgba(0,0,0,0.26)', border: `1px solid ${LOBBY_TOKENS.border}`,
              }}>
                <span style={{
                  width: 34, flex: 'none', textAlign: 'center', fontSize: 11, fontWeight: 800,
                  letterSpacing: 0.5, color: accent,
                }}>{m.outcome.toUpperCase()}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.opponentDisplayName ?? 'Unknown opponent'}
                  </span>
                  <span style={{ display: 'block', fontSize: 11, color: LOBBY_TOKENS.muted, marginTop: 2 }}>
                    {formatEndReason(m.reason)} · {new Date(m.finishedAt).toLocaleDateString()}
                  </span>
                </span>
                {/* A draw is 0 and is shown as 0 — never "+0", which reads as a gain. */}
                <span style={{
                  flex: 'none', fontFamily: F.mono, fontSize: 13, fontWeight: 800,
                  color: m.lpDelta > 0 ? LOBBY_TOKENS.green : m.lpDelta < 0 ? LOBBY_TOKENS.danger : LOBBY_TOKENS.muted,
                }}>{formatLpDelta(m.lpDelta)}</span>
              </div>
            );
          })}
        </div>
      )}
    </LadderCard>
  );
}

/** The caller's own standing: rank or placements, record, and the queue. */
function MyStandingPanel({ me, standing, loading, queue, onDeckScreen, onBoosters }: {
  me: OwnRankedProfile | null; standing: RankedStanding | null; loading: boolean;
  queue: RankedQueue; onDeckScreen: () => void; onBoosters: () => void;
}) {
  const winPct = me ? rankedWinRate(me.record) : null;
  return (
    <LadderCard title="YOUR STANDING" icon={<Trophy size={16} />}>
      <RankBadge standing={standing} loading={loading} />

      {standing?.state === 'placements' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '11px 0 6px' }}>
            <div style={{ flex: 1, height: 7, borderRadius: 999, background: 'rgba(255,255,255,0.10)', overflow: 'hidden' }}>
              <div style={{ width: `${standing.progressPct}%`, height: '100%', background: `linear-gradient(90deg, ${LOBBY_TOKENS.gold}, ${LOBBY_TOKENS.purple})` }} />
            </div>
            <span style={{ fontSize: 11.5, color: LOBBY_TOKENS.muted, whiteSpace: 'nowrap' }}>
              {standing.played} / {standing.total}
            </span>
          </div>
          {/* No provisional tier. The server sends no rank here and neither do we. */}
          <div style={{ fontSize: 12, color: LOBBY_TOKENS.muted, lineHeight: 1.6 }}>{placementBlurb(standing)}</div>
        </>
      )}

      {me && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(78px, 1fr))', gap: 8, marginTop: 13 }}>
          {[
            { label: 'Wins', value: me.record.wins },
            { label: 'Losses', value: me.record.losses },
            { label: 'Draws', value: me.record.draws },
            { label: 'Win rate', value: winPct === null ? '—' : `${winPct}%` },
          ].map((s) => (
            <div key={s.label} style={{ padding: '10px 8px', borderRadius: 10, background: 'rgba(0,0,0,0.28)', border: `1px solid ${LOBBY_TOKENS.border}`, textAlign: 'center' }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#fff' }}>{s.value}</div>
              <div style={{ fontSize: 10, color: LOBBY_TOKENS.muted, letterSpacing: 0.6, marginTop: 3 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}
      {!me && !loading && (
        <div style={{ fontSize: 12.5, color: LOBBY_TOKENS.muted, marginTop: 10, lineHeight: 1.6 }}>
          Your ranked profile could not be read just now.
        </div>
      )}

      <RankedQueueControl queue={queue} onDeckScreen={onDeckScreen} onBoosters={onBoosters} />
    </LadderCard>
  );
}

/**
 * The ladder screen.
 *
 * Reachable from the hub dock, the matchmaking panel and the lobby — and it is
 * where the `ranked` deep-link finally resolves to something again.
 */
function RankedPage({ myName, queue, onBack, onDeckScreen, onBoosters, onViewProfile }: {
  myName: string; queue: RankedQueue; onBack: () => void;
  onDeckScreen: () => void; onBoosters: () => void; onViewProfile: (name: string) => void;
}) {
  const mobile = useIsMobile(1000);
  const [season, setSeason] = useState<SeasonInfo | null>(null);
  const [me, setMe] = useState<OwnRankedProfile | null>(null);
  const [board, setBoard] = useState<RankedLeaderboard | null>(null);
  const [matches, setMatches] = useState<RankedMatchEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [boardError, setBoardError] = useState('');
  const [historyError, setHistoryError] = useState('');

  // Four independent reads. Each is allowed to fail on its own — a leaderboard
  // outage must not blank the season panel or the queue button.
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const [s, m, b, h] = await Promise.all([
        RankedAPI.getSeason().catch(() => null),
        RankedAPI.getMe().catch(() => null),
        RankedAPI.getLeaderboard({ limit: 100 }).then(
          (r) => ({ ok: true as const, r }),
          (e) => ({ ok: false as const, e }),
        ),
        RankedAPI.getMyMatches({ limit: 20 }).then(
          (r) => ({ ok: true as const, r }),
          (e) => ({ ok: false as const, e }),
        ),
      ]);
      if (!alive) return;
      setSeason(s);
      setMe(m);
      if (b.ok) { setBoard(b.r); setBoardError(''); } else { setBoard(null); setBoardError(errorText(b.e)); }
      if (h.ok) { setMatches(h.r); setHistoryError(''); } else { setMatches(null); setHistoryError(errorText(h.e)); }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [myName]);

  // The queue is what changes a standing, so re-read it when the player stops
  // queueing rather than leaving a stale rank on screen.
  const queueStatus = queue.state.status;
  useEffect(() => {
    if (queueStatus !== 'idle') return;
    let alive = true;
    RankedAPI.getMe().then((m) => { if (alive) setMe(m); }).catch(() => {});
    return () => { alive = false; };
  }, [queueStatus]);

  const standing = standingOf(me);

  return (
    <div style={{
      position: 'relative', minHeight: '100vh', color: LOBBY_TOKENS.text, fontFamily: PROFILE_FONT,
      backgroundImage: 'url(/lobby-bg.png?v=2)', backgroundSize: 'cover',
      backgroundPosition: 'center', backgroundAttachment: 'fixed',
    }}>
      <div aria-hidden style={{
        position: 'fixed', inset: 0, zIndex: 0,
        background: 'linear-gradient(180deg, rgba(7,9,15,0.80) 0%, rgba(7,9,15,0.60) 50%, rgba(7,9,15,0.90) 100%)',
      }} />
      <div style={{ position: 'relative', zIndex: 1 }}>
        <header style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: mobile ? '14px 14px' : '18px 22px',
          borderBottom: `1px solid ${LOBBY_TOKENS.border}`,
        }}>
          <button onClick={onBack} style={LOBBY_GHOST_BTN}><ArrowLeft size={13} /> Back</button>
          <h1 style={{
            margin: 0, flex: 1, fontFamily: '"Cinzel", serif', fontSize: mobile ? 19 : 24,
            fontWeight: 700, letterSpacing: '0.06em', color: LOBBY_TOKENS.gold,
          }}>RANKED LADDER</h1>
        </header>

        <div style={{
          maxWidth: 1240, margin: '0 auto', padding: mobile ? '14px 14px 40px' : '20px 22px 60px',
          display: 'grid', gap: mobile ? 14 : 18,
          gridTemplateColumns: mobile ? '1fr' : 'minmax(300px, 380px) minmax(0, 1fr)',
          alignItems: 'start',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: mobile ? 14 : 18, minWidth: 0 }}>
            <MyStandingPanel me={me} standing={standing} loading={loading} queue={queue}
              onDeckScreen={onDeckScreen} onBoosters={onBoosters} />
            <SeasonPanel info={season} standing={standing} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: mobile ? 14 : 18, minWidth: 0 }}>
            <LeaderboardPanel board={board} loading={loading} error={boardError}
              myName={myName} onViewProfile={onViewProfile} />
            <RankedHistoryPanel matches={matches} loading={loading} error={historyError} />
          </div>
        </div>
      </div>
    </div>
  );
}


function Screen({ title, right, children, fullBleed }: { title: string; right?: React.ReactNode; children: React.ReactNode; fullBleed?: boolean }) {
  const mobile = useIsMobile();
  const pad = fullBleed ? 0 : (mobile ? 12 : 24);
  return (
    <div style={{ fontFamily: F.body, background: `${SURF.vignette}, ${SURF.obsidian}`, minHeight: '100vh', padding: pad, color: C.textHi }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: fullBleed ? 0 : 16, gap: 8, flexWrap: 'wrap',
        padding: fullBleed ? (mobile ? '8px 12px' : '10px 18px') : 0,
        position: fullBleed ? 'absolute' : 'static',
        top: 0, left: 0, right: 0, zIndex: 4,
        background: fullBleed ? 'linear-gradient(180deg, rgba(0,0,0,0.55), rgba(0,0,0,0))' : 'transparent',
      }}>
        <h1 style={{ margin: 0, fontFamily: F.serif, fontWeight: 700, letterSpacing: '0.06em',
          fontSize: mobile ? 20 : 26, lineHeight: 1.1, color: C.goldHi,
          textShadow: fullBleed ? '0 2px 10px rgba(0,0,0,0.85)' : '0 0 26px rgba(217,180,90,0.25)' }}>{title}</h1>
        <div>{right}</div>
      </div>
      {children}
    </div>
  );
}
function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ ...engravedPanel(), marginTop: 20, padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12 }}>
        <div style={{ fontFamily: F.serif, fontWeight: 700, color: C.goldHi, fontSize: 15, letterSpacing: '0.1em' }}>{title}</div>
        <div>{right}</div>
      </div>
      {children}
    </div>
  );
}
function Banner({ kind, children }: { kind: 'error' | 'info'; children: React.ReactNode }) {
  const bg = kind === 'error' ? 'rgba(255,107,107,0.10)' : 'rgba(124,92,255,0.10)';
  const bd = kind === 'error' ? 'rgba(255,107,107,0.5)' : 'rgba(124,92,255,0.5)';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '12px 16px', background: bg, border: `1px solid ${bd}`, color: C.textHi,
      borderRadius: 12, fontSize: 13, marginTop: 12, lineHeight: 1.5,
      boxShadow: EDGE.topHighlight,
    }}>
      <span style={{ color: kind === 'error' ? C.danger : C.accentHi, display: 'inline-flex', flexShrink: 0 }}>
        {kind === 'error' ? <Warning size={16} /> : <Info size={16} />}
      </span>
      <span>{children}</span>
    </div>
  );
}
// ── Wager UI ────────────────────────────────────────────────────────────────
//
// ═══════════════════════════════════════════════════════════════════════════
// STAKED MATCHES ARE GATED OFF. THE BACKEND CANNOT SETTLE THEM.
// ═══════════════════════════════════════════════════════════════════════════
//
// `src/api/wager.ts` is a complete, correct client for `/wager/*` — stakes,
// escrows, deposits — and the escrow database is genuinely well built. What is
// NOT there is anything that gets a player their money back out
// (INTEGRATION.md §7, §9):
//
//   • THERE IS NO DEPLOYED ESCROW CONTRACT. `depositAddress` is an EOA whose
//     key is a plain env var inside a container. Funds sit in a hot wallet.
//   • NO PAYOUT HAS EVER RUN ON A REAL CHAIN. The sign → persist → broadcast →
//     reconcile path is unit-tested against a `noop` settlement and has never
//     executed. The first real payout would be its first execution.
//   • DEPOSIT VERIFICATION HAS NEVER SEEN A REAL ERC-20 TRANSFER either.
//   • There is no settlement endpoint at all — payouts are decided by a
//     background worker, and the client has no way to trigger or observe one
//     beyond polling `wager.getEscrow()`.
//
// A stake button here would take a real ERC-20 transfer from a player and
// promise a payout that has never once been delivered. So it is disabled with
// a stated reason rather than left to fail — that is the whole instruction.
//
// TO TURN THIS ON, in order:
//   1. deploy an escrow contract (or put the hot key behind a KMS/HSM with a
//      withdrawal policy) so stakes are not one `docker exec` from gone;
//   2. exercise deposit → funded → settle → payout end to end on a testnet,
//      including a forced crash between broadcast and record;
//   3. then build the picker below against `wager.getStakes()` — it returns
//      `{tiers: [{tier, amountBase}], token, decimals}` and the escrow body
//      takes the TIER INDEX (`{matchId, tier}`). There is no `amount` field
//      and sending `amountBase` is a 400, because a client that names its own
//      amount can name a smaller one than its opponent's.
//
// Production's live tier list, for reference:
//   tiers [{tier:0, amountBase:"1000000"}, {tier:1,"5000000"}, {tier:2,"25000000"}]
//   token 0x1c7d…7238, decimals 6

/** Can a match carry a real stake? Not until a payout has ever run. */
export const WAGERS_AVAILABLE = false as const;

export const WAGERS_UNAVAILABLE_MESSAGE =
  'Staked matches are not available yet: there is no escrow contract, and no payout has ever been executed on-chain.';

/**
 * The stakes control, in its only honest state.
 *
 * Deliberately not an input the player can fill in and then be told "no" — the
 * feature is off, the reason is stated, and there is nothing to click.
 */
function WagerControls() {
  return (
    <div style={{
      marginTop: 12, padding: '12px 14px', borderRadius: 10,
      background: 'rgba(143,92,255,0.06)', border: '1px dashed rgba(143,92,255,0.4)',
      opacity: 0.95,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 11, fontWeight: 800, letterSpacing: 1.6, color: '#c8a3ff',
      }}><Coins size={14} /> STAKES · COMING SOON</div>
      <div style={{ fontSize: 12, color: LOBBY_TOKENS.muted, marginTop: 6, lineHeight: 1.6 }}>
        {WAGERS_UNAVAILABLE_MESSAGE} Every match is free to play in the meantime.
      </div>
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
  ...goldPlate(!enabled),
  padding: '11px 20px', fontSize: 13,
});
const ghostBtn: React.CSSProperties = { ...obsidianPlate(false), minHeight: 40, padding: '10px 15px', fontSize: 12 };
const disabledBtn: React.CSSProperties = { ...goldPlate(true), padding: '11px 20px', fontSize: 13 };
// formatRecord re-exported for any other consumer; not used here.
export { formatRecord };

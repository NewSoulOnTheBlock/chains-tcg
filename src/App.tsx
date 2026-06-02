// src/App.tsx
// Online lobby + multiplayer client for Chains TCG.
// Flow: Login -> Lobby (create/join match) -> Waiting room -> Game.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Client } from 'boardgame.io/react';
import { SocketIO } from 'boardgame.io/multiplayer';
import { LobbyClient } from 'boardgame.io/client';
import { ChainsTCG } from './Game';
import { ChainsBoard } from './Board';
import { CARDS, COLOR_META, COLORS, BUILDABLE_CARDS, validateDeck, DECK_SIZE, MAX_COPIES_NONBASIC, isBasicNode, type Color } from './cards';
import {
  listProfilesApi, getProfileApi, getProfileByWalletApi, upsertProfileApi, updateProfileApi, getLibraryApi,
  getDeckApi, saveDeckApi, formatRecord, type Profile, type LibraryCard,
} from './profiles';
import { connectEvm, connectSolana, shortAddr, type ConnectedWallet } from './wallet';
import { CardHover } from './CardPreview';
import { RankedAPI, tierColors, rankLabel, type PublicRankedProfile, type LeaderboardEntry } from './ranked-client';

// ── Config ──────────────────────────────────────────────────────────────────
// Server base: in dev Vite proxies /games (lobby) and /socket.io to :8000.
// In prod the React build is served by the same Node server, so use same origin.
const SERVER_BASE = (import.meta.env.VITE_SERVER_BASE as string | undefined) ?? '';
const GAME_NAME = ChainsTCG.name!;
const COLOR_ORDER: Color[] = ['bnb', 'sol', 'hl', 'eth', 'xrp'];

const lobby = new LobbyClient({ server: SERVER_BASE || undefined });

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
function Login({ onLogin, onFirstTime }: {
  onLogin: (name: string) => void;
  onFirstTime: (wallet: ConnectedWallet) => void;
}) {
  const [name, setName] = useState(local.get<string>('lastName', '') || sess.get<string>('lastName', ''));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<'evm' | 'sol' | null>(null);

  async function doConnect(kind: 'evm' | 'sol') {
    setErr(''); setBusy(kind);
    try {
      const w = kind === 'evm' ? await connectEvm() : await connectSolana();
      const existing = await getProfileByWalletApi(w.address);
      if (existing) onLogin(existing.name);
      else onFirstTime(w);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setBusy(null); }
  }

  return (
    <Screen title="Memetic Masters TCG — Sign In">
      <p style={{ color: '#aaa', marginTop: 0 }}>Connect your wallet to play. Your W/L is tracked globally.</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 380 }}>
        <button onClick={() => doConnect('evm')} disabled={!!busy}
          style={{ ...primaryBtn(true), background: 'linear-gradient(90deg,#f6851b,#e2761b)', padding: '14px 18px', fontSize: 14, letterSpacing: 0.5 }}>
          {busy === 'evm' ? 'Connecting…' : '🦊  Connect EVM Wallet (MetaMask / Rabby / Coinbase)'}
        </button>
        <button onClick={() => doConnect('sol')} disabled={!!busy}
          style={{ ...primaryBtn(true), background: 'linear-gradient(90deg,#9945ff,#14f195)', padding: '14px 18px', fontSize: 14, letterSpacing: 0.5 }}>
          {busy === 'sol' ? 'Connecting…' : '👻  Connect Phantom (Solana)'}
        </button>
      </div>

      {err && <Banner kind="error">{err}</Banner>}

      <div style={{ marginTop: 30, paddingTop: 18, borderTop: '1px solid #222' }}>
        <div style={{ color: '#888', fontSize: 12, marginBottom: 8 }}>or continue as guest</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onLogin(name.trim()); }}
            placeholder="display name"
            style={inputStyle}
          />
          <button
            onClick={() => name.trim() && onLogin(name.trim())}
            disabled={!name.trim()}
            style={primaryBtn(!!name.trim())}
          >Continue</button>
        </div>
      </div>
    </Screen>
  );
}

// ── First-time profile creation (after wallet connect with no existing profile) ─
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

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.size > 600 * 1024) { setErr('Image too large — must be under 600 KB.'); return; }
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

  return (
    <Screen title="Welcome — Create your profile"
      right={<button onClick={onCancel} style={ghostBtn}>Cancel</button>}>
      <Banner kind="info">
        Wallet connected: <b style={{ color: '#fff' }}>{shortAddr(wallet.address)}</b>{' '}
        <span style={{ color: '#888' }}>({wallet.chain.toUpperCase()})</span>. Set up your profile to continue.
      </Banner>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px,260px) 1fr', gap: 24, marginTop: 20 }}>
        <div>
          <div style={{
            width: '100%', aspectRatio: '1', borderRadius: 12, overflow: 'hidden',
            background: '#181820', border: '1px solid #2a2a32',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {avatarUrl
              ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <div style={{ fontSize: 56, color: '#444' }}>👤</div>}
          </div>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ ...ghostBtn, display: 'inline-block', textAlign: 'center', cursor: 'pointer' }}>
              Upload picture
              <input type="file" accept="image/*" onChange={onPickFile} style={{ display: 'none' }} />
            </label>
            <input value={avatarUrl} onChange={e => setAvatarUrl(e.target.value)}
              placeholder="...or paste image URL" style={inputStyle} />
          </div>
        </div>

        <div>
          <div style={labelStyle}>DISPLAY NAME *</div>
          <input value={name} onChange={e => setName(e.target.value)} autoFocus
            placeholder="how others see you"
            style={{ ...inputStyle, fontSize: 16 }} />

          <div style={{ marginTop: 14 }}>
            <div style={labelStyle}>BIO</div>
            <textarea value={bio} onChange={e => setBio(e.target.value.slice(0, 500))} rows={5}
              placeholder="Tell the chain about yourself…"
              style={{ ...inputStyle, width: '100%', resize: 'vertical', minHeight: 100, fontFamily: 'system-ui' }} />
            <div style={{ fontSize: 11, color: '#666', textAlign: 'right' }}>{bio.length}/500</div>
          </div>

          {err && <Banner kind="error">{err}</Banner>}

          <div style={{ marginTop: 14 }}>
            <button onClick={create} disabled={saving || !name.trim()}
              style={primaryBtn(!saving && !!name.trim())}>
              {saving ? 'Creating…' : 'Create profile & enter game'}
            </button>
          </div>
        </div>
      </div>
    </Screen>
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

function MenuMusic()   { return <BgMusic src="/menu-music.mp3"   storageKey="musicMuted" />; }
function BattleMusic() { return <BgMusic src="/battle-music.mp3" storageKey="battleMuted" />; }

// ── Rules page ─────────────────────────────────────────────────────────────
function RulesPage({ onBack }: { onBack: () => void }) {
  return (
    <div style={{
      fontFamily: '"EB Garamond", Garamond, "Times New Roman", serif',
      background: 'radial-gradient(ellipse at top, #1a1240 0%, #0a0a1e 55%, #050510 100%)',
      minHeight: '100vh', color: '#ece1c7',
    }}>
      <div style={{
        padding: '14px 22px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        borderBottom: '1px solid #3a2a6a', position: 'sticky', top: 0,
        background: 'linear-gradient(180deg, #0a0a1e 0%, rgba(10,10,30,0.92) 100%)', zIndex: 5,
      }}>
        <button onClick={onBack} style={ghostBtn}>← Back</button>
        <div style={{
          fontFamily: '"Cinzel", "Times New Roman", serif',
          fontWeight: 800, letterSpacing: 4, fontSize: 18,
          color: '#f0b32a',
          textShadow: '0 0 14px rgba(240,179,42,0.45)',
        }}>RULES</div>
        <div style={{ width: 80 }} />
      </div>

      <div style={{ maxWidth: 820, margin: '0 auto', padding: '28px 22px 60px', lineHeight: 1.6, fontSize: 16 }}>
        <H1>Memetic Masters TCG — Quick Rules</H1>

        <H2>Goal</H2>
        <P>Reduce your opponent's life from <B>20 → 0</B>. Last player standing wins.</P>

        <H2>Setup</H2>
        <UL items={[
          <>Each player picks one of <B>5 chains</B>: <CC c="#f3ba2f">BnB</CC> · <CC c="#9945ff">Solana</CC> · <CC c="#50d2c1">Hyperliquid</CC> · <CC c="#cfd8dc">Ethereum</CC> · <CC c="#8a8a8a">XRP</CC></>,
          <>Each gets a <B>60-card deck</B> in that color, shuffled.</>,
          <>Draw <B>7 cards</B>. Start at <B>20 life</B>.</>,
          <>Max hand size <B>7</B> at end of turn — discard down.</>,
          <>The player going <B>first does not draw on turn 1</B>; everyone else draws 1 at the start of their turn.</>,
        ]} />

        <H2>The 4 Card Types</H2>
        <Table rows={[
          ['Node',    'Your "land". Free to play but only 1 per turn. Tap on a later turn to add 1 Gas of its color.'],
          ['Meme',    'Your creatures. Have Power / Toughness. Attack to deal damage to the opponent.'],
          ['Machine', 'Permanent ongoing effect (like an artifact/enchantment). Stays in play until destroyed.'],
          ['Move',    'One-shot spell. Resolves immediately, then goes to the graveyard.'],
        ]} />

        <H2>Gas (the mana system)</H2>
        <UL items={[
          <><B>Nodes generate Gas. Cards cost Gas.</B></>,
          <>Tap a Node → <B>+1 Gas</B> of its color.</>,
          <>Gas in your pool <B>drains at end of your turn</B> — spend it or lose it.</>,
          <>A cost can be all one color (e.g. 3 purple) or mixed.</>,
        ]} />

        <H2>A turn, step by step</H2>
        <OL items={[
          <><B>Untap</B> — your Nodes/Memes/Machines untap. Summoning sickness wears off.</>,
          <><B>Draw 1</B> (skipped on the very first turn of the game).</>,
          <>
            <B>Main phase</B> — in any order:
            <UL items={[
              <>Play <B>one Node</B> (free).</>,
              <>Tap Nodes for Gas.</>,
              <>Cast Memes (they enter <B>summoning sick</B> — can't attack until your next turn unless they have haste).</>,
              <>Cast Machines (they stay on the battlefield).</>,
              <>Cast Moves (they resolve, then go to the graveyard).</>,
            ]} />
          </>,
          <>
            <B>Combat</B> — click your untapped, non-sick Memes to mark them as <B>attackers</B>, then press <i>Attack with N meme(s)</i>.
            <UL items={[
              <>Each attacking Meme <B>taps</B>.</>,
              <>Opponent picks Memes to <B>block</B>. Each blocker must be untapped.</>,
              <><B>Damage resolves simultaneously</B>: attacker and blocker deal their Power to each other. Damage ≥ toughness → destroyed (to graveyard).</>,
              <>Any attacker that <B>isn't blocked</B> deals its Power directly to the opponent's <B>life</B>.</>,
            ]} />
          </>,
          <><B>End turn</B> — unspent Gas evaporates, discard down to 7 cards.</>,
        ]} />

        <H2>30-second teach</H2>
        <UL items={[
          <><B>Nodes = mana.</B> One per turn. Tap for gas.</>,
          <><B>Memes = creatures.</B> Sick the turn they enter; can't attack.</>,
          <><B>Machines = permanent passives.</B></>,
          <><B>Moves = one-shot effects.</B></>,
          <><B>Combat:</B> attack with untapped memes → opponent blocks → damage swaps.</>,
          <><B>Life = 20.</B> Hit zero, you lose.</>,
          <><B>Gas resets every turn — spend it.</B></>,
        ]} />

        <H2>UI cheat-sheet</H2>
        <UL items={[
          <><B>Click an untapped node</B> = tap for gas.</>,
          <><B>Click a card in hand</B> = play it (move spells then ask you to pick a target).</>,
          <><B>Click your own untapped meme</B> during your main phase = mark as attacker. Press <i>Attack with N</i>.</>,
          <>During <B>declare blockers</B> (when the opponent attacks), click your untapped meme then click the attacker you want to block.</>,
          <>Press <B>End Turn</B> to pass.</>,
        ]} />

        <P style={{ marginTop: 28, fontSize: 14, color: '#a99878', fontStyle: 'italic' }}>
          That's the whole game. Have fun.
        </P>
      </div>
    </div>
  );
}

function H1({ children }: { children: React.ReactNode }) {
  return <h1 style={{
    fontFamily: '"Cinzel", "Times New Roman", serif',
    fontSize: 34, margin: '0 0 22px', letterSpacing: 1,
    color: '#f0b32a',
    textShadow: '0 0 18px rgba(240,179,42,0.4), 0 2px 0 #2a1a05',
  }}>{children}</h1>;
}
function H2({ children }: { children: React.ReactNode }) {
  return <h2 style={{
    fontFamily: '"Cinzel", "Times New Roman", serif',
    fontSize: 20, margin: '30px 0 10px', letterSpacing: 2,
    color: '#b896ff',
    textTransform: 'uppercase',
    textShadow: '0 0 10px rgba(139,92,246,0.35)',
    borderBottom: '1px solid rgba(139,92,246,0.25)', paddingBottom: 4,
  }}>{children}</h2>;
}
function P({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <p style={{ margin: '8px 0', color: '#ece1c7', ...style }}>{children}</p>;
}
function B({ children }: { children: React.ReactNode }) {
  return <b style={{ color: '#ffd66e' }}>{children}</b>;
}
function CC({ c, children }: { c: string; children: React.ReactNode }) {
  return <span style={{ color: c, fontWeight: 700 }}>{children}</span>;
}
function UL({ items }: { items: React.ReactNode[] }) {
  return (
    <ul style={{ margin: '6px 0 6px 22px', padding: 0, color: '#ece1c7' }}>
      {items.map((it, i) => <li key={i} style={{ marginBottom: 5 }}>{it}</li>)}
    </ul>
  );
}
function OL({ items }: { items: React.ReactNode[] }) {
  return (
    <ol style={{ margin: '6px 0 6px 22px', padding: 0, color: '#ece1c7' }}>
      {items.map((it, i) => <li key={i} style={{ marginBottom: 10 }}>{it}</li>)}
    </ol>
  );
}
function Table({ rows }: { rows: [string, string][] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', margin: '10px 0' }}>
      <tbody>
        {rows.map(([k, v], i) => (
          <tr key={i} style={{ borderTop: '1px solid rgba(139,92,246,0.22)' }}>
            <td style={{
              padding: '10px 12px', width: 160,
              fontFamily: '"Cinzel", "Times New Roman", serif',
              fontWeight: 700, color: '#f0b32a',
              letterSpacing: 1, textTransform: 'uppercase', fontSize: 13,
              verticalAlign: 'top',
            }}>{k}</td>
            <td style={{ padding: '10px 12px', color: '#ece1c7' }}>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Landing screen (post-login hub) ─────────────────────────────────────────
function Landing({
  myName, onPlay, onRanked, onProfile, onRules, onLogout,
}: { myName: string; onPlay: () => void; onRanked: () => void; onProfile: () => void; onRules: () => void; onLogout: () => void }) {
  const mobile = useIsMobile();
  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#000', color: '#fff', fontFamily: 'system-ui' }}>
      <img
        src="/intro.png"
        alt=""
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', zIndex: 0, imageRendering: 'pixelated' }}
      />
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.1) 55%, rgba(0,0,0,0.75) 100%)', zIndex: 1 }} />

      {/* Top bar */}
      <div style={{
        position: 'relative', zIndex: 2,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: mobile ? '10px 12px' : '14px 22px',
        gap: 8, flexWrap: 'wrap',
      }}>
        <div style={{ fontWeight: 800, fontSize: mobile ? 13 : 16, letterSpacing: 1.5, textShadow: '0 2px 8px #000' }}>MEMETIC MASTERS TCG</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#ddd', textShadow: '0 1px 4px #000' }}>Signed in as <b>{myName}</b></span>
          <button onClick={onLogout} style={ghostBtn}>Sign out</button>
        </div>
      </div>

      {/* Action menu */}
      <div style={{
        position: 'absolute',
        left: mobile ? '50%' : '8vw',
        transform: mobile ? 'translateX(-50%)' : undefined,
        right: mobile ? undefined : undefined,
        bottom: mobile ? '6vh' : '10vh',
        zIndex: 2,
        display: 'flex', flexDirection: 'column', gap: 10,
        width: mobile ? 'calc(100vw - 24px)' : undefined,
        minWidth: mobile ? undefined : 220,
        maxWidth: mobile ? 360 : undefined,
      }}>
        <MenuBtn primary onClick={onPlay}>▶  PLAY</MenuBtn>
        <MenuBtn ranked onClick={onRanked}>🏆  RANKED</MenuBtn>
        <MenuBtn onClick={onProfile}>👤  PROFILE</MenuBtn>
        <MenuBtn onClick={onRules}>📖  RULES</MenuBtn>
        <MenuBtn onClick={() => window.open('https://x.com/MemeticMasters', '_blank', 'noopener')}>📰  NEWS</MenuBtn>
      </div>
    </div>
  );
}

function MenuBtn({ children, onClick, primary, ranked }: { children: React.ReactNode; onClick: () => void; primary?: boolean; ranked?: boolean }) {
  const bg = ranked
    ? 'linear-gradient(90deg, #7b2cbf, #c084fc)'
    : primary ? 'linear-gradient(90deg, #ff7e1a, #ffb347)' : 'rgba(20,20,20,0.75)';
  const shadow = ranked
    ? '0 6px 24px rgba(192,132,252,0.5)'
    : primary ? '0 6px 24px rgba(255,126,26,0.45)' : '0 4px 16px rgba(0,0,0,0.6)';
  return (
    <button
      onClick={onClick}
      style={{
        padding: '14px 22px',
        background: bg,
        color: '#fff',
        border: (primary || ranked) ? 'none' : '1px solid rgba(255,255,255,0.25)',
        borderRadius: 6,
        fontWeight: 800,
        fontSize: 16,
        letterSpacing: 1.2,
        cursor: 'pointer',
        textAlign: 'left',
        backdropFilter: 'blur(6px)',
        boxShadow: shadow,
        transition: 'transform 0.08s ease',
      }}
      onMouseDown={e => (e.currentTarget.style.transform = 'translateY(1px)')}
      onMouseUp={e => (e.currentTarget.style.transform = 'translateY(0)')}
      onMouseLeave={e => (e.currentTarget.style.transform = 'translateY(0)')}
    >{children}</button>
  );
}

// ── Profile page ────────────────────────────────────────────────────────────
function ProfilePage({ myName, onBack }: { myName: string; onBack: () => void }) {
  const mobile = useIsMobile();
  const [prof, setProf] = useState<Profile | null>(null);
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        let p = await getProfileApi(myName);
        if (!p) p = await upsertProfileApi(myName);
        setProf(p);
        setBio(p.bio ?? '');
        setAvatarUrl(p.avatarUrl ?? '');
      } finally { setLoading(false); }
    })();
  }, [myName]);

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.size > 600 * 1024) { setStatus('Image too large — must be under 600 KB.'); return; }
    const reader = new FileReader();
    reader.onload = () => setAvatarUrl(String(reader.result || ''));
    reader.readAsDataURL(f);
  }

  async function save() {
    setSaving(true); setStatus('');
    try {
      const p = await updateProfileApi(myName, { bio: bio.trim() || null, avatarUrl: avatarUrl.trim() || null });
      setProf(p);
      setStatus('Saved.');
    } catch (e: any) { setStatus('Save failed: ' + String(e?.message ?? e)); }
    finally { setSaving(false); }
  }

  const games = prof ? prof.wins + prof.losses + prof.draws : 0;
  const winPct = games ? Math.round((prof!.wins / games) * 100) : 0;

  return (
    <div style={{ fontFamily: 'system-ui', background: '#0a0a0c', minHeight: '100vh', color: '#eee' }}>
      <div style={{ padding: '14px 22px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #222' }}>
        <button onClick={onBack} style={ghostBtn}>← Back</button>
        <div style={{ fontWeight: 800, letterSpacing: 1.5 }}>PROFILE</div>
        <div style={{ width: 80 }} />
      </div>

      {loading ? (
        <div style={{ padding: 40, color: '#888' }}>Loading…</div>
      ) : (
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
              {avatarUrl ? (
                <img src={avatarUrl} alt="avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <div style={{ fontSize: 64, color: '#444' }}>👤</div>
              )}
            </div>
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ ...ghostBtn, display: 'inline-block', textAlign: 'center', cursor: 'pointer' }}>
                Upload picture
                <input type="file" accept="image/*" onChange={onPickFile} style={{ display: 'none' }} />
              </label>
              <input
                value={avatarUrl}
                onChange={e => setAvatarUrl(e.target.value)}
                placeholder="...or paste image URL"
                style={inputStyle}
              />
            </div>

            <div style={{ marginTop: 18, padding: 14, background: '#101015', border: '1px solid #25252e', borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: '#888', letterSpacing: 1.5, marginBottom: 8 }}>RECORD</div>
              <div style={{ display: 'flex', justifyContent: 'space-around', textAlign: 'center' }}>
                <Stat label="Wins"   value={prof?.wins   ?? 0} color="#7fdc7f" />
                <Stat label="Losses" value={prof?.losses ?? 0} color="#ef7373" />
                <Stat label="Draws"  value={prof?.draws  ?? 0} color="#cccc77" />
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
            }}>{prof?.name ?? myName}</div>
            <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>Your handle is fixed — sign in with a different name to switch profiles.</div>

            <div style={{ marginTop: 18 }}>
              <div style={labelStyle}>BIO</div>
              <textarea
                value={bio}
                onChange={e => setBio(e.target.value.slice(0, 500))}
                rows={6}
                placeholder="Tell the chain about yourself…"
                style={{ ...inputStyle, width: '100%', resize: 'vertical', minHeight: 120, fontFamily: 'system-ui' }}
              />
              <div style={{ fontSize: 11, color: '#666', textAlign: 'right' }}>{bio.length}/500</div>
            </div>

            <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
              <button onClick={save} disabled={saving} style={primaryBtn(!saving)}>{saving ? 'Saving…' : 'Save changes'}</button>
              {status && <span style={{ fontSize: 13, color: status.startsWith('Saved') ? '#7fdc7f' : '#ef7373' }}>{status}</span>}
            </div>
          </div>
        </div>
      )}

      {!loading && <LibrarySection prof={prof} />}
      {!loading && <DeckbuilderPanel myName={myName} />}
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
      const typeOrder = ['node', 'meme', 'machine', 'move'];
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

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: mobile ? '0 14px 30px' : '0 24px 40px' }}>
      <div style={{
        marginTop: 4, padding: 14,
        background: '#101015', border: '1px solid #25252e', borderRadius: 8,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontWeight: 800, color: '#f1e3a8', letterSpacing: 1.5, fontSize: 14 }}>
            📚 LIBRARY — MEMETIC MASTERS
          </div>
          {wallet && isSol && (
            <button onClick={load} style={ghostBtn}>{loading ? '…' : '↻ Refresh'}</button>
          )}
        </div>

        {!wallet && (
          <div style={{ marginTop: 10, fontSize: 13, color: '#888' }}>
            Connect a wallet from the home screen to see your collection.
          </div>
        )}
        {wallet && !isSol && (
          <div style={{ marginTop: 10, fontSize: 13, color: '#888' }}>
            Memetic Masters live on Solana. Your linked wallet ({wallet.slice(0,6)}…) is EVM.
            Link a Solana wallet to populate this library.
          </div>
        )}
        {err && (
          <div style={{ marginTop: 10, fontSize: 12, color: '#ef7373' }}>{err}</div>
        )}
        {wallet && isSol && !loading && cards && cards.length === 0 && !err && (
          <div style={{ marginTop: 10, fontSize: 13, color: '#888' }}>
            No Memetic Masters NFTs found in this wallet.
          </div>
        )}
        {wallet && isSol && loading && (
          <div style={{ marginTop: 10, fontSize: 13, color: '#888' }}>Scanning chain…</div>
        )}

        {cards && cards.length > 0 && (
          <div style={{
            marginTop: 12, display: 'grid',
            gridTemplateColumns: `repeat(auto-fill, minmax(${mobile ? 110 : 140}px, 1fr))`,
            gap: 10,
          }}>
            {cards.map(c => <LibraryCardTile key={c.id} card={c} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function LibraryCardTile({ card }: { card: LibraryCard }) {
  return (
    <div style={{
      borderRadius: 8, overflow: 'hidden',
      background: '#181820', border: '1px solid #2a2a32',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ aspectRatio: '1', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {card.image
          ? <img src={card.image} alt={card.name} loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <div style={{ fontSize: 28, color: '#444' }}>🎴</div>}
      </div>
      <div style={{ padding: '6px 8px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#eee', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {card.name}
        </div>
        {card.collection && (
          <div style={{ fontSize: 10, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const cards = await getDeckApi(myName);
        const next: Record<string, number> = {};
        for (const id of cards) next[id] = (next[id] ?? 0) + 1;
        setCounts(next);
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
      if (delta > 0 && total >= DECK_SIZE) return prev; // hard-cap at 60 when adding
      const out = { ...prev };
      if (next === 0) delete out[id]; else out[id] = next;
      return out;
    });
  }

  async function save() {
    setSaving(true); setStatus('');
    try {
      if (!validation.ok) { setStatus(validation.issues[0]?.message ?? 'Invalid deck.'); return; }
      await saveDeckApi(myName, deckList);
      setStatus('Saved!');
    } catch (e: any) {
      setStatus(String(e?.message ?? e));
    } finally { setSaving(false); }
  }

  function clear() {
    if (!confirm('Clear your custom deck?')) return;
    setCounts({});
    setStatus('');
  }

  const visible = filter === 'all' ? BUILDABLE_CARDS : BUILDABLE_CARDS.filter(c => c.color === filter);

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: mobile ? '0 14px 40px' : '0 24px 50px' }}>
      <div style={{ marginTop: 14, padding: 14, background: '#101015', border: '1px solid #25252e', borderRadius: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontWeight: 800, color: '#9cf', letterSpacing: 1.5, fontSize: 14 }}>
            🛠️ CUSTOM DECK ({total}/{DECK_SIZE})
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={clear} style={ghostBtn}>Clear</button>
            <button onClick={save} disabled={!validation.ok || saving} style={validation.ok ? primaryBtn(!saving) : disabledBtn}>
              {saving ? 'Saving…' : 'Save deck'}
            </button>
            {status && <span style={{ fontSize: 12, color: status === 'Saved!' ? '#7fdc7f' : '#ef7373' }}>{status}</span>}
          </div>
        </div>

        {/* Validation hints */}
        {!validation.ok && validation.issues.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#fc8' }}>
            {validation.issues.slice(0, 3).map((it, i) => <div key={i}>• {it.message}</div>)}
          </div>
        )}

        {/* Color filter */}
        <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
          <FilterChip selected={filter === 'all'} onClick={() => setFilter('all')} label="All" />
          {COLORS.map(c => (
            <FilterChip key={c} selected={filter === c}
              onClick={() => setFilter(c)}
              label={COLOR_META[c].name} hex={COLOR_META[c].hex} ink={COLOR_META[c].ink} />
          ))}
        </div>

        {loading ? (
          <div style={{ marginTop: 10, fontSize: 13, color: '#888' }}>Loading deck…</div>
        ) : (
          <div style={{
            marginTop: 12, display: 'grid',
            gridTemplateColumns: `repeat(auto-fill, minmax(${mobile ? 150 : 200}px, 1fr))`, gap: 8,
          }}>
            {visible.map(def => {
              const n = counts[def.id] ?? 0;
              const cap = isBasicNode(def.id) ? Infinity : MAX_COPIES_NONBASIC;
              const meta = COLOR_META[def.color];
              return (
                <CardHover key={def.id} defId={def.id}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 8px',
                  background: '#0c0c12', borderRadius: 4,
                  border: `1px solid ${n > 0 ? meta.hex : '#25252e'}`,
                }}>
                  <div style={{
                    width: 18, height: 18, borderRadius: 9,
                    background: meta.hex, color: meta.ink, flex: '0 0 auto',
                    fontSize: 10, fontWeight: 800, display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                  }}>{def.type[0].toUpperCase()}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#eee', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {def.name}
                    </div>
                    <div style={{ fontSize: 10, color: '#888' }}>
                      {def.type}{def.type === 'meme' && ` · ${def.power}/${def.toughness}`}
                    </div>
                  </div>
                  <button onClick={() => bump(def.id, -1)} disabled={n === 0} style={tinyBtn}>−</button>
                  <div style={{ minWidth: 16, textAlign: 'center', fontSize: 12, fontWeight: 700, color: n > 0 ? '#fff' : '#555' }}>{n}</div>
                  <button onClick={() => bump(def.id, +1)}
                    disabled={n >= cap || total >= DECK_SIZE}
                    style={tinyBtn}>+</button>
                </div>
                </CardHover>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
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
  myName, onJoined, onBack, onViewProfile,
}: { myName: string; onJoined: (seat: Seat) => void; onBack: () => void; onViewProfile: (name: string) => void }) {
  const mobile = useIsMobile();
  const [matches, setMatches] = useState<any[]>([]);
  const [leaderboard, setLeaderboard] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Create-match panel state — creator only picks their own color now.
  const [myColor, setMyColor] = useState<Color>('sol');
  const [seatChoice, setSeatChoice] = useState<'0' | '1'>('0');
  // Custom-deck state (creator and joiner each pick standard color OR custom).
  const [myDeck, setMyDeck] = useState<string[]>([]);
  const [useCustom, setUseCustom] = useState(false);
  const [joinDeck, setJoinDeck] = useState<string[]>([]);
  const [joinUseCustom, setJoinUseCustom] = useState(false);
  // Join modal state — second player picks their color when accepting.
  const [joinTarget, setJoinTarget] = useState<{ match: any; seat: string } | null>(null);
  const [joinColor, setJoinColor] = useState<Color>('eth');
  // Match stakes — 'free' or a SOL wager. Currently UI-only metadata stored in setupData.
  const [wagerKind, setWagerKind] = useState<'free' | 'sol'>('free');
  const [wagerAmount, setWagerAmount] = useState<string>('0.1');
  // Optional human-readable match name so opponents can find each other in the lobby.
  const [matchName, setMatchName] = useState<string>('');

  // Load this player's saved custom deck on mount (if any).
  useEffect(() => {
    (async () => {
      try {
        const cards = await getDeckApi(myName);
        setMyDeck(cards);
        setJoinDeck(cards);
      } catch {}
    })();
  }, [myName]);

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
      const wager = parseWager(wagerKind, wagerAmount);
      if (wagerKind === 'sol' && !wager) {
        setError('Enter a valid SOL wager amount greater than 0.');
        return;
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
    if (w.kind === 'sol') {
      const ok = window.confirm(
        `This is a WAGERED match.\n\nStakes: ${w.amount} SOL — winner takes the pot.\n\n` +
        `By continuing you agree to pay ${w.amount} SOL if you lose. Continue?`
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
    } catch (e: any) { setError(String(e?.message ?? e)); }
  }

  // Split available matches between the two side panels of the art frame.
  const openMatches = matches.filter(m => (m.players as Array<{ name?: string }>).some(p => !p.name));
  const leftMatches = openMatches.filter((_, i) => i % 2 === 0);
  const rightMatches = openMatches.filter((_, i) => i % 2 === 1);

  const panelHeader: React.CSSProperties = {
    fontFamily: 'serif', fontSize: 13, fontWeight: 800, letterSpacing: 2,
    color: '#f1e3a8', textAlign: 'center', textShadow: '0 1px 4px #000',
    padding: '4px 0', borderBottom: '1px solid rgba(180,150,80,0.45)', marginBottom: 4,
  };
  const panelEmpty: React.CSSProperties = {
    fontSize: 11, color: '#a59a78', textAlign: 'center', padding: 8, fontStyle: 'italic',
  };

  function MatchTile({ m }: { m: any }) {
    const players = (m.players as Array<{ id: number; name?: string }>);
    const filled = players.filter(p => p.name).length;
    const colors = (m.setupData?.colors ?? [null, null]) as Array<Color | null>;
    const inProgress = filled === players.length;
    const creator = players.find(p => p.name);
    const creatorCol = creator ? colors[creator.id] : null;
    return (
      <div style={{
        background: 'rgba(8,14,26,0.78)', border: '1px solid rgba(180,150,80,0.45)',
        borderRadius: 6, padding: 10, color: '#e9e4d0', boxShadow: '0 2px 10px rgba(0,0,0,0.45)',
      }}>
        {(() => {
          const mName = readMatchName(m.setupData);
          return (
            <>
              <div style={{ fontSize: 12, color: '#c9b97a', letterSpacing: 1, textTransform: 'uppercase' }}>
                {mName ? mName : `Match ${m.matchID.slice(0, 6)}`}
              </div>
              {mName && (
                <div style={{ fontSize: 9, color: '#7d7050', letterSpacing: 0.5, marginTop: 1 }}>
                  ID {m.matchID.slice(0, 6)}
                </div>
              )}
            </>
          );
        })()}
        <div style={{ fontWeight: 700, marginTop: 2, fontSize: 14 }}>
          {creator?.name ?? 'Open'}
          {creatorCol && (
            <span style={{ color: COLOR_META[creatorCol].hex, marginLeft: 6 }}>
              ({COLOR_META[creatorCol].name})
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: '#a59a78', marginTop: 2 }}>
          {filled}/{players.length} seated
        </div>
        {(() => {
          const w = readWager(m.setupData);
          return (
            <div style={{
              fontSize: 10, marginTop: 4, padding: '2px 6px', display: 'inline-block',
              background: w.kind === 'sol' ? 'rgba(153,69,255,0.18)' : 'rgba(180,150,80,0.18)',
              color: w.kind === 'sol' ? '#c8a3ff' : '#d9c98e',
              border: `1px solid ${w.kind === 'sol' ? 'rgba(153,69,255,0.55)' : 'rgba(180,150,80,0.55)'}`,
              borderRadius: 3, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase',
            }}>{wagerLabel(w)}</div>
          );
        })()}
        <button
          onClick={() => openJoin(m)}
          disabled={inProgress}
          style={{
            marginTop: 8, width: '100%', padding: '6px 0',
            background: inProgress ? '#33312a' : 'linear-gradient(180deg,#d9b65a,#9a7a2c)',
            color: inProgress ? '#777' : '#1a1408', border: '1px solid #6a5520',
            borderRadius: 4, fontWeight: 800, fontSize: 12,
            cursor: inProgress ? 'not-allowed' : 'pointer',
          }}
        >{inProgress ? 'Full' : 'Accept'}</button>
      </div>
    );
  }

  return (
    <Screen title={`Choose your deck — ${myName}`} fullBleed={!mobile}
      right={<button onClick={onBack} style={ghostBtn}>← Back</button>}>
      {error && <Banner kind="error">{error}</Banner>}

      {/* Castle-frame lobby (desktop) — falls back to stacked layout on mobile */}
      {mobile ? (
        <div style={{
          position: 'relative', width: '100%', borderRadius: 8, overflow: 'hidden',
          background: '#0a0e1a', border: '1px solid rgba(180,150,80,0.35)',
        }}>
          <div style={{
            backgroundImage: 'url(/lobby-bg.png)', backgroundSize: 'cover', backgroundPosition: 'center',
            padding: '16px 14px', borderBottom: '1px solid rgba(180,150,80,0.45)',
          }}>
            <div style={{
              fontFamily: 'serif', fontSize: 18, fontWeight: 800, color: '#f1e3a8',
              letterSpacing: 2, textAlign: 'center', textShadow: '0 2px 6px #000', marginBottom: 10,
            }}>Choose Your Chain</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {COLORS.map(c => {
                const meta = COLOR_META[c];
                const selected = !useCustom && myColor === c;
                return (
                  <button key={c} onClick={() => { setUseCustom(false); setMyColor(c); }} style={{
                    padding: '10px 12px', fontWeight: 800, fontSize: 14,
                    background: selected ? `linear-gradient(90deg, ${meta.hex}, ${meta.hex}aa)` : 'rgba(10,12,20,0.78)',
                    color: selected ? meta.ink : '#e9e4d0',
                    border: `2px solid ${selected ? '#f1e3a8' : 'rgba(180,150,80,0.45)'}`,
                    borderRadius: 4, cursor: 'pointer', textAlign: 'left',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <span>{meta.name}</span>
                    <span style={{ fontSize: 10, opacity: 0.85 }}>{c.toUpperCase()}</span>
                  </button>
                );
              })}
              <button onClick={() => setUseCustom(v => !v)} disabled={!myDeckOk} style={{
                padding: '10px 12px', fontWeight: 800, fontSize: 14,
                background: useCustom ? 'linear-gradient(90deg,#7aa7ff,#5b6df5)' : 'rgba(10,12,20,0.78)',
                color: useCustom ? '#0a0a18' : (myDeckOk ? '#e9e4d0' : '#666'),
                border: `2px dashed ${useCustom ? '#f1e3a8' : 'rgba(120,170,255,0.45)'}`,
                borderRadius: 4, cursor: myDeckOk ? 'pointer' : 'not-allowed', textAlign: 'left',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <span>🛠️ Custom Deck</span>
                <span style={{ fontSize: 10, opacity: 0.85 }}>
                  {myDeckOk ? (useCustom ? 'ON' : 'OFF') : `Build in Profile`}
                </span>
              </button>
            </div>
            <div style={{
              display: 'flex', gap: 6, marginTop: 10, justifyContent: 'center',
              background: 'rgba(10,12,20,0.7)', padding: '6px 10px',
              border: '1px solid rgba(180,150,80,0.35)', borderRadius: 4,
            }}>
              <span style={{ fontSize: 11, color: '#c9b97a', alignSelf: 'center' }}>SEAT</span>
              {(['0','1'] as const).map(s => (
                <button key={s} onClick={() => setSeatChoice(s)} style={{
                  padding: '4px 14px', fontWeight: 700, fontSize: 12,
                  background: seatChoice === s ? '#f1e3a8' : 'transparent',
                  color: seatChoice === s ? '#1a1408' : '#e9e4d0',
                  border: '1px solid rgba(180,150,80,0.55)', borderRadius: 3, cursor: 'pointer',
                }}>P{s}</button>
              ))}
            </div>
            <input
              type="text"
              value={matchName}
              onChange={e => setMatchName(e.target.value.slice(0, 40))}
              placeholder="Match name (optional)"
              maxLength={40}
              style={{
                width: '100%', padding: '6px 8px', fontSize: 12,
                background: 'rgba(10,12,20,0.7)', color: '#e9e4d0',
                border: '1px solid rgba(180,150,80,0.55)', borderRadius: 3,
                fontFamily: 'inherit',
              }}
            />
            <WagerControls kind={wagerKind} amount={wagerAmount}
              onKind={setWagerKind} onAmount={setWagerAmount} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={createAndJoin} style={{
                flex: 1, padding: '10px 0',
                background: 'linear-gradient(180deg,#d9b65a,#9a7a2c)',
                color: '#1a1408', border: '1px solid #6a5520', borderRadius: 4,
                fontWeight: 900, letterSpacing: 1, cursor: 'pointer', fontSize: 13,
              }}>⚔ CREATE</button>
              <button onClick={refresh} style={{
                flex: 1, padding: '10px 0',
                background: 'rgba(10,12,20,0.7)', color: '#f1e3a8',
                border: '1px solid rgba(180,150,80,0.55)', borderRadius: 4,
                fontWeight: 800, letterSpacing: 1, cursor: 'pointer', fontSize: 13,
              }}>{loading ? '…' : `↻ REFRESH (${openMatches.length})`}</button>
            </div>
          </div>

          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={panelHeader}>Open Matches</div>
            {openMatches.length === 0 && <div style={panelEmpty}>No open matches.</div>}
            {openMatches.map(m => <MatchTile key={m.matchID} m={m} />)}
          </div>
        </div>
      ) : (
      <div style={{
        position: 'relative', width: '100vw', margin: 0,
        aspectRatio: '1248 / 832',
        maxHeight: '100vh',
        backgroundImage: 'url(/lobby-bg.png?v=2)',
        backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat',
        overflow: 'hidden',
      }}>
        {/* Left panel — available matches */}
        <div style={{
          position: 'absolute', left: '3.5%', top: '9.5%', width: '18.5%', height: '56%',
          padding: '10px 8px', overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={panelHeader}>Open Matches</div>
          {leftMatches.length === 0 && rightMatches.length === 0 && (
            <div style={panelEmpty}>No open matches.<br/>Create one from the altar.</div>
          )}
          {leftMatches.map(m => <MatchTile key={m.matchID} m={m} />)}
        </div>

        {/* Right panel — available matches */}
        <div style={{
          position: 'absolute', right: '3.5%', top: '9.5%', width: '18.5%', height: '56%',
          padding: '10px 8px', overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={panelHeader}>Joinable</div>
          {rightMatches.map(m => <MatchTile key={m.matchID} m={m} />)}
          {rightMatches.length === 0 && leftMatches.length > 0 && (
            <div style={panelEmpty}>—</div>
          )}
        </div>

        {/* Center — chain picker + create */}
        <div style={{
          position: 'absolute', left: '28%', top: '12%', width: '44%',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        }}>
          <div style={{
            fontFamily: 'serif', fontSize: 22, fontWeight: 800,
            color: '#f1e3a8', letterSpacing: 2, textShadow: '0 2px 6px #000',
          }}>Choose Your Chain</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 220 }}>
            {COLORS.map(c => {
              const meta = COLOR_META[c];
              const selected = !useCustom && myColor === c;
              return (
                <button key={c} onClick={() => { setUseCustom(false); setMyColor(c); }} style={{
                  padding: '8px 12px', fontWeight: 800, fontSize: 14,
                  background: selected
                    ? `linear-gradient(90deg, ${meta.hex}, ${meta.hex}aa)`
                    : 'rgba(10,12,20,0.7)',
                  color: selected ? meta.ink : '#e9e4d0',
                  border: `2px solid ${selected ? '#f1e3a8' : 'rgba(180,150,80,0.45)'}`,
                  borderRadius: 4, cursor: 'pointer', textAlign: 'left',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  textShadow: selected ? 'none' : '0 1px 2px #000',
                }}>
                  <span>{meta.name}</span>
                  <span style={{ fontSize: 10, opacity: 0.85 }}>{c.toUpperCase()}</span>
                </button>
              );
            })}
            <button onClick={() => setUseCustom(v => !v)} disabled={!myDeckOk} style={{
              padding: '8px 12px', fontWeight: 800, fontSize: 14,
              background: useCustom ? 'linear-gradient(90deg,#7aa7ff,#5b6df5)' : 'rgba(10,12,20,0.7)',
              color: useCustom ? '#0a0a18' : (myDeckOk ? '#e9e4d0' : '#666'),
              border: `2px dashed ${useCustom ? '#f1e3a8' : 'rgba(120,170,255,0.45)'}`,
              borderRadius: 4, cursor: myDeckOk ? 'pointer' : 'not-allowed', textAlign: 'left',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>🛠️ Custom Deck</span>
              <span style={{ fontSize: 10, opacity: 0.85 }}>
                {myDeckOk ? (useCustom ? 'ON' : 'OFF') : 'Build in Profile'}
              </span>
            </button>
          </div>
          <div style={{
            display: 'flex', gap: 6, marginTop: 4,
            background: 'rgba(10,12,20,0.7)', padding: '6px 10px',
            border: '1px solid rgba(180,150,80,0.35)', borderRadius: 4,
          }}>
            <span style={{ fontSize: 11, color: '#c9b97a', alignSelf: 'center' }}>SEAT</span>
            {(['0','1'] as const).map(s => (
              <button key={s} onClick={() => setSeatChoice(s)} style={{
                padding: '4px 12px', fontWeight: 700, fontSize: 12,
                background: seatChoice === s ? '#f1e3a8' : 'transparent',
                color: seatChoice === s ? '#1a1408' : '#e9e4d0',
                border: '1px solid rgba(180,150,80,0.55)', borderRadius: 3, cursor: 'pointer',
              }}>P{s}</button>
            ))}
          </div>
          <input
            type="text"
            value={matchName}
            onChange={e => setMatchName(e.target.value.slice(0, 40))}
            placeholder="Match name (optional)"
            maxLength={40}
            style={{
              width: '100%', padding: '4px 6px', fontSize: 11,
              background: 'rgba(10,12,20,0.7)', color: '#e9e4d0',
              border: '1px solid rgba(180,150,80,0.55)', borderRadius: 3,
              fontFamily: 'inherit',
            }}
          />
          <WagerControls compact kind={wagerKind} amount={wagerAmount}
            onKind={setWagerKind} onAmount={setWagerAmount} />
        </div>

        {/* Bottom-left banner — create button */}
        <div style={{
          position: 'absolute', left: '4.5%', bottom: '5%', width: '18%', height: '7%',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 6px',
        }}>
          <button onClick={createAndJoin} style={{
            width: '100%', height: '80%',
            background: 'linear-gradient(180deg,#d9b65a,#9a7a2c)',
            color: '#1a1408', border: '1px solid #6a5520', borderRadius: 4,
            fontWeight: 900, letterSpacing: 1, cursor: 'pointer',
          }}>⚔ CREATE MATCH</button>
        </div>

        {/* Bottom-right banner — refresh */}
        <div style={{
          position: 'absolute', right: '4.5%', bottom: '5%', width: '18%', height: '7%',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 6px',
        }}>
          <button onClick={refresh} style={{
            width: '100%', height: '80%',
            background: 'rgba(10,12,20,0.7)', color: '#f1e3a8',
            border: '1px solid rgba(180,150,80,0.55)', borderRadius: 4,
            fontWeight: 800, letterSpacing: 1, cursor: 'pointer',
          }}>{loading ? '…' : `↻ REFRESH (${openMatches.length})`}</button>
        </div>
      </div>
      )}

      <Section title="Leaderboard">
        {leaderboard.length === 0 ? (
          <div style={{ color: '#777', fontSize: 13 }}>No players yet.</div>
        ) : (
          <table style={{ width: '100%', fontSize: 13, color: '#ddd', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: '#888', textAlign: 'left' }}>
                <th style={{ padding: 4 }}>#</th>
                <th style={{ padding: 4 }}>Player</th>
                <th style={{ padding: 4 }}>W</th>
                <th style={{ padding: 4 }}>L</th>
                <th style={{ padding: 4 }}>D</th>
                <th style={{ padding: 4 }}>Win%</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((p, i) => {
                const games = p.wins + p.losses + p.draws;
                const wp = games ? Math.round((p.wins / games) * 100) : 0;
                return (
                  <tr key={p.name} style={{ borderTop: '1px solid #222' }}>
                    <td style={{ padding: 4, color: '#888' }}>{i + 1}</td>
                    <td style={{ padding: 4, fontWeight: 700 }}>
                      <button
                        onClick={() => onViewProfile(p.name)}
                        title={`View ${p.name}'s profile`}
                        style={{
                          background: 'none', border: 'none', padding: 0,
                          color: '#9cf', fontWeight: 700, fontSize: 'inherit',
                          fontFamily: 'inherit', cursor: 'pointer',
                          textDecoration: 'underline dotted', textUnderlineOffset: 3,
                        }}
                      >{p.name}</button>
                    </td>
                    <td style={{ padding: 4, color: '#9f9' }}>{p.wins}</td>
                    <td style={{ padding: 4, color: '#f99' }}>{p.losses}</td>
                    <td style={{ padding: 4 }}>{p.draws}</td>
                    <td style={{ padding: 4 }}>{wp}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>

      {joinTarget && (
        <div onClick={() => setJoinTarget(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: '#141418', border: '1px solid #2a2a32', borderRadius: 10,
            padding: 20, width: 'min(560px, calc(100vw - 24px))',
            maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', color: '#eee',
          }}>
            <h2 style={{ margin: '0 0 6px', fontSize: 20 }}>Accept match</h2>
            <p style={{ color: '#aaa', marginTop: 0, fontSize: 13 }}>
              You're joining as <b style={{ color: '#fff' }}>P{joinTarget.seat}</b>. Pick the deck you want to play with.
            </p>
            {(() => {
              const mName = readMatchName(joinTarget.match.setupData);
              if (!mName) return null;
              return (
                <div style={{
                  fontSize: 13, marginBottom: 10, padding: '6px 10px',
                  background: 'rgba(240,179,42,0.10)', border: '1px solid rgba(240,179,42,0.45)',
                  borderRadius: 4, color: '#ffd66e', fontWeight: 700,
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
                  background: 'rgba(180,150,80,0.12)', border: '1px solid rgba(180,150,80,0.45)',
                  borderRadius: 4, color: '#d9c98e', fontWeight: 700, letterSpacing: 0.5,
                }}>Stakes: FREE MATCH</div>;
              }
              return <div style={{
                fontSize: 13, marginBottom: 12, padding: '8px 10px',
                background: 'rgba(153,69,255,0.14)', border: '1px solid rgba(153,69,255,0.55)',
                borderRadius: 4, color: '#e6d4ff',
              }}>
                <div style={{ fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', fontSize: 11, color: '#c8a3ff' }}>Wagered Match</div>
                <div style={{ marginTop: 2 }}>Accepting will agree to a <b style={{ color: '#fff' }}>{w.amount} SOL</b> wager — winner takes the pot.</div>
              </div>;
            })()}
            <ColorChooser label="Your chain" value={joinColor} onChange={(c) => { setJoinUseCustom(false); setJoinColor(c); }} />
            {validateDeck(joinDeck).ok && (
              <div style={{ marginTop: 10 }}>
                <button onClick={() => setJoinUseCustom(v => !v)} style={{
                  width: '100%', padding: '8px 12px', fontWeight: 800, fontSize: 13,
                  background: joinUseCustom ? 'linear-gradient(90deg,#7aa7ff,#5b6df5)' : 'rgba(10,12,20,0.78)',
                  color: joinUseCustom ? '#0a0a18' : '#e9e4d0',
                  border: `2px dashed ${joinUseCustom ? '#f1e3a8' : 'rgba(120,170,255,0.45)'}`,
                  borderRadius: 4, cursor: 'pointer',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <span>🛠️ Use Custom Deck</span>
                  <span style={{ fontSize: 10, opacity: 0.85 }}>{joinUseCustom ? 'ON' : 'OFF'}</span>
                </button>
              </div>
            )}
            <div style={{ marginTop: 18, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setJoinTarget(null)} style={ghostBtn}>Cancel</button>
              <button onClick={confirmJoin} style={primaryBtn(true)}>Accept & enter match</button>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}

// ── In-match seat (waits if opponent not yet present) ───────────────────────
function MatchSeat({ seat, onLeave }: { seat: Seat; onLeave: () => void }) {
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

  async function leave() {
    try { await lobby.leaveMatch(GAME_NAME, seat.matchID, { playerID: seat.playerID, credentials: seat.credentials }); } catch {}
    onLeave();
  }

  return (
    <div style={{ background: '#000', minHeight: '100vh' }}>
      <div style={{ padding: 6, background: '#111', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ color: '#aaa', fontFamily: 'system-ui', fontSize: 13 }}>
          Match <span style={{ fontFamily: 'monospace', color: '#888' }}>{seat.matchID.slice(0, 8)}</span>
          {' · '}You are <b style={{ color: '#fff' }}>{seat.playerName}</b> (P{seat.playerID})
          {!isFull && <span style={{ marginLeft: 12, color: '#fc6' }}>Waiting for opponent…</span>}
        </div>
        <button onClick={leave} style={ghostBtn}>Leave</button>
      </div>
      {!isFull ? (
        <div style={{ padding: 24, color: '#ccc' }}>
          <h3>Share this link with your opponent:</h3>
          <pre style={{ background: '#111', padding: 8, border: '1px solid #333', borderRadius: 4, color: '#9cf' }}>
            {window.location.origin + window.location.pathname + '#match=' + seat.matchID}
          </pre>
          <div style={{ marginTop: 12, fontSize: 13, color: '#888' }}>
            {players.map((p, i) => <div key={i}>Seat P{i}: {p.name ?? <i style={{ color: '#666' }}>open</i>}</div>)}
          </div>
        </div>
      ) : (
        <>
          <BattleMusic />
          <ChainsClient
            matchID={seat.matchID}
            playerID={seat.playerID}
            credentials={seat.credentials}
          />
        </>
      )}
    </div>
  );
}

// ── Root ────────────────────────────────────────────────────────────────────
type View = 'landing' | 'profile' | 'rules' | 'lobby' | 'view-profile' | 'ranked';

export default function App() {
  const [name, setName] = useState<string>(() => local.get<string>('myName', ''));
  const [seat, setSeat] = useState<Seat | null>(() => local.get<Seat | null>('seat', null));
  const [view, setView] = useState<View>(() => sess.get<View>('view', 'landing'));
  const [pendingWallet, setPendingWallet] = useState<ConnectedWallet | null>(null);
  const [viewedProfile, setViewedProfile] = useState<string | null>(null);

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
  const showMusic = view === 'landing' || view === 'profile' || view === 'rules' || view === 'lobby' || view === 'ranked';
  return (
    <>
      {showMusic && <MenuMusic />}
      {view === 'profile'
        ? <ProfilePage myName={name} onBack={() => goto('landing')} />
        : view === 'rules'
          ? <RulesPage onBack={() => goto('landing')} />
          : view === 'view-profile' && viewedProfile
            ? <PublicProfile name={viewedProfile} onBack={() => goto('lobby')} />
            : view === 'ranked'
              ? <RankedHub myName={name} onBack={() => goto('landing')} onJoined={joinedSeat} onViewProfile={n => { setViewedProfile(n); goto('view-profile'); }} />
              : view === 'lobby'
                ? <Lobby
                    myName={name}
                    onJoined={joinedSeat}
                    onBack={() => goto('landing')}
                    onViewProfile={n => { setViewedProfile(n); goto('view-profile'); }}
                  />
                : <Landing myName={name} onPlay={() => goto('lobby')} onRanked={() => goto('ranked')} onProfile={() => goto('profile')} onRules={() => goto('rules')} onLogout={logout} />}
    </>
  );
}

// ── Ranked Hub ─────────────────────────────────────────────────────────────
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
    }}>
      <div style={{ fontSize: fs, letterSpacing: 0.5 }}>{p.visibleRank.slice(0, size === 'sm' ? 3 : 99).toUpperCase()}</div>
      {roman && <div style={{ fontSize: fs - 2, opacity: 0.85 }}>{roman}</div>}
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
  useEffect(() => {
    (async () => {
      try {
        const d = await getDeckApi(myName);
        setDeckOk(validateDeck(d).ok);
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
      const r = await RankedAPI.queueJoin(myName, region);
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
                <div style={{ fontSize: 12, color: '#aaa', textTransform: 'uppercase', letterSpacing: 1.2 }}>{myName}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#fff', marginTop: 4 }}>
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
                  <div style={{ marginTop: 8, fontSize: 12, color: '#f99' }}>
                    You need a valid 60-card deck on your Profile before queueing.
                  </div>
                )}
              </>
            ) : (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 14, color: '#aaa', marginBottom: 6 }}>Searching for opponent…</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: '#c084fc', fontVariantNumeric: 'tabular-nums' }}>
                  {Math.floor(waitMs / 60000)}:{String(Math.floor((waitMs / 1000) % 60)).padStart(2, '0')}
                </div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
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
          <div style={{ fontSize: 12, color: '#7fb', textTransform: 'uppercase', letterSpacing: 1.2 }}>Current Season</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#fff', marginTop: 4 }}>{season?.name ?? '—'}</div>
          <div style={{ fontSize: 13, color: '#aaa', marginTop: 4 }}>
            {seasonDaysLeft} days remaining
          </div>
          <div style={{ marginTop: 14, fontSize: 12, color: '#bbb', lineHeight: 1.7 }}>
            <div><b style={{ color: '#fff' }}>Hidden MMR:</b> The matchmaker uses a hidden Glicko-2 rating you never see.</div>
            <div style={{ marginTop: 4 }}><b style={{ color: '#fff' }}>Placements:</b> 10 games to lock in your starting rank.</div>
            <div style={{ marginTop: 4 }}><b style={{ color: '#fff' }}>Soft Reset:</b> Each season your MMR collapses halfway toward 1500.</div>
            <div style={{ marginTop: 4 }}><b style={{ color: '#fff' }}>Rewards:</b> Cosmetics only — no gameplay advantages.</div>
          </div>
        </div>
      </div>

      {/* Leaderboard */}
      <Section title="Season Leaderboard" right={<button onClick={refresh} style={ghostBtn}>↻</button>}>
        {leaders.length === 0
          ? <div style={{ color: '#888', fontSize: 13 }}>No ranked players yet — be the first.</div>
          : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ color: '#888', textAlign: 'left' }}>
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
                        <td style={{ padding: '8px', fontWeight: 700, color: l.rank <= 3 ? '#ffd86a' : '#888' }}>
                          {l.rank}
                        </td>
                        <td style={{ padding: '8px', color: '#fff' }}>
                          {l.playerId}{isMe && <span style={{ color: '#c084fc', marginLeft: 6 }}>(you)</span>}
                        </td>
                        <td style={{ padding: '8px' }}>
                          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                            <RankBadge p={l} size="sm" />
                            <span>{rankLabel(l)}</span>
                          </span>
                        </td>
                        <td style={{ padding: '8px', textAlign: 'right', color: '#ccc' }}>{l.wins}/{l.losses}</td>
                        <td style={{ padding: '8px', textAlign: 'right', color: '#ccc' }}>{lwr}%</td>
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
type Wager = { kind: 'free' } | { kind: 'sol'; amount: number };

function parseWager(kind: 'free' | 'sol', raw: string): Wager | null {
  if (kind === 'free') return { kind: 'free' };
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return null;
  // Round to 6 decimals (1 lamport ≈ 1e-9 SOL; this is a UI metadata for now).
  return { kind: 'sol', amount: Math.round(n * 1e6) / 1e6 };
}

function readWager(setupData: any): Wager {
  const w = setupData?.wager;
  if (w && (w.kind === 'free' || w.kind === 'sol')) return w as Wager;
  return { kind: 'free' };
}

function readMatchName(setupData: any): string {
  const n = setupData?.matchName;
  return typeof n === 'string' ? n.trim().slice(0, 40) : '';
}

function wagerLabel(w: Wager): string {
  return w.kind === 'free' ? 'Free Match' : `Wager · ${w.amount} SOL`;
}

function WagerControls({
  kind, amount, onKind, onAmount, compact,
}: {
  kind: 'free' | 'sol'; amount: string;
  onKind: (k: 'free' | 'sol') => void; onAmount: (s: string) => void;
  compact?: boolean;
}) {
  const Btn = ({ k, label }: { k: 'free' | 'sol'; label: string }) => {
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
        <Btn k="free" label="Free" />
        <Btn k="sol"  label="Wager · SOL" />
      </div>
      {kind === 'sol' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: '#c9b97a', minWidth: 50 }}>AMOUNT</span>
          <input
            type="number" inputMode="decimal" min={0} step={0.01}
            value={amount}
            onChange={e => onAmount(e.target.value)}
            placeholder="0.10"
            style={{
              flex: 1, padding: '4px 8px', fontSize: 12, fontWeight: 700,
              background: '#000', color: '#f1e3a8',
              border: '1px solid rgba(180,150,80,0.55)', borderRadius: 3,
            }}
          />
          <span style={{ fontSize: 11, color: '#c9b97a', fontWeight: 700 }}>SOL</span>
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
                color: sel ? (c === 'eth' ? '#000' : '#fff') : (c === 'xrp' ? '#fff' : meta.hex),
                border: `2px solid ${c === 'xrp' ? '#fff' : meta.hex}`,
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

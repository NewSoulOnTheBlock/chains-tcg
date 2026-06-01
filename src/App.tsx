// src/App.tsx
// Online lobby + multiplayer client for Chains TCG.
// Flow: Login -> Lobby (create/join match) -> Waiting room -> Game.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Client } from 'boardgame.io/react';
import { SocketIO } from 'boardgame.io/multiplayer';
import { LobbyClient } from 'boardgame.io/client';
import { ChainsTCG } from './Game';
import { ChainsBoard } from './Board';
import { COLOR_META, type Color } from './cards';
import {
  listProfilesApi, getProfileApi, getProfileByWalletApi, upsertProfileApi, updateProfileApi, formatRecord, type Profile,
} from './profiles';
import { connectEvm, connectSolana, shortAddr, type ConnectedWallet } from './wallet';

// ── Config ──────────────────────────────────────────────────────────────────
// Server base: in dev Vite proxies /games (lobby) and /socket.io to :8000.
// In prod the React build is served by the same Node server, so use same origin.
const SERVER_BASE = (import.meta.env.VITE_SERVER_BASE as string | undefined) ?? '';
const GAME_NAME = ChainsTCG.name!;
const COLOR_ORDER: Color[] = ['bnb', 'sol', 'hl', 'eth', 'xrp'];

const lobby = new LobbyClient({ server: SERVER_BASE || undefined });

// ── Persistence helpers (sessionStorage so each tab can be a different player) ─
const sess = {
  get<T>(k: string, def: T): T { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) as T : def; } catch { return def; } },
  set(k: string, v: any) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k: string) { try { sessionStorage.removeItem(k); } catch {} },
};

type Seat = { matchID: string; playerID: string; credentials: string; playerName: string };

// ── Login screen ────────────────────────────────────────────────────────────
function Login({ onLogin, onFirstTime }: {
  onLogin: (name: string) => void;
  onFirstTime: (wallet: ConnectedWallet) => void;
}) {
  const [name, setName] = useState(sess.get<string>('lastName', ''));
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
    <Screen title="Chains TCG — Sign In">
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
    <div style={{ fontFamily: 'system-ui', background: '#0a0a0c', minHeight: '100vh', color: '#eee' }}>
      <div style={{ padding: '14px 22px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #222', position: 'sticky', top: 0, background: '#0a0a0c', zIndex: 5 }}>
        <button onClick={onBack} style={ghostBtn}>← Back</button>
        <div style={{ fontWeight: 800, letterSpacing: 1.5 }}>RULES</div>
        <div style={{ width: 80 }} />
      </div>

      <div style={{ maxWidth: 820, margin: '0 auto', padding: '28px 22px 60px', lineHeight: 1.55 }}>
        <H1>Chains TCG — Quick Rules</H1>

        <H2>🎯 Goal</H2>
        <P>Reduce your opponent's life from <B>20 → 0</B>. Last player standing wins.</P>

        <H2>🛠️ Setup</H2>
        <UL items={[
          <>Each player picks one of <B>5 chains</B>: 🟠 <CC c="#f3ba2f">BnB</CC> · 🟣 <CC c="#9945ff">Solana</CC> · 🟢 <CC c="#50d2c1">Hyperliquid</CC> · ⚪ <CC c="#cfd8dc">Ethereum</CC> · ⚫ <CC c="#8a8a8a">XRP</CC></>,
          <>Each gets a <B>60-card deck</B> in that color, shuffled.</>,
          <>Draw <B>7 cards</B>. Start at <B>20 life</B>.</>,
          <>Max hand size <B>7</B> at end of turn — discard down.</>,
          <>The player going <B>first does not draw on turn 1</B>; everyone else draws 1 at the start of their turn.</>,
        ]} />

        <H2>🃏 The 4 Card Types</H2>
        <Table rows={[
          ['🟫 Node',    'Your "land". Free to play but only 1 per turn. Tap on a later turn to add 1 Gas of its color.'],
          ['👹 Meme',    'Your creatures. Have Power / Toughness. Attack to deal damage to the opponent.'],
          ['⚙️ Machine', 'Permanent ongoing effect (like an artifact/enchantment). Stays in play until destroyed.'],
          ['⚡ Move',    'One-shot spell. Resolves immediately, then goes to the graveyard.'],
        ]} />

        <H2>⛽ Gas (the mana system)</H2>
        <UL items={[
          <><B>Nodes generate Gas. Cards cost Gas.</B></>,
          <>Tap a Node → <B>+1 Gas</B> of its color.</>,
          <>Gas in your pool <B>drains at end of your turn</B> — spend it or lose it.</>,
          <>A cost can be all one color (e.g. 3 purple) or mixed.</>,
        ]} />

        <H2>🔄 A turn, step by step</H2>
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

        <H2>⏱️ 30-second teach</H2>
        <UL items={[
          <>🟢 <B>Nodes = mana.</B> One per turn. Tap for gas.</>,
          <>👹 <B>Memes = creatures.</B> Sick the turn they enter; can't attack.</>,
          <>⚙️ <B>Machines = permanent passives.</B></>,
          <>⚡ <B>Moves = one-shot effects.</B></>,
          <>⚔️ <B>Combat:</B> attack with untapped memes → opponent blocks → damage swaps.</>,
          <>💀 <B>Life = 20.</B> Hit zero, you lose.</>,
          <>🔥 <B>Gas resets every turn — spend it.</B></>,
        ]} />

        <H2>🖱️ UI cheat-sheet</H2>
        <UL items={[
          <><B>Click an untapped node</B> = tap for gas.</>,
          <><B>Click a card in hand</B> = play it (move spells then ask you to pick a target).</>,
          <><B>Click your own untapped meme</B> during your main phase = mark as attacker. Press <i>Attack with N</i>.</>,
          <>During <B>declare blockers</B> (when the opponent attacks), click your untapped meme then click the attacker you want to block.</>,
          <>Press <B>End Turn</B> to pass.</>,
        ]} />

        <P style={{ marginTop: 28, fontSize: 13, color: '#888' }}>
          That's the whole game. Have fun. 🎉
        </P>
      </div>
    </div>
  );
}

function H1({ children }: { children: React.ReactNode }) {
  return <h1 style={{ fontSize: 30, margin: '0 0 18px', letterSpacing: -0.5 }}>{children}</h1>;
}
function H2({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: 18, margin: '26px 0 8px', color: '#ffd066', letterSpacing: 0.3 }}>{children}</h2>;
}
function P({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <p style={{ margin: '6px 0', color: '#dcdcdc', ...style }}>{children}</p>;
}
function B({ children }: { children: React.ReactNode }) {
  return <b style={{ color: '#fff' }}>{children}</b>;
}
function CC({ c, children }: { c: string; children: React.ReactNode }) {
  return <span style={{ color: c, fontWeight: 700 }}>{children}</span>;
}
function UL({ items }: { items: React.ReactNode[] }) {
  return (
    <ul style={{ margin: '6px 0 6px 22px', padding: 0, color: '#dcdcdc' }}>
      {items.map((it, i) => <li key={i} style={{ marginBottom: 4 }}>{it}</li>)}
    </ul>
  );
}
function OL({ items }: { items: React.ReactNode[] }) {
  return (
    <ol style={{ margin: '6px 0 6px 22px', padding: 0, color: '#dcdcdc' }}>
      {items.map((it, i) => <li key={i} style={{ marginBottom: 8 }}>{it}</li>)}
    </ol>
  );
}
function Table({ rows }: { rows: [string, string][] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', margin: '8px 0' }}>
      <tbody>
        {rows.map(([k, v], i) => (
          <tr key={i} style={{ borderTop: '1px solid #222' }}>
            <td style={{ padding: '8px 10px', width: 140, fontWeight: 700, color: '#fff', verticalAlign: 'top' }}>{k}</td>
            <td style={{ padding: '8px 10px', color: '#dcdcdc' }}>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Landing screen (post-login hub) ─────────────────────────────────────────
function Landing({
  myName, onPlay, onProfile, onRules, onLogout,
}: { myName: string; onPlay: () => void; onProfile: () => void; onRules: () => void; onLogout: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#000', color: '#fff', fontFamily: 'system-ui' }}>
      <img
        src="/intro.png"
        alt=""
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', zIndex: 0, imageRendering: 'pixelated' }}
      />
      {/* Lighter overlay so the pixel-art title stays readable */}
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.1) 55%, rgba(0,0,0,0.75) 100%)', zIndex: 1 }} />

      {/* Top bar */}
      <div style={{ position: 'relative', zIndex: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 22px' }}>
        <div style={{ fontWeight: 800, fontSize: 18, letterSpacing: 1.5, textShadow: '0 2px 8px #000' }}>CHAINS TCG</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: '#ddd', textShadow: '0 1px 4px #000' }}>Signed in as <b>{myName}</b></span>
          <button onClick={onLogout} style={ghostBtn}>Sign out</button>
        </div>
      </div>

      {/* Title block — omitted; the artwork has its own title. */}

      {/* Action menu */}
      <div style={{
        position: 'absolute', left: '8vw', bottom: '10vh', zIndex: 2,
        display: 'flex', flexDirection: 'column', gap: 10, minWidth: 220,
      }}>
        <MenuBtn primary onClick={onPlay}>▶  PLAY</MenuBtn>
        <MenuBtn onClick={onProfile}>👤  PROFILE</MenuBtn>
        <MenuBtn onClick={onRules}>📖  RULES</MenuBtn>
        <MenuBtn onClick={() => window.open('https://x.com/memecoindevvv', '_blank', 'noopener')}>📰  NEWS</MenuBtn>
      </div>
    </div>
  );
}

function MenuBtn({ children, onClick, primary }: { children: React.ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '14px 22px',
        background: primary ? 'linear-gradient(90deg, #ff7e1a, #ffb347)' : 'rgba(20,20,20,0.75)',
        color: '#fff',
        border: primary ? 'none' : '1px solid rgba(255,255,255,0.25)',
        borderRadius: 6,
        fontWeight: 800,
        fontSize: 16,
        letterSpacing: 1.2,
        cursor: 'pointer',
        textAlign: 'left',
        backdropFilter: 'blur(6px)',
        boxShadow: primary ? '0 6px 24px rgba(255,126,26,0.45)' : '0 4px 16px rgba(0,0,0,0.6)',
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
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) 1fr', gap: 24, padding: 24, maxWidth: 980, margin: '0 auto' }}>
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
    </div>
  );
}

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
  myName, onJoined, onBack,
}: { myName: string; onJoined: (seat: Seat) => void; onBack: () => void }) {
  const [matches, setMatches] = useState<any[]>([]);
  const [leaderboard, setLeaderboard] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Create-match panel state
  const [c0, setC0] = useState<Color>('sol');
  const [c1, setC1] = useState<Color>('eth');
  const [seatChoice, setSeatChoice] = useState<'0' | '1'>('0');

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
      await upsertProfileApi(myName);
      const created = await lobby.createMatch(GAME_NAME, {
        numPlayers: 2,
        setupData: { colors: [c0, c1], names: ['Player 0', 'Player 1'] },
      });
      const joined = await lobby.joinMatch(GAME_NAME, created.matchID, {
        playerID: seatChoice,
        playerName: myName,
      });
      onJoined({ matchID: created.matchID, playerID: seatChoice, credentials: joined.playerCredentials, playerName: myName });
    } catch (e: any) { setError(String(e?.message ?? e)); }
  }

  async function joinExisting(m: any) {
    setError('');
    try {
      await upsertProfileApi(myName);
      const openSeat = (m.players as Array<{ id: number; name?: string }>).find(p => !p.name);
      if (!openSeat) throw new Error('No open seat');
      const pid = String(openSeat.id);
      const joined = await lobby.joinMatch(GAME_NAME, m.matchID, { playerID: pid, playerName: myName });
      onJoined({ matchID: m.matchID, playerID: pid, credentials: joined.playerCredentials, playerName: myName });
    } catch (e: any) { setError(String(e?.message ?? e)); }
  }

  return (
    <Screen title={`Choose your deck — ${myName}`}
      right={<button onClick={onBack} style={ghostBtn}>← Back</button>}>
      {error && <Banner kind="error">{error}</Banner>}

      <Section title="Create match">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <ColorChooser label="Player 0 chain" value={c0} onChange={setC0} />
          <ColorChooser label="Player 1 chain" value={c1} onChange={setC1} />
          <div>
            <div style={labelStyle}>Your seat</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['0','1'] as const).map(s => (
                <button key={s} onClick={() => setSeatChoice(s)}
                  style={seatChoice === s ? primaryBtn(true) : ghostBtn}>P{s}</button>
              ))}
            </div>
          </div>
          <button onClick={createAndJoin} style={primaryBtn(true)}>Create & Join</button>
        </div>
      </Section>

      <Section title={`Open matches (${matches.length})`} right={<button onClick={refresh} style={ghostBtn}>{loading ? '…' : 'Refresh'}</button>}>
        {matches.length === 0 && <div style={{ color: '#777', fontSize: 13 }}>No matches yet — create one above.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {matches.map(m => {
            const players = (m.players as Array<{ id: number; name?: string }>);
            const filled = players.filter(p => p.name).length;
            const setup = m.setupData ?? {};
            const colors = (setup.colors ?? ['?', '?']) as [string, string];
            const inProgress = filled === players.length;
            return (
              <div key={m.matchID} style={cardStyle}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, color: '#eee' }}>
                    Match <span style={{ color: '#888', fontFamily: 'monospace' }}>{m.matchID.slice(0, 8)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#aaa', marginTop: 2 }}>
                    {players.map((p, i) => (
                      <span key={i} style={{ marginRight: 12 }}>
                        P{i}: <b style={{ color: '#fff' }}>{p.name ?? <i style={{ color: '#777' }}>open</i>}</b>
                        {' '}
                        <span style={{ color: COLOR_META[colors[i] as Color]?.hex ?? '#888' }}>
                          ({COLOR_META[colors[i] as Color]?.name ?? colors[i]})
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => joinExisting(m)}
                  disabled={inProgress}
                  style={inProgress ? disabledBtn : primaryBtn(true)}
                >{inProgress ? 'Full' : 'Join'}</button>
              </div>
            );
          })}
        </div>
      </Section>

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
                    <td style={{ padding: 4, fontWeight: 700 }}>{p.name}</td>
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
type View = 'landing' | 'profile' | 'rules' | 'lobby';

export default function App() {
  const [name, setName] = useState<string>(() => sess.get<string>('myName', ''));
  const [seat, setSeat] = useState<Seat | null>(() => sess.get<Seat | null>('seat', null));
  const [view, setView] = useState<View>(() => sess.get<View>('view', 'landing'));
  const [pendingWallet, setPendingWallet] = useState<ConnectedWallet | null>(null);

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
        const open = (info.players as Array<{ id: number; name?: string }>).find(p => !p.name);
        if (!open) throw new Error('Match full');
        await upsertProfileApi(name);
        const joined = await lobby.joinMatch(GAME_NAME, matchID, { playerID: String(open.id), playerName: name });
        const s: Seat = { matchID, playerID: String(open.id), credentials: joined.playerCredentials, playerName: name };
        sess.set('seat', s); setSeat(s);
        window.history.replaceState(null, '', window.location.pathname);
      } catch (e) { console.warn('auto-join failed', e); }
    })();
  }, [name, seat]);

  function login(n: string) {
    sess.set('myName', n); sess.set('lastName', n); setName(n);
    setPendingWallet(null);
    upsertProfileApi(n).catch(() => {});
    goto('landing');
  }
  function logout() { sess.del('myName'); sess.del('seat'); sess.del('view'); setName(''); setSeat(null); setPendingWallet(null); setView('landing'); }
  function joinedSeat(s: Seat) { sess.set('seat', s); setSeat(s); }
  function leftSeat() { sess.del('seat'); setSeat(null); goto('landing'); }
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
  const showMusic = view === 'landing' || view === 'profile' || view === 'rules';
  return (
    <>
      {showMusic && <MenuMusic />}
      {view === 'profile'
        ? <ProfilePage myName={name} onBack={() => goto('landing')} />
        : view === 'rules'
          ? <RulesPage onBack={() => goto('landing')} />
          : view === 'lobby'
            ? <Lobby myName={name} onJoined={joinedSeat} onBack={() => goto('landing')} />
            : <Landing myName={name} onPlay={() => goto('lobby')} onProfile={() => goto('profile')} onRules={() => goto('rules')} onLogout={logout} />}
    </>
  );
}

// ── Tiny UI primitives ──────────────────────────────────────────────────────
function Screen({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: 'system-ui', background: '#000', minHeight: '100vh', padding: 24, color: '#eee' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>{title}</h1>
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
                color: sel ? (c === 'eth' ? '#000' : '#fff') : meta.hex,
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

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
  listProfilesApi, getProfileApi, upsertProfileApi, updateProfileApi, formatRecord, type Profile,
} from './profiles';

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
function Login({ onLogin }: { onLogin: (name: string) => void }) {
  const [name, setName] = useState(sess.get<string>('lastName', ''));
  return (
    <Screen title="Chains TCG — Sign In">
      <p style={{ color: '#aaa' }}>Pick a profile name. Your W/L is tracked globally.</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onLogin(name.trim()); }}
          placeholder="your name"
          autoFocus
          style={inputStyle}
        />
        <button
          onClick={() => name.trim() && onLogin(name.trim())}
          disabled={!name.trim()}
          style={primaryBtn(!!name.trim())}
        >Continue</button>
      </div>
    </Screen>
  );
}

// ── Landing screen (post-login hub) ─────────────────────────────────────────
function Landing({
  myName, onPlay, onProfile, onLogout,
}: { myName: string; onPlay: () => void; onProfile: () => void; onLogout: () => void }) {
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
        <ChainsClient
          matchID={seat.matchID}
          playerID={seat.playerID}
          credentials={seat.credentials}
        />
      )}
    </div>
  );
}

// ── Root ────────────────────────────────────────────────────────────────────
type View = 'landing' | 'profile' | 'lobby';

export default function App() {
  const [name, setName] = useState<string>(() => sess.get<string>('myName', ''));
  const [seat, setSeat] = useState<Seat | null>(() => sess.get<Seat | null>('seat', null));
  const [view, setView] = useState<View>(() => sess.get<View>('view', 'landing'));

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
    upsertProfileApi(n).catch(() => {});
    goto('landing');
  }
  function logout() { sess.del('myName'); sess.del('seat'); sess.del('view'); setName(''); setSeat(null); setView('landing'); }
  function joinedSeat(s: Seat) { sess.set('seat', s); setSeat(s); }
  function leftSeat() { sess.del('seat'); setSeat(null); goto('landing'); }
  function goto(v: View) { sess.set('view', v); setView(v); }

  if (!name) return <Login onLogin={login} />;
  if (seat) return <MatchSeat seat={seat} onLeave={leftSeat} />;
  if (view === 'profile') return <ProfilePage myName={name} onBack={() => goto('landing')} />;
  if (view === 'lobby')   return <Lobby myName={name} onJoined={joinedSeat} onBack={() => goto('landing')} />;
  return <Landing myName={name} onPlay={() => goto('lobby')} onProfile={() => goto('profile')} onLogout={logout} />;
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

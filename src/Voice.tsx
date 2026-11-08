// src/Voice.tsx
// Live, in-match voice chat with your opponent. PeerJS WebRTC, zero backend.
//
// ── Security model (replaces audit finding H-6) ────────────────────────────
// The old version derived both peer ids deterministically from the PUBLIC
// matchID and the inbound-call handler answered ANY caller, so anyone who could
// read a match id off the lobby could open a player's microphone. This version
// closes that:
//
//   • On enable, each seat generates a RANDOM, unguessable peer id
//     (crypto.getRandomValues, 24+ chars from [A-Za-z0-9_-]). It is never
//     derived from the matchID.
//   • The id is published only through the game move `announceVoicePeer`, so it
//     reaches G.voice, which playerView exposes ONLY to the two seated players.
//     An observer who knows the match id still never learns either peer id.
//   • The seat reads its opponent's id from G.voice[opponentID]. The lower
//     playerID dials once the opponent id is known; it re-dials if the opponent
//     re-announces (reload).
//   • The inbound `peer.on('call')` handler ANSWERS ONLY IF `call.peer` equals
//     the opponent's announced id; every other caller is closed immediately.
//
// So a call is only ever answered for the one peer id the opponent privately
// announced into shared match state. Everything is torn down on unmount, match
// end or disable. peerjs is lazy-imported so it costs nothing until enabled.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaConnection } from 'peerjs';

// Type-only at module scope; the implementation is pulled in on demand.
type PeerInstance = import('peerjs').default;

const PREF_KEY = 'ocva.voice.prefs';
const PEER_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** Random, unguessable peer id: 32 chars from [A-Za-z0-9_-]. */
function randomPeerId(): string {
  const n = 32;
  const out: string[] = [];
  try {
    const buf = new Uint8Array(n);
    crypto.getRandomValues(buf);
    for (let i = 0; i < n; i++) out.push(PEER_ID_ALPHABET[buf[i] % PEER_ID_ALPHABET.length]);
  } catch {
    for (let i = 0; i < n; i++) out.push(PEER_ID_ALPHABET[Math.floor(Math.random() * PEER_ID_ALPHABET.length)]);
  }
  // Prefixed so it is obviously ours in broker logs; prefix carries no secret.
  return `egv1-${out.join('')}`;
}

type Prefs = { volume: number; muted: boolean };
function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Prefs>;
      return {
        volume: typeof p.volume === 'number' ? Math.min(1, Math.max(0, p.volume)) : 1,
        muted: !!p.muted,
      };
    }
  } catch { /* storage blocked / bad json */ }
  return { volume: 1, muted: false };
}
function savePrefs(p: Prefs): void {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* storage blocked */ }
}

type Status = 'off' | 'mic' | 'connecting' | 'live' | 'no-opponent' | 'error';

export function VoiceChat({
  playerID, opponentID, voicePeers, announceVoicePeer, displayName,
}: {
  playerID: string;
  opponentID: string;
  /** G.voice ?? {} — the per-seat peer map, visible only to the two seats. */
  voicePeers: Record<string, string>;
  /** `moves.announceVoicePeer`, feature-detected; undefined until it lands. */
  announceVoicePeer?: (peerId: string) => void;
  displayName?: string;
}) {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<Status>('off');
  const [error, setError] = useState<string | null>(null);
  const [ptt, setPtt] = useState(false); // push-to-talk currently held

  const initial = loadPrefs();
  const [muted, setMuted] = useState(initial.muted);
  const [volume, setVolume] = useState(initial.volume);

  const peerRef = useRef<PeerInstance | null>(null);
  const myPeerIdRef = useRef<string | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callRef = useRef<MediaConnection | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const dialedPeerRef = useRef<string | null>(null); // opponent id we last dialed/answered
  // Live ref of the peer map so the inbound-call auth check always sees the
  // current G.voice without re-subscribing the peer.
  const voicePeersRef = useRef(voicePeers);
  voicePeersRef.current = voicePeers;

  const opponentPeerId = voicePeers[opponentID] || null;
  const opponentInVoice = !!opponentPeerId;
  // The lower playerID is the sole dialer, so the two sides never glare-call.
  const iDial = playerID < opponentID;

  // Persist prefs.
  useEffect(() => { savePrefs({ muted, volume }); }, [muted, volume]);

  // Apply the effective mic-enabled state: muted OR (push-to-talk and not held).
  const applyMicState = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const live = !muted; // when not muted, mic is open; PTT only gates while muted
    const pttOpen = muted && ptt; // hold-to-talk while muted
    const on = live || pttOpen;
    for (const t of stream.getAudioTracks()) t.enabled = on;
  }, [muted, ptt]);
  useEffect(() => { applyMicState(); }, [applyMicState]);

  // Apply remote volume.
  useEffect(() => {
    const el = audioRef.current;
    if (el) el.volume = volume;
  }, [volume, status]);

  const teardown = useCallback(() => {
    try { callRef.current?.close(); } catch { /* noop */ }
    callRef.current = null;
    try { peerRef.current?.destroy(); } catch { /* noop */ }
    peerRef.current = null;
    myPeerIdRef.current = null;
    dialedPeerRef.current = null;
    if (localStreamRef.current) {
      for (const t of localStreamRef.current.getTracks()) { try { t.stop(); } catch { /* noop */ } }
      localStreamRef.current = null;
    }
    if (audioRef.current) audioRef.current.srcObject = null;
  }, []);

  // Bring up mic + peer once enabled, publish our random id, and (if we are the
  // dialer) dial the opponent whenever their announced id is known/changes.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const attachRemote = (remote: MediaStream) => {
      const el = audioRef.current;
      if (!el) return;
      el.srcObject = remote;
      el.volume = volume;
      // iOS/Safari: playback must follow a user gesture. Enabling voice IS a
      // tap, so this usually succeeds; if autoplay is blocked, retry on the
      // next click anywhere.
      el.play().catch(() => {
        const kick = () => { el.play().catch(() => {}); document.removeEventListener('click', kick); };
        document.addEventListener('click', kick, { once: true });
      });
      setStatus('live');
    };

    (async () => {
      try {
        setError(null);
        setStatus('mic');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (cancelled) { for (const t of stream.getTracks()) t.stop(); return; }
        localStreamRef.current = stream;
        applyMicState();

        const { default: Peer } = await import('peerjs');
        if (cancelled) { for (const t of stream.getTracks()) t.stop(); return; }

        const myId = randomPeerId();
        myPeerIdRef.current = myId;
        const peer = new Peer(myId, {
          debug: 1,
          config: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:global.stun.twilio.com:3478' },
              { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
              { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
              { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
            ],
          },
        });
        peerRef.current = peer;

        peer.on('open', () => {
          if (cancelled) return;
          // Publish our random id into shared match state (visible only to the
          // two seats). Opponent reads it from G.voice[myID] and dials us.
          try { announceVoicePeer?.(myId); } catch { /* move not ready */ }
          setStatus(opponentPeerId ? 'connecting' : 'no-opponent');
        });

        // Inbound: answer ONLY the opponent's announced id. Everyone else is
        // closed immediately — this is the H-6 fix.
        peer.on('call', (call) => {
          const allowed = myPeerIdRef.current && call.peer === (voicePeersRef.current[opponentID] || '');
          if (!allowed) { try { call.close(); } catch { /* noop */ } return; }
          callRef.current = call;
          dialedPeerRef.current = call.peer;
          call.answer(localStreamRef.current!);
          call.on('stream', attachRemote);
          call.on('close', () => setStatus((s) => (s === 'live' ? 'connecting' : s)));
          call.on('error', () => {/* leave status; a redial may recover */});
        });

        peer.on('error', (e: unknown) => {
          const msg = String((e as { type?: string; message?: string })?.type
            || (e as { message?: string })?.message || e);
          if (msg.includes('peer-unavailable')) return; // opponent not up yet
          setError(msg);
          setStatus('error');
        });
      } catch (e: unknown) {
        if (cancelled) return;
        setError(String((e as { message?: string })?.message || e));
        setStatus('error');
      }
    })();

    return () => { cancelled = true; teardown(); setStatus('off'); };
    // Re-running on opponentPeerId change would tear down the mic; dialing is
    // handled by the dedicated effect below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Dialer effect: once we know the opponent's id (and we are the dialer), call
  // them. Re-dial when their announced id changes (they reloaded).
  useEffect(() => {
    if (!enabled || !iDial) return;
    const peer = peerRef.current;
    const stream = localStreamRef.current;
    if (!peer || !stream || !opponentPeerId) {
      if (enabled && !opponentPeerId) setStatus((s) => (s === 'live' ? s : 'no-opponent'));
      return;
    }
    if (dialedPeerRef.current === opponentPeerId && callRef.current) return; // already connected to this id
    // New/changed opponent id: drop any stale call and dial fresh.
    try { callRef.current?.close(); } catch { /* noop */ }
    callRef.current = null;
    setStatus('connecting');
    const call = peer.call(opponentPeerId, stream);
    if (!call) return;
    dialedPeerRef.current = opponentPeerId;
    callRef.current = call;
    call.on('stream', (remote: MediaStream) => {
      const el = audioRef.current;
      if (!el) return;
      el.srcObject = remote;
      el.volume = volume;
      el.play().catch(() => {
        const kick = () => { el.play().catch(() => {}); document.removeEventListener('click', kick); };
        document.addEventListener('click', kick, { once: true });
      });
      setStatus('live');
    });
    call.on('close', () => { callRef.current = null; setStatus((s) => (s === 'live' ? 'connecting' : s)); });
    call.on('error', () => { /* a later re-announce will retrigger this effect */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, iDial, opponentPeerId]);

  // Tear down on unmount.
  useEffect(() => () => teardown(), [teardown]);

  // Push-to-talk: hold V to open the mic while muted.
  useEffect(() => {
    if (!enabled) return;
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'v' && !e.repeat) setPtt(true);
    };
    const up = (e: KeyboardEvent) => { if (e.key.toLowerCase() === 'v') setPtt(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [enabled]);

  const disable = () => { setEnabled(false); setStatus('off'); };

  const statusLabel =
    status === 'mic'        ? 'asking for mic…'
    : status === 'connecting' ? 'connecting…'
    : status === 'no-opponent' ? 'opponent not in voice'
    : status === 'live'     ? (muted && !ptt ? 'muted' : 'live')
    : status === 'error'    ? 'error'
    : 'off';
  const dotColor =
    status === 'live' && (!muted || ptt) ? '#22c55e'
    : status === 'live'                  ? '#f0b90b'
    : status === 'error'                 ? '#f87171'
    : status === 'no-opponent'           ? '#8a8fa6'
    : '#aaa';

  // Collapsed control shown in the match header on both form factors.
  if (!enabled) {
    return (
      <button
        onClick={() => { setEnabled(true); }}
        title="Start voice chat with your opponent"
        aria-label="Start voice chat with your opponent"
        style={{
          position: 'fixed', right: 16, bottom: 16, zIndex: 60,
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '9px 14px', borderRadius: 999,
          background: 'linear-gradient(135deg,#3a1f5a,#1b1230)',
          border: `1px solid ${opponentInVoice ? '#22c55e' : '#6c4bd8'}`,
          color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
          boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
        }}
      >
        <span aria-hidden>🎙️</span> Voice
        {opponentInVoice && (
          <span title="Opponent is in voice" style={{
            width: 8, height: 8, borderRadius: '50%', background: '#22c55e',
            boxShadow: '0 0 8px #22c55e',
          }} />
        )}
      </button>
    );
  }

  const micOpen = status === 'live' && (!muted || ptt);

  return (
    <div role="group" aria-label="Voice chat" style={{
      position: 'fixed', right: 16, bottom: 16, zIndex: 60, width: 248,
      background: '#0b0d12', border: '1px solid #6c4bd8', borderRadius: 10,
      boxShadow: '0 6px 22px rgba(0,0,0,0.55)', color: '#fff',
      fontFamily: 'Inter, sans-serif', display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px',
        background: '#15192a', borderBottom: '1px solid #2a2f48', fontSize: 12,
      }}>
        <span aria-hidden style={{ fontSize: 16 }}>🎙️</span>
        <span style={{ flex: 1, fontWeight: 700 }}>Voice</span>
        <button onClick={disable} aria-label="Turn off voice" title="Turn off voice" style={{
          background: 'transparent', color: '#aaa', border: 'none',
          fontSize: 18, cursor: 'pointer', padding: 0, lineHeight: 1,
        }}>×</button>
      </div>
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>
          <span aria-hidden style={{ width: 9, height: 9, borderRadius: '50%', background: dotColor, boxShadow: `0 0 8px ${dotColor}` }} />
          <span style={{ color: dotColor }}>{statusLabel.toUpperCase()}</span>
        </div>
        <div style={{ fontSize: 11, opacity: 0.65 }}>
          You are <b style={{ color: '#fff', opacity: 1 }}>{displayName || 'Player'}</b> · seat {playerID}
        </div>
        <div style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6, opacity: 0.85 }}>
          <span aria-hidden style={{
            width: 8, height: 8, borderRadius: '50%',
            background: opponentInVoice ? '#22c55e' : '#555',
            boxShadow: opponentInVoice ? '0 0 8px #22c55e' : 'none',
          }} />
          {opponentInVoice ? 'Opponent in voice' : 'Opponent not in voice'}
        </div>

        <button
          onClick={() => setMuted((m) => !m)}
          disabled={status !== 'live'}
          aria-pressed={muted}
          style={{
            width: '100%', background: micOpen ? '#1f5a3a' : '#3a1f5a',
            color: '#fff', border: '1px solid #555', borderRadius: 6,
            padding: '8px 10px', fontSize: 12, fontWeight: 700,
            cursor: status === 'live' ? 'pointer' : 'not-allowed',
            opacity: status === 'live' ? 1 : 0.5,
          }}
        >{muted ? 'Unmute' : 'Mute'}</button>

        <div style={{ fontSize: 10.5, opacity: 0.6, lineHeight: 1.4 }}>
          Hold <b style={{ color: '#fff', opacity: 1 }}>V</b> to talk while muted (push-to-talk).
        </div>

        <label style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ opacity: 0.7 }}>Opponent volume</span>
          <input
            type="range" min={0} max={1} step={0.05} value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            aria-label="Opponent volume"
            style={{ width: '100%' }}
          />
        </label>

        {error && (
          <div role="alert" style={{ padding: 6, color: '#f88', fontSize: 11, background: '#2a1414', borderRadius: 4, wordBreak: 'break-word' }}>
            {error}
          </div>
        )}
      </div>
      {/* Remote audio. Muted attribute stays false; volume is controlled above. */}
      <audio ref={audioRef} autoPlay playsInline />
    </div>
  );
}

// In-match proximity voice for Memetic Masters.
//
// We tried meet.jit.si first, but as of 2024 it requires moderator auth for
// new rooms via the External API and silently gets stuck on a "waiting for
// the moderator" screen for anonymous embeds. So this is a tiny WebRTC
// alternative built on PeerJS:
//
//   - Both seats derive a deterministic peer ID from matchID + playerID.
//   - Each side opens its mic and registers with the public PeerJS broker.
//   - The seat with the lower playerID dials the other; the higher seat
//     answers with its own stream.
//   - The remote stream plays through a hidden <audio> element.
//
// Zero backend, zero auth. Works as long as the public broker
// (`0.peerjs.com`, the default) is reachable.

import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window { Peer?: any }
}

const PEERJS_SRC = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
let scriptPromise: Promise<void> | null = null;

function loadPeerScript(): Promise<void> {
  if (window.Peer) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PEERJS_SRC; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { scriptPromise = null; reject(new Error('PeerJS script failed to load')); };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

// Deterministic per-seat peer ID. Prefixed + sanitised so it survives the
// PeerJS broker's id validator (alphanumerics + dash/underscore only).
function peerIdFor(matchID: string, playerID: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9]/g, '');
  return `mmtcgv1-${clean(matchID)}-${clean(playerID)}`;
}

export function VoiceChat({
  matchID, playerID, displayName,
}: { matchID: string; playerID: string; displayName: string }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'mic' | 'connecting' | 'live' | 'error'>('idle');
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const peerRef = useRef<any>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const dialerTimerRef = useRef<number | null>(null);

  // Tear down on unmount or close.
  const teardown = () => {
    if (dialerTimerRef.current) { clearInterval(dialerTimerRef.current); dialerTimerRef.current = null; }
    try { callRef.current?.close(); } catch {}
    callRef.current = null;
    try { peerRef.current?.destroy(); } catch {}
    peerRef.current = null;
    if (localStreamRef.current) {
      for (const t of localStreamRef.current.getTracks()) { try { t.stop(); } catch {} }
      localStreamRef.current = null;
    }
    if (audioRef.current) audioRef.current.srcObject = null;
    setStatus('idle');
    setMuted(false);
  };
  useEffect(() => () => teardown(), []);

  // Bring up mic + peer once the panel is opened.
  useEffect(() => {
    if (!open) return;
    if (peerRef.current) return;
    let cancelled = false;

    (async () => {
      try {
        setError(null);
        setStatus('mic');
        // 1. Acquire mic.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (cancelled) { for (const t of stream.getTracks()) t.stop(); return; }
        localStreamRef.current = stream;

        // 2. Load + construct Peer.
        await loadPeerScript();
        if (cancelled || !window.Peer) return;
        const myId = peerIdFor(matchID, playerID);
        const otherId = peerIdFor(matchID, playerID === '0' ? '1' : '0');
        const peer = new window.Peer(myId, { debug: 1 });
        peerRef.current = peer;
        setStatus('connecting');

        const attachRemote = (remote: MediaStream) => {
          if (audioRef.current) {
            audioRef.current.srcObject = remote;
            audioRef.current.play().catch(() => {});
          }
          setStatus('live');
        };

        // 3a. Incoming-call path (the answerer side).
        peer.on('call', (call: any) => {
          callRef.current = call;
          call.answer(localStreamRef.current!);
          call.on('stream', attachRemote);
          call.on('close', () => setStatus(s => (s === 'live' ? 'connecting' : s)));
        });

        // 3b. Outgoing-call path. The seat with the lower playerID dials.
        // We retry until the other side has also registered with the broker.
        const dial = () => {
          if (callRef.current || !peerRef.current) return;
          if (playerID !== '0') return; // only seat 0 dials seat 1
          const call = peer.call(otherId, localStreamRef.current!);
          if (!call) return;
          call.on('stream', (remote: MediaStream) => {
            callRef.current = call;
            if (dialerTimerRef.current) { clearInterval(dialerTimerRef.current); dialerTimerRef.current = null; }
            attachRemote(remote);
          });
          call.on('error', () => { /* silently retry */ });
          call.on('close', () => { callRef.current = null; });
        };

        peer.on('open', () => {
          if (playerID === '0') {
            dial();
            dialerTimerRef.current = window.setInterval(dial, 4000);
          }
        });
        peer.on('error', (e: any) => {
          // Common case: "peer-unavailable" while the other side hasn't joined yet.
          // Don't surface that one; surface real failures (network, broker down, etc.).
          const msg = String(e?.type || e?.message || e);
          if (msg.includes('peer-unavailable')) return;
          setError(msg); setStatus('error');
        });
      } catch (e: any) {
        const msg = String(e?.message || e);
        setError(msg);
        setStatus('error');
      }
    })();

    return () => { cancelled = true; };
  }, [open, matchID, playerID]);

  const toggleMute = () => {
    const stream = localStreamRef.current; if (!stream) return;
    const next = !muted;
    for (const t of stream.getAudioTracks()) t.enabled = !next;
    setMuted(next);
  };

  const close = () => { teardown(); setOpen(false); };

  // Collapsed bubble (bottom-right, mirroring the chat bubble on bottom-left).
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Open voice chat with your opponent"
        style={{
          position: 'fixed', right: 16, bottom: 16, zIndex: 60,
          width: 52, height: 52, borderRadius: '50%',
          background: 'linear-gradient(135deg,#3a1f5a,#1b1230)',
          border: '1px solid #6c4bd8', color: '#fff',
          fontSize: 22, cursor: 'pointer',
          boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
        }}
      >🎙️</button>
    );
  }

  const statusLabel =
    status === 'mic'        ? 'asking for mic…'
    : status === 'connecting' ? 'waiting for opponent…'
    : status === 'live'     ? (muted ? 'muted' : 'LIVE')
    : status === 'error'    ? 'error'
    : 'idle';
  const statusColor =
    status === 'live' && !muted ? '#22c55e'
    : status === 'live' && muted ? '#f0b90b'
    : status === 'error'         ? '#f87171'
    : '#aaa';

  return (
    <div style={{
      position: 'fixed', right: 16, bottom: 16, zIndex: 60,
      width: 240,
      background: '#0b0d12', border: '1px solid #6c4bd8', borderRadius: 10,
      boxShadow: '0 6px 22px rgba(0,0,0,0.55)',
      color: '#fff', fontFamily: 'Inter, sans-serif',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '8px 10px', background: '#15192a',
        borderBottom: '1px solid #2a2f48', fontSize: 12,
      }}>
        <span style={{ fontSize: 16 }}>🎙️</span>
        <span style={{ flex: 1, fontWeight: 700 }}>Voice</span>
        <button onClick={close} style={{
          background: 'transparent', color: '#aaa',
          border: 'none', fontSize: 18, cursor: 'pointer', padding: 0, lineHeight: 1,
        }} title="Close voice">×</button>
      </div>
      <div style={{ padding: '10px 12px' }}>
        <div style={{ fontSize: 11, color: statusColor, marginBottom: 8, fontWeight: 700, letterSpacing: 1 }}>
          ● {statusLabel.toUpperCase()}
        </div>
        <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 10 }}>
          You are <b style={{ color: '#fff', opacity: 1 }}>{displayName || 'Player'}</b> · seat {playerID}
        </div>
        <button
          onClick={toggleMute}
          disabled={status !== 'live'}
          style={{
            width: '100%',
            background: muted ? '#3a1f5a' : '#1f5a3a',
            color: '#fff', border: '1px solid #555',
            borderRadius: 6, padding: '8px 10px',
            fontSize: 12, fontWeight: 700,
            cursor: status === 'live' ? 'pointer' : 'not-allowed',
            opacity: status === 'live' ? 1 : 0.5,
          }}
        >{muted ? 'Unmute' : 'Mute'}</button>
        {error && (
          <div style={{ marginTop: 8, padding: 6, color: '#f88', fontSize: 11, background: '#2a1414', borderRadius: 4 }}>
            {error}
          </div>
        )}
      </div>
      <audio ref={audioRef} autoPlay playsInline />
    </div>
  );
}

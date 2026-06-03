// In-match proximity voice (WorkAdventure-style Jitsi embed).
// Both seats of a match auto-join the same room `mmtcg-<matchID>` so they can
// trash-talk while playing. Defaults to muted + camera off; one click un-mutes.

import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window { JitsiMeetExternalAPI?: any }
}

const JITSI_DOMAIN = 'meet.jit.si';
const SCRIPT_SRC = `https://${JITSI_DOMAIN}/external_api.js`;
let scriptPromise: Promise<void> | null = null;

function loadJitsiScript(): Promise<void> {
  if (window.JitsiMeetExternalAPI) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { scriptPromise = null; reject(new Error('Jitsi script failed')); };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export function JitsiVoice({
  matchID, displayName,
}: { matchID: string; displayName: string }) {
  const [open, setOpen] = useState(false);
  const [joined, setJoined] = useState(false);
  const [muted, setMuted] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<any>(null);

  // Tear down on unmount.
  useEffect(() => () => {
    try { apiRef.current?.dispose(); } catch {}
    apiRef.current = null;
  }, []);

  // Create the meeting when the user opens the panel for the first time.
  useEffect(() => {
    if (!open || apiRef.current || !containerRef.current) return;
    let cancelled = false;
    loadJitsiScript().then(() => {
      if (cancelled || !containerRef.current || !window.JitsiMeetExternalAPI) return;
      const api = new window.JitsiMeetExternalAPI(JITSI_DOMAIN, {
        roomName: `mmtcg-${matchID}`,
        parentNode: containerRef.current,
        width: '100%',
        height: '100%',
        userInfo: { displayName: displayName || 'Memetic Master' },
        configOverwrite: {
          startWithAudioMuted: true,
          startWithVideoMuted: true,
          prejoinPageEnabled: false,
          disableDeepLinking: true,
          toolbarButtons: ['microphone', 'hangup', 'settings'],
        },
        interfaceConfigOverwrite: {
          DEFAULT_BACKGROUND: '#0b0d12',
          DISABLE_VIDEO_BACKGROUND: true,
          SHOW_JITSI_WATERMARK: false,
          MOBILE_APP_PROMO: false,
        },
      });
      api.addListener('videoConferenceJoined', () => setJoined(true));
      api.addListener('audioMuteStatusChanged', (e: { muted: boolean }) => setMuted(e.muted));
      apiRef.current = api;
    }).catch(err => setError(err.message));
    return () => { cancelled = true; };
  }, [open, matchID, displayName]);

  const toggleMute = () => {
    try { apiRef.current?.executeCommand('toggleAudio'); } catch {}
  };

  const close = () => {
    try { apiRef.current?.dispose(); } catch {}
    apiRef.current = null;
    setJoined(false);
    setMuted(true);
    setOpen(false);
  };

  // Collapsed bubble (mirror of ChatPanel position, but bottom-RIGHT).
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

  return (
    <div style={{
      position: 'fixed', right: 16, bottom: 16, zIndex: 60,
      width: 280, height: 200,
      background: '#0b0d12', border: '1px solid #6c4bd8', borderRadius: 10,
      boxShadow: '0 6px 22px rgba(0,0,0,0.55)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 8px', background: '#15192a',
        borderBottom: '1px solid #2a2f48', color: '#ddd', fontSize: 12,
      }}>
        <span style={{ flex: 1, fontWeight: 600 }}>
          🎙️ Voice {joined ? (muted ? '· muted' : '· LIVE') : '· connecting…'}
        </span>
        <button onClick={toggleMute} disabled={!joined} style={{
          background: muted ? '#3a1f5a' : '#1f5a3a', color: '#fff',
          border: '1px solid #555', borderRadius: 4, padding: '2px 8px',
          fontSize: 11, cursor: joined ? 'pointer' : 'not-allowed',
        }}>{muted ? 'Unmute' : 'Mute'}</button>
        <button onClick={close} style={{
          background: 'transparent', color: '#aaa',
          border: 'none', fontSize: 16, cursor: 'pointer', padding: 0, lineHeight: 1,
        }} title="Close voice">×</button>
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, background: '#000' }} />
      {error && (
        <div style={{ padding: 6, color: '#f88', fontSize: 11 }}>
          Voice unavailable: {error}
        </div>
      )}
    </div>
  );
}

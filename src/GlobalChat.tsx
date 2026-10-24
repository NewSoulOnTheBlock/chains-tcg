// The hub's global chat, announcement feed and notification source.
//
// ─── WHERE THE DATA COMES FROM ──────────────────────────────────────────────
// `/api/chat` is a Vercel function on THIS origin (api/chat.ts), not the game
// gateway, so it is called with plain `fetch` rather than `request()` (which
// prefixes API_BASE). The bearer token is the player's ordinary game session;
// the function resolves it to a profile itself, so nothing here claims a name.
//
// ─── POLLING, NOT SOCKETS ───────────────────────────────────────────────────
// A delta poll (`?after=<last id>`) every few seconds is cheap, survives the
// function going cold, and needs no extra infrastructure. It slows right down
// while the tab is hidden.
//
// ─── NOTIFICATIONS ──────────────────────────────────────────────────────────
// The bell reads announcements plus chat lines that @mention the player. "Read"
// is a high-water message id in localStorage — per device, which is fine for a
// "what did I miss" dot.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAccessToken, refreshSession } from './api';
import { font as F } from './theme';

// Mirrors App.tsx's MENU palette so the panel sits in the hub without importing it.
const M = {
  panel: 'rgba(26,21,53,0.90)', bgEl: '#0E1022', gold: '#E6C45C', goldHi: '#FFD875', violet: '#8B5CF6',
  success: '#39E6B0', text: '#F6F3EB', text2: '#AAA5BA', border: 'rgba(230,196,92,0.22)', danger: '#FF6B7A',
};
const SERIF = "'Cinzel', 'EB Garamond', Georgia, serif";
const MAX_LEN = 280;
const SEEN_KEY = 'egregore.chat.seen';
const POLL_VISIBLE_MS = 4_000;
const POLL_HIDDEN_MS = 30_000;
const KEEP = 200;

export interface ChatMessage {
  id: string;
  kind: 'chat' | 'announce';
  author: string;
  avatarUrl: string | null;
  body: string;
  createdAt: string;
}

async function chatFetch(init?: RequestInit, query = ''): Promise<Response> {
  const go = () => {
    const token = getAccessToken();
    return fetch(`/api/chat${query}`, {
      ...init,
      headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  };
  let res = await go();
  if (res.status === 401 && getAccessToken() && (await refreshSession())) res = await go();
  return res;
}

const ERRORS: Record<string, string> = {
  slow_down: 'Slow down — one message every few seconds.',
  too_long: `Keep it under ${MAX_LEN} characters.`,
  unauthorized: 'Sign in again to chat.',
  forbidden: 'Only admins can post announcements.',
};

export interface GlobalChatState {
  messages: ChatMessage[];
  admin: boolean;
  online: boolean;
  send: (body: string, kind: 'chat' | 'announce') => Promise<string | null>;
  /** Unread announcements + @mentions, newest first. */
  notifications: ChatMessage[];
  unread: number;
  markSeen: () => void;
  /** The announcement that just arrived live, for a toast. Cleared after a few seconds. */
  fresh: ChatMessage | null;
}

const mentions = (m: ChatMessage, me: string) =>
  m.kind === 'chat' && !!me && m.author !== me && new RegExp(`@${me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(m.body);

export function useGlobalChat(myName: string): GlobalChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [admin, setAdmin] = useState(false);
  const [online, setOnline] = useState(true);
  const [seen, setSeen] = useState<number>(() => { try { return Number(localStorage.getItem(SEEN_KEY) ?? 0) || 0; } catch { return 0; } });
  const [fresh, setFresh] = useState<ChatMessage | null>(null);
  const lastId = useRef<string | null>(null);
  const primed = useRef(false);

  const merge = useCallback((incoming: ChatMessage[]) => {
    if (!incoming.length) return;
    lastId.current = incoming[incoming.length - 1].id;
    // A toast only for announcements that land while the player is here, not
    // the backlog fetched on first load.
    if (primed.current) {
      const ann = [...incoming].reverse().find((m) => m.kind === 'announce');
      if (ann) setFresh(ann);
    }
    setMessages((prev) => {
      const have = new Set(prev.map((m) => m.id));
      return [...prev, ...incoming.filter((m) => !have.has(m.id))].slice(-KEEP);
    });
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await chatFetch(undefined, lastId.current ? `?after=${lastId.current}` : '');
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { messages: ChatMessage[]; admin: boolean };
        if (!alive) return;
        merge(data.messages);
        setAdmin(data.admin);
        setOnline(true);
        primed.current = true;
      } catch {
        if (alive) setOnline(false);
      }
      if (alive) timer = setTimeout(tick, document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
    };
    void tick();
    // Coming back to the tab should not wait out a 30s hidden interval.
    const onVis = () => { if (!document.hidden) { clearTimeout(timer); void tick(); } };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [merge]);

  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => setFresh(null), 7_000);
    return () => clearTimeout(t);
  }, [fresh]);

  const send = useCallback(async (body: string, kind: 'chat' | 'announce') => {
    try {
      const res = await chatFetch({ method: 'POST', body: JSON.stringify({ body, kind }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return ERRORS[data.error] ?? 'Message not sent.';
      merge([data.message as ChatMessage]);
      return null;
    } catch {
      return 'Chat is unreachable right now.';
    }
  }, [merge]);

  const notifications = useMemo(
    () => messages.filter((m) => m.kind === 'announce' || mentions(m, myName)).reverse(),
    [messages, myName],
  );
  const unread = notifications.filter((m) => Number(m.id) > seen).length;
  const markSeen = useCallback(() => {
    const top = messages.length ? Number(messages[messages.length - 1].id) : 0;
    setSeen(top);
    try { localStorage.setItem(SEEN_KEY, String(top)); } catch {}
  }, [messages]);

  return { messages, admin, online, send, notifications, unread, markSeen, fresh };
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Highlight @mentions of the player inside a message body. */
function renderBody(body: string, me: string): React.ReactNode {
  if (!me) return body;
  const parts = body.split(new RegExp(`(@${me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b)`, 'gi'));
  return parts.map((p, i) => i % 2
    ? <span key={i} style={{ color: M.goldHi, fontWeight: 700, background: 'rgba(230,196,92,0.14)', borderRadius: 4, padding: '0 3px' }}>{p}</span>
    : p);
}

const megaphone = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m3 11 18-5v12L3 14v-3z" /><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
  </svg>
);

export function GlobalChat({ chat, myName, mobile }: { chat: GlobalChatState; myName: string; mobile: boolean }) {
  const [tab, setTab] = useState<'all' | 'news'>('all');
  const [draft, setDraft] = useState('');
  const [announce, setAnnounce] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(!mobile);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const shown = tab === 'all' ? chat.messages : chat.messages.filter((m) => m.kind === 'announce');
  const pinned = useMemo(() => [...chat.messages].reverse().find((m) => m.kind === 'announce') ?? null, [chat.messages]);

  // Follow new lines only while the reader is already at the bottom; someone
  // scrolled up reading history should not be yanked down.
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, tab, open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    const err = await chat.send(body, announce ? 'announce' : 'chat');
    setSending(false);
    setError(err);
    if (!err) { setDraft(''); setAnnounce(false); stick.current = true; }
  };

  const tabBtn = (id: 'all' | 'news', label: string) => (
    <button type="button" onClick={() => setTab(id)} aria-pressed={tab === id}
      style={{ border: 'none', background: 'none', cursor: 'pointer', padding: '2px 0', fontSize: 11, fontWeight: 800, letterSpacing: '0.14em',
        color: tab === id ? M.gold : M.text2, borderBottom: `2px solid ${tab === id ? M.gold : 'transparent'}` }}>{label}</button>
  );

  return (
    <section aria-label="Global chat" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: mobile ? (open ? 380 : 'auto') : '100%',
      borderRadius: 16, background: M.panel, border: `1px solid ${M.border}`, backdropFilter: 'blur(12px)', boxShadow: '0 20px 50px rgba(0,0,0,0.5)', overflow: 'hidden' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px 8px', borderBottom: `1px solid ${M.border}` }}>
        <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: M.text, letterSpacing: '0.04em', flex: 1 }}>
          Global Chat
          <span title={chat.online ? 'Connected' : 'Reconnecting…'} style={{ display: 'inline-block', marginLeft: 8, width: 7, height: 7, borderRadius: '50%', verticalAlign: 'middle',
            background: chat.online ? M.success : M.danger, boxShadow: `0 0 6px ${chat.online ? M.success : M.danger}` }} />
        </h2>
        {(!mobile || open) && <>{tabBtn('all', 'ALL')}{tabBtn('news', 'ANNOUNCEMENTS')}</>}
        {mobile && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
            style={{ border: 'none', background: 'none', color: M.text2, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>{open ? 'HIDE' : 'SHOW'}</button>
        )}
      </header>

      {open && pinned && tab === 'all' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 14px', background: 'linear-gradient(90deg, rgba(230,196,92,0.16), rgba(230,196,92,0.04))',
          borderBottom: `1px solid ${M.border}`, color: M.goldHi, fontSize: 12.5, lineHeight: 1.4 }}>
          <span style={{ flex: 'none', marginTop: 1 }}>{megaphone}</span>
          <span style={{ color: M.text, overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{pinned.body}</span>
        </div>
      )}

      {open && (
        <div ref={listRef} role="log" aria-live="polite"
          onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.length === 0 && (
            <div style={{ margin: 'auto', textAlign: 'center', color: M.text2, fontSize: 13 }}>
              {tab === 'all' ? 'No messages yet. Say something to the arena.' : 'No announcements yet.'}
            </div>
          )}
          {shown.map((m) => m.kind === 'announce' ? (
            <div key={m.id} style={{ padding: '8px 10px', borderRadius: 10, border: `1px solid ${M.gold}55`, background: 'rgba(230,196,92,0.10)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: M.gold, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.14em' }}>
                {megaphone} ANNOUNCEMENT <span style={{ marginLeft: 'auto', color: M.text2, fontWeight: 600, letterSpacing: 0 }}>{timeAgo(m.createdAt)}</span>
              </div>
              <div style={{ marginTop: 4, fontSize: 13, color: M.text, lineHeight: 1.45, overflowWrap: 'anywhere' }}>{m.body}</div>
            </div>
          ) : (
            <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <div style={{ width: 24, height: 24, flex: 'none', borderRadius: '50%', overflow: 'hidden', background: M.bgEl, display: 'grid', placeItems: 'center', border: `1px solid ${M.border}` }}>
                {m.avatarUrl ? <img src={m.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <span style={{ fontSize: 11, fontWeight: 800, color: M.violet }}>{m.author.slice(0, 1).toUpperCase()}</span>}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: m.author === myName ? M.goldHi : '#C4B5FD', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.author}</span>
                  <span style={{ fontSize: 10.5, color: M.text2 }}>{timeAgo(m.createdAt)}</span>
                </div>
                <div style={{ fontSize: 13, color: M.text, lineHeight: 1.4, overflowWrap: 'anywhere' }}>{renderBody(m.body, myName)}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <form onSubmit={submit} style={{ padding: 10, borderTop: `1px solid ${M.border}` }}>
          {error && <div role="alert" style={{ fontSize: 11.5, color: M.danger, margin: '0 2px 6px' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 6 }}>
            {chat.admin && (
              <button type="button" onClick={() => setAnnounce((a) => !a)} aria-pressed={announce} title="Post as announcement"
                style={{ flex: 'none', width: 36, borderRadius: 10, cursor: 'pointer', display: 'grid', placeItems: 'center',
                  border: `1px solid ${announce ? M.gold : M.border}`, background: announce ? 'rgba(230,196,92,0.2)' : 'rgba(20,22,44,0.7)', color: announce ? M.goldHi : M.text2 }}>
                {megaphone}
              </button>
            )}
            <input value={draft} onChange={(e) => { setDraft(e.target.value.slice(0, MAX_LEN)); setError(null); }}
              placeholder={announce ? 'Announce to every player…' : 'Message the arena…'} aria-label="Chat message" maxLength={MAX_LEN}
              style={{ flex: 1, minWidth: 0, height: 36, padding: '0 12px', borderRadius: 10, fontFamily: F.body, fontSize: 13, color: M.text, outline: 'none',
                background: 'rgba(8,8,23,0.7)', border: `1px solid ${announce ? M.gold : M.border}` }} />
            <button type="submit" disabled={!draft.trim() || sending}
              style={{ flex: 'none', height: 36, padding: '0 14px', borderRadius: 10, border: 'none', cursor: draft.trim() && !sending ? 'pointer' : 'default',
                fontWeight: 800, fontSize: 12, letterSpacing: '0.08em', color: '#1A1408', opacity: draft.trim() && !sending ? 1 : 0.5,
                background: `linear-gradient(180deg, ${M.goldHi}, ${M.gold})` }}>SEND</button>
          </div>
          {draft.length > MAX_LEN - 40 && <div style={{ textAlign: 'right', fontSize: 10.5, color: M.text2, marginTop: 4 }}>{draft.length}/{MAX_LEN}</div>}
        </form>
      )}
    </section>
  );
}

/** A transient banner for an announcement that arrives while the player is on the hub. */
export function AnnouncementToast({ msg }: { msg: ChatMessage | null }) {
  if (!msg) return null;
  return (
    <div role="status" style={{ position: 'fixed', top: 78, left: '50%', transform: 'translateX(-50%)', zIndex: 20, width: 'min(520px, calc(100vw - 32px))',
      display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 16px', borderRadius: 14, background: 'rgba(26,21,53,0.96)',
      border: `1px solid ${M.gold}`, boxShadow: `0 12px 40px rgba(0,0,0,0.6), 0 0 24px ${M.gold}33`, color: M.text }}>
      <span style={{ color: M.goldHi, marginTop: 2 }}>{megaphone}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.16em', color: M.gold }}>ANNOUNCEMENT</div>
        <div style={{ fontSize: 13.5, lineHeight: 1.45, marginTop: 2, overflowWrap: 'anywhere' }}>{msg.body}</div>
      </div>
    </div>
  );
}

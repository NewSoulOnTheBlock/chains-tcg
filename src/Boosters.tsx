// src/Boosters.tsx
// "Boosters" page — buy + open + collection view for the Genesis Set.
//
// This is the Phase-5 UI scaffolding from plan.md. The backend is PREVIEW
// mode: no on-chain minting yet. Buy/open buttons hit /api/boosters/* which
// returns mock data and increments an in-memory supply counter.
//
// When Phase 3/4 lands (Anchor program + treasury service) only the buy /
// open handlers in this file need to change — the layout, state shape, and
// inventory polling stay the same.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CARDS, COLOR_META, type Color } from './cards';
import { getProfileApi } from './profiles';
import {
  getBoosterSupply, getBoosterInventory, buyBoosterIntent, openBoosterPack,
  type BoosterSupply, type BoosterInventory,
} from './boosters-api';

type Currency = 'sol' | 'master';

export function BoostersPage({ myName, onBack }: { myName: string; onBack: () => void }) {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [supply, setSupply] = useState<BoosterSupply | null>(null);
  const [inventory, setInventory] = useState<BoosterInventory | null>(null);
  const [currency, setCurrency] = useState<Currency>('sol');
  const [busy, setBusy] = useState<null | 'buy' | string /* opening packId */>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ packId: string; cardIds: string[] } | null>(null);

  // Load wallet address from the player's profile. Refetches when window
  // regains focus in case the user just linked a wallet in another tab.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const p = await getProfileApi(myName);
        if (cancelled) return;
        const addr = p?.walletAddress ?? null;
        // Only Solana addresses are eligible — EVM addresses (0x…) get ignored.
        setWalletAddress(addr && !addr.startsWith('0x') ? addr : null);
      } catch { /* leave null */ }
    }
    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
  }, [myName]);

  // Supply ticks every 10s. Inventory refetched whenever wallet changes or
  // after a buy/open.
  const refreshSupply = useCallback(async () => {
    try { setSupply(await getBoosterSupply()); } catch (e: any) { setErr(String(e?.message ?? e)); }
  }, []);
  const refreshInventory = useCallback(async () => {
    if (!walletAddress) { setInventory(null); return; }
    try { setInventory(await getBoosterInventory(walletAddress)); }
    catch (e: any) { setErr(String(e?.message ?? e)); }
  }, [walletAddress]);

  useEffect(() => { refreshSupply(); const t = setInterval(refreshSupply, 10_000); return () => clearInterval(t); }, [refreshSupply]);
  useEffect(() => { refreshInventory(); }, [refreshInventory]);

  async function onBuy() {
    if (!walletAddress) { setErr('link a Solana wallet to your profile first'); return; }
    setErr(null); setBusy('buy');
    try {
      const r = await buyBoosterIntent(walletAddress, currency);
      if (!r.ok) { setErr(r.error); return; }
      await Promise.all([refreshSupply(), refreshInventory()]);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setBusy(null); }
  }

  async function onOpen(packId: string) {
    if (!walletAddress) return;
    setErr(null); setBusy(packId);
    try {
      const r = await openBoosterPack(walletAddress, packId);
      if (!r.ok) { setErr(r.error); return; }
      setReveal({ packId, cardIds: r.cardIds });
      await refreshInventory();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setBusy(null); }
  }

  const isLive = supply?.mode === 'live';
  const soldOut = supply ? supply.remaining <= 0 : false;

  return (
    <div style={{
      position: 'fixed', inset: 0, overflow: 'auto',
      background: 'radial-gradient(ellipse at top, #1a1240 0%, #060312 60%, #000 100%)',
      color: '#fff', fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      {/* Top bar */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 5,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 18px',
        background: 'rgba(6,3,18,0.85)', backdropFilter: 'blur(8px)',
        borderBottom: '1px solid #2a1e54',
      }}>
        <button onClick={onBack} style={ghostBtn}>← Back</button>
        <div style={{ fontWeight: 800, letterSpacing: 2, fontSize: 14 }}>📦 BOOSTERS — GENESIS SET</div>
        <div style={{ minWidth: 80, textAlign: 'right', fontSize: 11, opacity: 0.7 }}>
          {walletAddress ? short(walletAddress) : 'no wallet linked'}
        </div>
      </div>

      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '18px 16px 80px' }}>
        {!isLive && (
          <PreviewBanner />
        )}

        {/* Hero / Buy panel */}
        <section style={panel}>
          <div style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
            <PackArt />
            <div style={{ flex: '1 1 280px', minWidth: 240 }}>
              <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: 1 }}>
                Genesis Booster Pack
              </div>
              <div style={{ fontSize: 13, opacity: 0.85, marginTop: 4, lineHeight: 1.5 }}>
                10 cards per pack. Guaranteed split:
                <b> 6 Common · 3 Uncommon · 1 Rare</b>
                <span style={{ opacity: 0.75 }}> (Rare slot has a 1-in-8 chance to be Mythic).</span>
              </div>

              {/* Supply bar */}
              <SupplyBar supply={supply} />

              {/* Price toggle */}
              <div style={{ marginTop: 14, fontSize: 11, opacity: 0.7, letterSpacing: 1 }}>PRICE</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <PriceBtn active={currency === 'sol'} onClick={() => setCurrency('sol')}
                  label="SOL" value={supply ? fmt(supply.priceSol, 3) : '—'} />
                <PriceBtn active={currency === 'master'} onClick={() => setCurrency('master')}
                  label="$MASTER" value={supply ? fmtNum(supply.priceMaster) : '—'} />
              </div>

              {/* Buy CTA */}
              <button
                onClick={onBuy}
                disabled={busy !== null || soldOut || !walletAddress}
                style={{
                  marginTop: 16, width: '100%',
                  background: soldOut ? '#3a2030' : '#6c4bd8',
                  color: '#fff', border: 'none', borderRadius: 10,
                  padding: '14px 18px', fontWeight: 900, fontSize: 15, letterSpacing: 1,
                  cursor: (busy !== null || soldOut || !walletAddress) ? 'not-allowed' : 'pointer',
                  opacity: (busy !== null || soldOut || !walletAddress) ? 0.6 : 1,
                  boxShadow: '0 8px 24px rgba(108,75,216,0.35)',
                }}
              >
                {soldOut ? 'SOLD OUT' :
                  !walletAddress ? 'LINK SOLANA WALLET IN PROFILE' :
                  busy === 'buy' ? 'PROCESSING…' :
                  `BUY 1 PACK${isLive ? '' : ' (PREVIEW)'}`}
              </button>

              {err && (
                <div style={{ marginTop: 10, color: '#ff6a8a', fontSize: 12 }}>⚠ {err}</div>
              )}
            </div>
          </div>
        </section>

        {/* Sealed packs */}
        <section style={panel}>
          <SectionTitle>📦 My Sealed Packs ({inventory?.sealed.length ?? 0})</SectionTitle>
          {!walletAddress && <Empty>Link a Solana wallet in your profile to see your packs.</Empty>}
          {walletAddress && (inventory?.sealed.length ?? 0) === 0 && (
            <Empty>No sealed packs yet. Buy one above to get started.</Empty>
          )}
          {(inventory?.sealed ?? []).length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginTop: 12 }}>
              {inventory!.sealed.map(p => (
                <SealedTile
                  key={p.packId}
                  packId={p.packId}
                  mintedAt={p.mintedAt}
                  opening={busy === p.packId}
                  onOpen={() => onOpen(p.packId)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Collection */}
        <section style={panel}>
          <SectionTitle>🃏 My Collection ({inventory?.owned.reduce((s, c) => s + c.qty, 0) ?? 0})</SectionTitle>
          {!walletAddress && <Empty>Link a Solana wallet in your profile to see your collection.</Empty>}
          {walletAddress && (inventory?.owned.length ?? 0) === 0 && (
            <Empty>Open packs to start your collection.</Empty>
          )}
          {(inventory?.owned ?? []).length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10, marginTop: 12 }}>
              {inventory!.owned
                .slice()
                .sort((a, b) => b.qty - a.qty)
                .map(c => <OwnedTile key={c.cardId} cardId={c.cardId} qty={c.qty} />)}
            </div>
          )}
        </section>

        {/* Reveal modal */}
        {reveal && (
          <RevealModal cardIds={reveal.cardIds} onClose={() => setReveal(null)} />
        )}
      </div>
    </div>
  );
}

// ── Components ─────────────────────────────────────────────────────────────

function PreviewBanner() {
  return (
    <div style={{
      background: 'linear-gradient(90deg, #4a2010, #6a3010)',
      border: '1px solid #c8732a', borderRadius: 10,
      padding: '10px 14px', marginBottom: 14,
      fontSize: 12, letterSpacing: 0.5,
    }}>
      🚧 <b>PREVIEW MODE</b> — packs are not yet on-chain. Buys & opens are
      simulated server-side to let us iterate on the page. No SOL or $MASTER
      is transferred. Card pulls are uniformly random; rarity guarantees ship
      with Phase 1.
    </div>
  );
}

function SupplyBar({ supply }: { supply: BoosterSupply | null }) {
  const pct = supply ? Math.min(100, (supply.minted / Math.max(1, supply.cap)) * 100) : 0;
  const low = supply ? supply.remaining <= 100 : false;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontSize: 11, opacity: 0.75, marginBottom: 4, letterSpacing: 0.5,
      }}>
        <span>{supply ? `${fmtNum(supply.minted)} / ${fmtNum(supply.cap)} minted` : 'loading…'}</span>
        <span>{supply ? `${fmtNum(supply.remaining)} left` : ''}</span>
      </div>
      <div style={{
        height: 8, background: '#1a1240', borderRadius: 6, overflow: 'hidden',
        border: '1px solid #2a1e54',
      }}>
        <div style={{
          width: `${pct}%`, height: '100%',
          background: low
            ? 'linear-gradient(90deg, #ff6a3a, #ffaf3a)'
            : 'linear-gradient(90deg, #6c4bd8, #b585ff)',
          transition: 'width 0.4s ease',
        }} />
      </div>
    </div>
  );
}

function PriceBtn({ active, onClick, label, value }: {
  active: boolean; onClick: () => void; label: string; value: string;
}) {
  return (
    <button onClick={onClick} style={{
      flex: 1,
      background: active ? '#6c4bd8' : '#1a1240',
      color: '#fff',
      border: `2px solid ${active ? '#b585ff' : '#2a1e54'}`,
      borderRadius: 8, padding: '10px 12px',
      fontWeight: 700, cursor: 'pointer', textAlign: 'left',
    }}>
      <div style={{ fontSize: 10, opacity: 0.75, letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800 }}>{value}</div>
    </button>
  );
}

function PackArt() {
  // Pure-CSS pack until a real asset is supplied.
  return (
    <div style={{
      width: 200, height: 280, flex: '0 0 200px',
      borderRadius: 12, position: 'relative', overflow: 'hidden',
      background: 'linear-gradient(160deg, #2a1264 0%, #1a0a4a 60%, #050020 100%)',
      border: '2px solid #6c4bd8',
      boxShadow: '0 14px 40px rgba(108,75,216,0.45), inset 0 0 80px rgba(180,130,255,0.18)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 8, textAlign: 'center',
    }}>
      <div style={{ fontSize: 44 }}>📦</div>
      <div style={{ fontWeight: 900, letterSpacing: 2, fontSize: 13 }}>MEMETIC</div>
      <div style={{ fontWeight: 900, letterSpacing: 2, fontSize: 13 }}>MASTERS</div>
      <div style={{ fontSize: 10, opacity: 0.7, letterSpacing: 3, marginTop: 4 }}>GENESIS</div>
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(45deg, transparent 40%, rgba(180,130,255,0.15) 50%, transparent 60%)' }} />
    </div>
  );
}

function SealedTile({ packId, mintedAt, opening, onOpen }: {
  packId: string; mintedAt: number; opening: boolean; onOpen: () => void;
}) {
  return (
    <div style={{
      background: 'linear-gradient(160deg, #1a1240, #0a0420)',
      border: '1px solid #4a3590', borderRadius: 10, padding: 12,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{
        height: 100, borderRadius: 8,
        background: 'linear-gradient(160deg, #2a1264, #1a0a4a)',
        border: '1px solid #6c4bd8',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 36,
      }}>📦</div>
      <div style={{ fontSize: 11, opacity: 0.6 }}>{relTime(mintedAt)}</div>
      <button onClick={onOpen} disabled={opening} style={{
        background: opening ? '#3a3050' : '#3aa66a', color: '#fff',
        border: 'none', borderRadius: 6, padding: '8px 10px',
        fontWeight: 800, cursor: opening ? 'wait' : 'pointer', fontSize: 12, letterSpacing: 1,
      }}>{opening ? 'OPENING…' : '✂ OPEN'}</button>
      <div style={{ fontSize: 9, opacity: 0.4, fontFamily: 'monospace', textAlign: 'center' }}>{packId}</div>
    </div>
  );
}

function OwnedTile({ cardId, qty }: { cardId: string; qty: number }) {
  const def = CARDS[cardId] as any;
  const color: Color | undefined = def?.color;
  const meta = color ? COLOR_META[color] : null;
  return (
    <div style={{
      background: 'linear-gradient(160deg, #14112a, #07061a)',
      border: `1px solid ${meta?.hex ?? '#2a1e54'}`,
      borderRadius: 8, padding: 8,
      display: 'flex', flexDirection: 'column', gap: 4, position: 'relative',
    }}>
      <div style={{
        height: 80, borderRadius: 6, overflow: 'hidden',
        background: '#0a0420',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 28,
      }}>
        {def?.art && typeof def.art === 'string' && def.art.startsWith('/')
          ? <img src={def.art} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <span>{(def?.art as string) ?? '🃏'}</span>}
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, lineHeight: 1.2 }}>{def?.title ?? cardId}</div>
      <div style={{
        position: 'absolute', top: 4, right: 4,
        background: '#000a', color: '#fff', padding: '2px 6px',
        borderRadius: 10, fontSize: 10, fontWeight: 800,
      }}>×{qty}</div>
    </div>
  );
}

function RevealModal({ cardIds, onClose }: { cardIds: string[]; onClose: () => void }) {
  const [revealed, setRevealed] = useState(0);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    timer.current = window.setInterval(() => {
      setRevealed(r => {
        if (r >= cardIds.length) {
          if (timer.current) window.clearInterval(timer.current);
          return r;
        }
        return r + 1;
      });
    }, 350);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [cardIds.length]);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(2,2,8,0.85)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'linear-gradient(160deg, #150f2a, #0a0716)',
        border: '1px solid #6c4bd8', borderRadius: 14,
        padding: 22, maxWidth: 640, width: '100%',
        boxShadow: '0 18px 50px rgba(0,0,0,0.6)',
      }}>
        <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 2, marginBottom: 14, textAlign: 'center' }}>
          ✨ PACK CONTENTS ✨
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8,
        }}>
          {cardIds.map((id, i) => (
            <div key={i} style={{
              opacity: i < revealed ? 1 : 0.15,
              transform: i < revealed ? 'scale(1)' : 'scale(0.92)',
              transition: 'opacity 250ms ease, transform 250ms ease',
            }}>
              <OwnedTile cardId={id} qty={1} />
            </div>
          ))}
        </div>
        <button onClick={onClose} style={{
          marginTop: 18, width: '100%',
          background: '#6c4bd8', color: '#fff',
          border: 'none', borderRadius: 8, padding: '12px 16px',
          fontWeight: 800, letterSpacing: 1, cursor: 'pointer', fontSize: 14,
        }}>ADD TO LIBRARY</button>
      </div>
    </div>
  );
}

// ── Small atoms ────────────────────────────────────────────────────────────

const panel: React.CSSProperties = {
  background: 'rgba(10,4,30,0.55)',
  border: '1px solid #2a1e54',
  borderRadius: 12,
  padding: 18,
  marginTop: 16,
};

const ghostBtn: React.CSSProperties = {
  background: 'transparent', color: '#ccc',
  border: '1px solid #3a3050', borderRadius: 6,
  padding: '6px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 700,
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: 1.5 }}>{children}</div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: '22px 12px', textAlign: 'center', fontSize: 12, opacity: 0.65,
      border: '1px dashed #2a1e54', borderRadius: 8, marginTop: 12,
    }}>{children}</div>
  );
}

function short(s: string) { return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s; }
function fmt(n: number, d = 2) { return n.toLocaleString(undefined, { maximumFractionDigits: d }); }
function fmtNum(n: number) { return n.toLocaleString(); }
function relTime(ts: number) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const _useMemo = useMemo; void _useMemo;

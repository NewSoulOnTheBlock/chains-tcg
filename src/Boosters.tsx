// src/Boosters.tsx
// Booster Pack Ticket NFT mint page.
//
// Real on-chain flow:
//   1. Buyer connects a Solana wallet (Phantom/Solflare/Backpack) and clicks
//      BUY TICKET. Page asks server for an unsigned tx (SystemProgram.transfer
//      0.4 SOL → treasury).
//   2. Wallet signs + broadcasts. Once confirmed, page POSTs the signature
//      back to the server, which verifies the payment and mints a Metaplex
//      Core NFT ticket to the buyer.
//   3. Each ticket is redeemable for: 3 digital boosters (10 cards each),
//      1 physical booster (mailed), 1 special-edition merch piece (mailed).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Connection, Transaction } from '@solana/web3.js';
import { CARDS, COLOR_META, type Color } from './cards';
import { getProfileApi } from './profiles';
import {
  detectSolanaWallets, getSolanaWallet, type SolanaWalletKind,
} from './wallet';
import Lightfall from './Lightfall';
import {
  getBoosterSupply, buildBuyIntent, confirmPayment, getMyTickets,
  redeemDigital, redeemPhysical, redeemMerch,
  type BoosterSupply, type TicketRow, type ShippingAddress,
} from './boosters-api';
import { ShinyBrand, ShinyButtonLabel } from './ShinyText';

// Brand-logo palette for the WebGL background streaks.
const BRAND_STREAK_COLORS = [
  COLOR_META.bnb.hex, COLOR_META.sol.hex, COLOR_META.hl.hex, COLOR_META.eth.hex,
];
const BRAND_BG_GLOW = COLOR_META.sol.hex;

// Client-side RPC pool for the buyer's sendRawTransaction + confirmTransaction.
// Public nodes go first so a stale / wrong VITE_SOLANA_RPC (e.g. Helius URL
// with an invalid api key returning -32401) can't gate the mint flow.
const CLIENT_RPC_POOL: string[] = (() => {
  const env = (import.meta.env.VITE_SOLANA_RPC as string | undefined) ?? '';
  const PUBLIC: string[] = [
    'https://solana-rpc.publicnode.com',
    'https://solana-mainnet.public.blastapi.io',
    'https://solana.drpc.org',
    'https://api.mainnet-beta.solana.com',
  ];
  // De-dupe; user RPC last (still tried if all public nodes fail).
  const pool = [...PUBLIC];
  if (env && !pool.includes(env)) pool.push(env);
  return pool;
})();

/** Try every RPC in CLIENT_RPC_POOL until one accepts the broadcast. */
async function broadcastWithFailover(rawTx: Uint8Array): Promise<{ sig: string; conn: Connection }> {
  let lastErr: any = null;
  for (const url of CLIENT_RPC_POOL) {
    try {
      const c = new Connection(url, 'confirmed');
      const sig = await c.sendRawTransaction(rawTx, { skipPreflight: false, maxRetries: 3 });
      return { sig, conn: c };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      console.warn(`[boosters] sendRawTransaction via ${url} failed:`, msg);
      lastErr = e;
      continue;
    }
  }
  throw new Error(`Broadcast failed on every RPC: ${String(lastErr?.message ?? lastErr)}`);
}

/** Confirm a signature against the pool — first node that knows about it wins. */
async function confirmWithFailover(
  sig: string, blockhash: string, lastValidBlockHeight: number,
): Promise<void> {
  let lastErr: any = null;
  for (const url of CLIENT_RPC_POOL) {
    try {
      const c = new Connection(url, 'confirmed');
      await c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      return;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      console.warn(`[boosters] confirmTransaction via ${url} failed:`, msg);
      lastErr = e;
      continue;
    }
  }
  throw new Error(`Confirm failed on every RPC: ${String(lastErr?.message ?? lastErr)}`);
}

export function BoostersPage({ myName, onBack }: { myName: string; onBack: () => void }) {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [supply, setSupply] = useState<BoosterSupply | null>(null);
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [busy, setBusy] = useState<null | 'buy' | string>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ ticketNumber: number; cardIds: string[] } | null>(null);
  const [shipping, setShipping] = useState<{ ticket: TicketRow; kind: 'physical' | 'merch' } | null>(null);
  const [justMinted, setJustMinted] = useState<TicketRow | null>(null);

  // Load Solana wallet from the player's profile.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const p = await getProfileApi(myName);
        if (cancelled) return;
        const addr = p?.walletAddress ?? null;
        setWalletAddress(addr && !addr.startsWith('0x') ? addr : null);
      } catch { /* leave null */ }
    }
    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
  }, [myName]);

  const refreshSupply = useCallback(async () => {
    try { setSupply(await getBoosterSupply()); } catch (e: any) { setErr(String(e?.message ?? e)); }
  }, []);
  const refreshTickets = useCallback(async () => {
    if (!walletAddress) { setTickets([]); return; }
    try { const r = await getMyTickets(walletAddress); setTickets(r.tickets); }
    catch (e: any) { setErr(String(e?.message ?? e)); }
  }, [walletAddress]);

  useEffect(() => { refreshSupply(); const t = setInterval(refreshSupply, 15_000); return () => clearInterval(t); }, [refreshSupply]);
  useEffect(() => { refreshTickets(); }, [refreshTickets]);

  // ── Buy flow: server-built tx → wallet sign → broadcast → confirm ────────
  async function onBuy() {
    if (!walletAddress) { setErr('Link a Solana wallet to your profile first.'); return; }
    setErr(null); setBusy('buy');
    try {
      // 1. Locate an installed wallet.
      const installed = detectSolanaWallets().filter(w => w.installed);
      if (installed.length === 0) {
        throw new Error('No Solana wallet detected. Install Phantom, Solflare, or Backpack.');
      }
      const kind: SolanaWalletKind = installed[0].kind;
      const wallet = await getSolanaWallet(kind);
      const connected = wallet.publicKey?.toBase58?.();
      if (!connected) throw new Error(`${kind} wallet did not return a public key.`);
      if (connected !== walletAddress) {
        throw new Error(`Wallet ${connected.slice(0, 4)}… doesn't match your profile (${walletAddress.slice(0, 4)}…). Reconnect the right wallet.`);
      }

      // 2. Ask server for the unsigned payment tx.
      const intent = await buildBuyIntent(walletAddress);

      // 3. Deserialize, sign, broadcast (with client-side RPC failover).
      const raw = Uint8Array.from(atob(intent.txBase64), c => c.charCodeAt(0));
      const tx = Transaction.from(raw);
      const signed: Transaction = await wallet.signTransaction(tx);
      const { sig } = await broadcastWithFailover(signed.serialize());

      // 4. Wait for on-chain confirmation across the pool.
      await confirmWithFailover(sig, intent.blockhash, intent.lastValidBlockHeight);

      // 5. Server verifies + mints NFT.
      const res = await confirmPayment(walletAddress, sig);
      setJustMinted(res.ticket);
      await Promise.all([refreshSupply(), refreshTickets()]);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setErr(/user rejected|User rejected/.test(msg) ? 'Transaction cancelled.' : msg);
    } finally { setBusy(null); }
  }

  async function onRedeemDigital(t: TicketRow) {
    if (!walletAddress) return;
    setErr(null); setBusy(`d:${t.mintAddress}`);
    try {
      const r = await redeemDigital(t.mintAddress, walletAddress);
      setReveal({ ticketNumber: t.ticketNumber, cardIds: r.cardIds });
      await refreshTickets();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(null); }
  }

  async function onSubmitShipping(addr: ShippingAddress) {
    if (!shipping || !walletAddress) return;
    setErr(null); setBusy(`s:${shipping.ticket.mintAddress}`);
    try {
      if (shipping.kind === 'physical') {
        await redeemPhysical(shipping.ticket.mintAddress, walletAddress, addr);
      } else {
        await redeemMerch(shipping.ticket.mintAddress, walletAddress, addr);
      }
      setShipping(null);
      await refreshTickets();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(null); }
  }

  const soldOut = supply ? supply.remaining <= 0 : false;
  const liveMode = supply?.mode === 'live';

  return (
    <div style={{
      position: 'fixed', inset: 0, overflow: 'auto',
      background: '#050015', color: '#fff',
      fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      <div style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
        <Lightfall
          colors={BRAND_STREAK_COLORS} backgroundColor={BRAND_BG_GLOW}
          speed={0.8} streakCount={6} streakWidth={1.1} streakLength={1.2}
          glow={1.05} density={0.8} twinkle={1} zoom={2.4}
          backgroundGlow={0.55} opacity={0.85} mouseInteraction={false}
        />
        <div style={{
          position: 'absolute', inset: 0,
          background: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 30%, rgba(0,0,0,0.55) 100%)',
        }} />
      </div>

      <div style={{ position: 'relative', zIndex: 1 }}>
        {/* Top bar */}
        <div style={{
          position: 'sticky', top: 0, zIndex: 5,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 18px',
          background: 'rgba(6,3,18,0.85)', backdropFilter: 'blur(8px)',
          borderBottom: '1px solid #2a1e54',
        }}>
          <button onClick={onBack} style={ghostBtn}><ShinyButtonLabel text="← Back" /></button>
          <div style={{ fontWeight: 800, letterSpacing: 2, fontSize: 14 }}>
            <ShinyBrand text="📦 BOOSTERS — GENESIS SET" />
          </div>
          <div style={{ minWidth: 80, textAlign: 'right', fontSize: 11, opacity: 0.7 }}>
            {walletAddress ? short(walletAddress) : 'no wallet'}
          </div>
        </div>

        <div style={{ maxWidth: 1000, margin: '0 auto', padding: '18px 16px 80px' }}>
          {!liveMode && (
            <div style={{
              background: 'linear-gradient(90deg, #4a2010, #6a3010)',
              border: '1px solid #c8732a', borderRadius: 10,
              padding: '10px 14px', marginBottom: 14, fontSize: 12,
            }}>
              ⚠ <b>Mint not yet configured</b> on this server (missing
              <code style={{ marginLeft: 4 }}>BOOSTER_TREASURY_KEYPAIR</code> /
              <code style={{ marginLeft: 4 }}>CUSTODIAL_ESCROW_KEYPAIR</code>).
            </div>
          )}

          {/* Hero / Buy panel */}
          <section style={panel}>
            <div style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
              <TicketArt />
              <div style={{ flex: '1 1 280px', minWidth: 240 }}>
                <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: 1 }}>
                  <ShinyBrand text="Booster Pack Ticket" />
                </div>
                <div style={{ fontSize: 13, opacity: 0.85, marginTop: 6, lineHeight: 1.55 }}>
                  A Genesis NFT ticket on Solana. Each ticket is redeemable for:
                  <ul style={{ margin: '8px 0 0 18px', padding: 0, lineHeight: 1.7 }}>
                    <li>🎴 <b>3 Digital Booster Packs</b> — 10 cards each (30 total)</li>
                    <li>📦 <b>1 Physical Booster Pack</b> — shipped to you</li>
                    <li>👕 <b>1 Special Edition Merch</b> — shipped to you</li>
                  </ul>
                </div>

                <SupplyBar supply={supply} />

                <div style={{ marginTop: 14, fontSize: 11, opacity: 0.7, letterSpacing: 1 }}>PRICE</div>
                <div style={{
                  marginTop: 6, background: '#1a1240',
                  border: '2px solid #b585ff', borderRadius: 8, padding: '12px 14px',
                  display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                }}>
                  <span style={{ fontSize: 24, fontWeight: 900 }}>
                    {supply ? fmt(supply.priceSol, 3) : '—'} <span style={{ fontSize: 13, opacity: 0.85 }}>SOL</span>
                  </span>
                  <span style={{ fontSize: 11, opacity: 0.65 }}>per ticket</span>
                </div>

                <button
                  onClick={onBuy}
                  disabled={busy !== null || soldOut || !walletAddress || !liveMode}
                  style={{
                    marginTop: 16, width: '100%',
                    background: soldOut ? '#3a2030' : '#6c4bd8',
                    color: '#fff', border: 'none', borderRadius: 10,
                    padding: '14px 18px', fontWeight: 900, fontSize: 15, letterSpacing: 1,
                    cursor: (busy !== null || soldOut || !walletAddress || !liveMode) ? 'not-allowed' : 'pointer',
                    opacity: (busy !== null || soldOut || !walletAddress || !liveMode) ? 0.6 : 1,
                    boxShadow: '0 8px 24px rgba(108,75,216,0.35)',
                  }}
                >
                  <ShinyButtonLabel text={
                    !liveMode    ? 'MINT OFFLINE' :
                    soldOut      ? 'SOLD OUT' :
                    !walletAddress ? 'LINK SOLANA WALLET IN PROFILE' :
                    busy === 'buy' ? 'WAITING FOR WALLET…' :
                    `🎟  MINT TICKET — ${supply ? fmt(supply.priceSol, 3) : '0.4'} SOL`
                  } />
                </button>

                {supply?.treasury && (
                  <div style={{ marginTop: 8, fontSize: 10, opacity: 0.45, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                    treasury: {supply.treasury}
                  </div>
                )}
                {err && <div style={{ marginTop: 10, color: '#ff6a8a', fontSize: 12 }}>⚠ {err}</div>}
              </div>
            </div>
          </section>

          {/* My Tickets */}
          <section style={panel}>
            <SectionTitle>🎟  My Tickets ({tickets.length})</SectionTitle>
            {!walletAddress && <Empty>Link a Solana wallet in your profile to see your tickets.</Empty>}
            {walletAddress && tickets.length === 0 && <Empty>You don't own any Booster Pack Tickets yet. Mint one above.</Empty>}
            {tickets.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 12 }}>
                {tickets.map(t => (
                  <TicketRowView
                    key={t.mintAddress}
                    ticket={t}
                    busyTag={busy}
                    onRedeemDigital={() => onRedeemDigital(t)}
                    onRedeemPhysical={() => setShipping({ ticket: t, kind: 'physical' })}
                    onRedeemMerch={() => setShipping({ ticket: t, kind: 'merch' })}
                  />
                ))}
              </div>
            )}
          </section>

          {justMinted && (
            <MintedModal ticket={justMinted} onClose={() => setJustMinted(null)} />
          )}
          {reveal && (
            <RevealModal ticketNumber={reveal.ticketNumber} cardIds={reveal.cardIds} onClose={() => setReveal(null)} />
          )}
          {shipping && (
            <ShippingModal
              kind={shipping.kind}
              onCancel={() => setShipping(null)}
              onSubmit={onSubmitShipping}
              busy={busy?.startsWith('s:') ?? false}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Ticket card ─────────────────────────────────────────────────────────────

function TicketRowView({
  ticket, busyTag, onRedeemDigital, onRedeemPhysical, onRedeemMerch,
}: {
  ticket: TicketRow; busyTag: string | null;
  onRedeemDigital: () => void; onRedeemPhysical: () => void; onRedeemMerch: () => void;
}) {
  const digBusy = busyTag === `d:${ticket.mintAddress}`;
  const shipBusy = busyTag === `s:${ticket.mintAddress}`;
  return (
    <div style={{
      background: 'linear-gradient(160deg, #1a1240, #0a0420)',
      border: '1px solid #4a3590', borderRadius: 12, padding: 14,
      display: 'flex', gap: 14, alignItems: 'stretch', flexWrap: 'wrap',
    }}>
      <div style={{ flex: '0 0 120px' }}>
        <img src="/booster-ticket.png" alt="Booster Pack Ticket"
          style={{ width: 120, height: 'auto', borderRadius: 8, border: '1px solid #6c4bd8' }} />
      </div>
      <div style={{ flex: '1 1 280px', minWidth: 240 }}>
        <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: 1 }}>
          <ShinyBrand text={`Ticket #${ticket.ticketNumber}`} />
        </div>
        <div style={{ fontSize: 10, opacity: 0.5, fontFamily: 'monospace', marginTop: 4, wordBreak: 'break-all' }}>
          mint: {ticket.mintAddress}
        </div>
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>
          minted {relTime(ticket.mintedAt)} · paid {ticket.priceSol.toFixed(3)} SOL
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8, marginTop: 12 }}>
          <RedeemCell
            title="🎴 3 Digital Boosters"
            status={ticket.digitalRedeemedAt ? `Opened ${relTime(ticket.digitalRedeemedAt)}` : 'Ready to open'}
            done={!!ticket.digitalRedeemedAt}
            disabled={digBusy}
            onClick={onRedeemDigital}
            label={digBusy ? 'OPENING…' : ticket.digitalRedeemedAt ? '✓ OPENED' : '✂ OPEN NOW'}
          />
          <RedeemCell
            title="📦 1 Physical Booster"
            status={
              ticket.physicalRedeemedAt
                ? (ticket.physicalTracking ? `Shipped (${ticket.physicalTracking})` : `Submitted ${relTime(ticket.physicalRedeemedAt)} — awaiting ship`)
                : 'Awaiting shipping address'
            }
            done={!!ticket.physicalRedeemedAt}
            disabled={shipBusy}
            onClick={onRedeemPhysical}
            label={ticket.physicalRedeemedAt ? '✓ ADDRESS ON FILE' : 'CLAIM PHYSICAL'}
          />
          <RedeemCell
            title="👕 1 Special Edition Merch"
            status={
              ticket.merchRedeemedAt
                ? (ticket.merchTracking ? `Shipped (${ticket.merchTracking})` : `Submitted ${relTime(ticket.merchRedeemedAt)} — awaiting ship`)
                : 'Awaiting shipping address'
            }
            done={!!ticket.merchRedeemedAt}
            disabled={shipBusy}
            onClick={onRedeemMerch}
            label={ticket.merchRedeemedAt ? '✓ ADDRESS ON FILE' : 'CLAIM MERCH'}
          />
        </div>
      </div>
    </div>
  );
}

function RedeemCell({ title, status, done, disabled, onClick, label }: {
  title: string; status: string; done: boolean; disabled: boolean; onClick: () => void; label: string;
}) {
  return (
    <div style={{
      background: done ? 'rgba(40,120,90,0.18)' : 'rgba(108,75,216,0.10)',
      border: `1px solid ${done ? '#3aa66a' : '#4a3590'}`,
      borderRadius: 8, padding: 10,
      display: 'flex', flexDirection: 'column', gap: 6, minHeight: 96,
    }}>
      <div style={{ fontSize: 12, fontWeight: 800 }}>{title}</div>
      <div style={{ fontSize: 10, opacity: 0.7, flex: 1 }}>{status}</div>
      <button
        onClick={onClick}
        disabled={done || disabled}
        style={{
          background: done ? '#1f3a2a' : '#3aa66a',
          color: '#fff', border: 'none', borderRadius: 6,
          padding: '6px 8px', fontWeight: 800, fontSize: 10, letterSpacing: 1,
          cursor: (done || disabled) ? 'not-allowed' : 'pointer',
          opacity: (done || disabled) ? 0.7 : 1,
        }}
      ><ShinyButtonLabel text={label} /></button>
    </div>
  );
}

// ── Just-minted celebration modal ──────────────────────────────────────────

function MintedModal({ ticket, onClose }: { ticket: TicketRow; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(2,2,8,0.85)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'linear-gradient(160deg, #150f2a, #0a0716)',
        border: '1px solid #6c4bd8', borderRadius: 14,
        padding: 22, maxWidth: 460, width: '100%', textAlign: 'center',
        boxShadow: '0 18px 50px rgba(0,0,0,0.6)',
      }}>
        <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: 1, marginBottom: 6 }}>
          <ShinyBrand text="🎉 TICKET MINTED!" />
        </div>
        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 14 }}>
          Ticket #{ticket.ticketNumber} is now in your wallet.
        </div>
        <img src="/booster-ticket.png" alt="Booster Pack Ticket"
          style={{ width: '70%', maxWidth: 260, borderRadius: 10, border: '1px solid #6c4bd8', boxShadow: '0 0 40px rgba(180,130,255,0.45)' }} />
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 14, fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {ticket.mintAddress}
        </div>
        <button onClick={onClose} style={{
          marginTop: 18, width: '100%',
          background: '#6c4bd8', color: '#fff',
          border: 'none', borderRadius: 8, padding: '12px 16px',
          fontWeight: 800, letterSpacing: 1, cursor: 'pointer', fontSize: 14,
        }}><ShinyButtonLabel text="VIEW MY TICKETS" /></button>
      </div>
    </div>
  );
}

// ── Digital reveal modal (30 cards) ─────────────────────────────────────────

function RevealModal({ ticketNumber, cardIds, onClose }: { ticketNumber: number; cardIds: string[]; onClose: () => void }) {
  const [revealed, setRevealed] = useState(0);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    timer.current = window.setInterval(() => {
      setRevealed(r => {
        if (r >= cardIds.length) { if (timer.current) window.clearInterval(timer.current); return r; }
        return r + 1;
      });
    }, 120);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [cardIds.length]);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(2,2,8,0.85)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, overflow: 'auto',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'linear-gradient(160deg, #150f2a, #0a0716)',
        border: '1px solid #6c4bd8', borderRadius: 14,
        padding: 22, maxWidth: 880, width: '100%',
        boxShadow: '0 18px 50px rgba(0,0,0,0.6)',
        maxHeight: '92vh', overflow: 'auto',
      }}>
        <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 2, marginBottom: 14, textAlign: 'center' }}>
          <ShinyBrand text={`✨ TICKET #${ticketNumber} — 30 CARDS ✨`} />
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8,
        }}>
          {cardIds.map((id, i) => (
            <div key={i} style={{
              opacity: i < revealed ? 1 : 0.12,
              transform: i < revealed ? 'scale(1)' : 'scale(0.92)',
              transition: 'opacity 220ms ease, transform 220ms ease',
            }}>
              <OwnedTile cardId={id} />
            </div>
          ))}
        </div>
        <button onClick={onClose} style={{
          marginTop: 18, width: '100%',
          background: '#6c4bd8', color: '#fff',
          border: 'none', borderRadius: 8, padding: '12px 16px',
          fontWeight: 800, letterSpacing: 1, cursor: 'pointer', fontSize: 14,
        }}><ShinyButtonLabel text="ADD TO LIBRARY" /></button>
      </div>
    </div>
  );
}

function OwnedTile({ cardId }: { cardId: string }) {
  const def = CARDS[cardId] as any;
  const color: Color | undefined = def?.color;
  const meta = color ? COLOR_META[color] : null;
  return (
    <div style={{
      background: 'linear-gradient(160deg, #14112a, #07061a)',
      border: `1px solid ${meta?.hex ?? '#2a1e54'}`,
      borderRadius: 8, padding: 6,
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{
        height: 70, borderRadius: 6, overflow: 'hidden',
        background: '#0a0420',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 24,
      }}>
        {def?.art && typeof def.art === 'string' && def.art.startsWith('/')
          ? <img src={def.art} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <span>{(def?.art as string) ?? '🃏'}</span>}
      </div>
      <div style={{ fontSize: 10, fontWeight: 700, lineHeight: 1.2 }}>{def?.title ?? cardId}</div>
    </div>
  );
}

// ── Shipping address modal (physical / merch) ───────────────────────────────

function ShippingModal({ kind, onCancel, onSubmit, busy }: {
  kind: 'physical' | 'merch';
  onCancel: () => void;
  onSubmit: (a: ShippingAddress) => void;
  busy: boolean;
}) {
  const [form, setForm] = useState<ShippingAddress>({
    fullName: '', line1: '', line2: '', city: '', region: '',
    postalCode: '', country: '', email: '',
  });
  const set = <K extends keyof ShippingAddress>(k: K) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));
  const valid = form.fullName.trim() && form.line1.trim() && form.city.trim()
    && form.postalCode.trim() && form.country.trim() && form.email?.includes('@');

  const title = kind === 'physical' ? '📦 Ship My Physical Booster' : '👕 Ship My Special Edition Merch';

  return (
    <div onClick={onCancel} style={{
      position: 'fixed', inset: 0, zIndex: 220,
      background: 'rgba(2,2,8,0.85)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'linear-gradient(160deg, #150f2a, #0a0716)',
        border: '1px solid #6c4bd8', borderRadius: 14,
        padding: 22, maxWidth: 500, width: '100%',
        maxHeight: '92vh', overflow: 'auto',
      }}>
        <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 1, marginBottom: 12 }}>
          <ShinyBrand text={title} />
        </div>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 14 }}>
          We'll only use this address to ship your item. You'll get tracking via email once it's on the way.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Full name"  value={form.fullName}  onChange={set('fullName')}  full />
          <Field label="Email"      value={form.email ?? ''} onChange={set('email')}    full />
          <Field label="Address line 1" value={form.line1} onChange={set('line1')} full />
          <Field label="Address line 2 (optional)" value={form.line2 ?? ''} onChange={set('line2')} full />
          <Field label="City"        value={form.city}       onChange={set('city')} />
          <Field label="State/Region" value={form.region}    onChange={set('region')} />
          <Field label="Postal code" value={form.postalCode} onChange={set('postalCode')} />
          <Field label="Country"     value={form.country}    onChange={set('country')} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button onClick={onCancel} disabled={busy} style={{
            flex: 1, background: 'transparent', color: '#ccc',
            border: '1px solid #3a3050', borderRadius: 8, padding: '12px 16px',
            fontWeight: 700, cursor: 'pointer', fontSize: 13,
          }}>Cancel</button>
          <button onClick={() => valid && onSubmit(form)} disabled={!valid || busy} style={{
            flex: 2, background: valid ? '#3aa66a' : '#234032',
            color: '#fff', border: 'none', borderRadius: 8, padding: '12px 16px',
            fontWeight: 900, letterSpacing: 1, fontSize: 13,
            cursor: (valid && !busy) ? 'pointer' : 'not-allowed',
            opacity: (valid && !busy) ? 1 : 0.6,
          }}><ShinyButtonLabel text={busy ? 'SUBMITTING…' : 'SUBMIT SHIPPING ADDRESS'} /></button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, full }: {
  label: string; value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; full?: boolean;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: full ? '1 / -1' : undefined }}>
      <span style={{ fontSize: 10, opacity: 0.7, letterSpacing: 1 }}>{label.toUpperCase()}</span>
      <input value={value} onChange={onChange} style={{
        background: '#0a0420', color: '#fff',
        border: '1px solid #2a1e54', borderRadius: 6,
        padding: '8px 10px', fontSize: 13,
      }} />
    </label>
  );
}

// ── Ticket art (uses the actual NFT image) ──────────────────────────────────

function TicketArt() {
  return (
    <div style={{ flex: '0 0 220px', width: 220 }}>
      <img src="/booster-ticket.png" alt="Booster Pack Ticket"
        style={{
          width: '100%', height: 'auto', borderRadius: 12,
          border: '2px solid #6c4bd8',
          boxShadow: '0 14px 40px rgba(108,75,216,0.45), 0 0 80px rgba(180,130,255,0.18)',
        }} />
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

// ── Atoms ───────────────────────────────────────────────────────────────────

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
  const inner = typeof children === 'string' ? <ShinyBrand text={children} /> : children;
  return <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: 1.5 }}>{inner}</div>;
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

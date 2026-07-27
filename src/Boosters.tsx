// src/Boosters.tsx
// Booster Vault — a premium collectible-opening experience for On-Chain Virtual
// Arena. Three understandable stages: Purchase -> Mint -> Reveal. Buying a pack
// mints 5 random cards + 1 guaranteed foil as NFTs on Robinhood Chain via the
// CardPack contract. All prices, balances and card results come from live,
// authoritative on-chain data — the client never invents a pull, and cards are
// only revealed after the mint transaction is confirmed on-chain.

import { useEffect, useState, useRef, useCallback } from 'react';
import { color as C, font as F, radius as R, shadow as SH, surface as SURF, edge as EDGE, depth as DEPTH } from './theme';
import { CARDS, COLOR_META } from './cards';
import { ChainLogo } from './chain-logos';
import {
  mintPack, resumePack, packCostEstimate, getEthBalance,
  getConnectedAccount, getWalletChainId, switchToRobinhood,
  PACK_PRICE_ETH, ROBINHOOD_CHAIN_ID,
  PACK_MINTING_AVAILABLE, PACK_MINTING_UNAVAILABLE_MESSAGE,
  type RevealedCard,
} from './pack-evm';
import { connectRobinhoodChain, shortAddr } from './wallet';
import { syncAfterMint, useCollection } from './collection';
import { formatEther, type Address } from 'viem';
import {
  ArrowLeft, Check, Copy, SoundOn, SoundOff, Diamond, DiamondOutline,
  Warning, Star, Hourglass,
} from './icons';

// ── Transaction state machine ───────────────────────────────────────────────
type Tx =
  | 'idle'
  | 'wrong_network'
  | 'insufficient'
  | 'awaiting'      // wallet popup open, no hash yet
  | 'confirming'    // hash received, waiting for on-chain receipt
  | 'confirmed'     // receipt success, cards known, reveal not yet started
  | 'revealing'
  | 'complete'
  | 'rejected'
  | 'failed';

type ErrBox = { kind: Tx; heading: string; message: string; detail?: string };

const PENDING_KEY = 'ocva.pendingPack';
const MUTE_KEY = 'ocva.muted';

// Ordered real catalogue (non-node cards) — the same index space the contract
// mints from, used to show an accurate card list + odds.
const CATALOG = Object.values(CARDS).filter((c) => c.type !== 'node');

const CSS = `
@keyframes ova-float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-10px)} }
@keyframes ova-pack-shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-5px) rotate(-1.5deg)} 50%{transform:translateX(5px) rotate(1.5deg)} 75%{transform:translateX(-3px)} }
@keyframes ova-sheen { 0%{transform:translateX(-120%)} 100%{transform:translateX(220%)} }
@keyframes ova-pop { from{opacity:0; transform:translateY(14px) scale(.94)} to{opacity:1; transform:translateY(0) scale(1)} }
@keyframes ova-rune-spin { to{transform:rotate(360deg)} }
@keyframes ova-particle { 0%{opacity:0; transform:translateY(0)} 20%{opacity:.7} 100%{opacity:0; transform:translateY(-140px)} }
@keyframes ova-burst { 0%{opacity:.9; transform:scale(.3)} 100%{opacity:0; transform:scale(2.4)} }
@keyframes ova-pulse-ring { 0%,100%{opacity:.5} 50%{opacity:1} }
.ova-reveal { animation: ova-pop .5s cubic-bezier(.2,.8,.2,1) both; }
.ova-flip-inner { transition: transform .55s cubic-bezier(.2,.85,.25,1); transform-style: preserve-3d; position:relative; width:100%; height:100%; }
.ova-flip.is-flipped .ova-flip-inner { transform: rotateY(180deg); }
.ova-flip-face { position:absolute; inset:0; backface-visibility:hidden; -webkit-backface-visibility:hidden; border-radius:14px; overflow:hidden; }
.ova-flip-back { transform: rotateY(180deg); }
.ova-linkbtn { background:none; border:none; color:${C.gold}; font-weight:700; letter-spacing:.12em; font-size:12px; cursor:pointer; text-decoration:underline; text-underline-offset:4px; padding:4px 2px; }
.ova-linkbtn:hover { color:${C.goldHi}; }
@media (prefers-reduced-motion: reduce) {
  .ova-flip-inner { transition-duration: .01ms !important; }
  .ova-reveal { animation-duration: .01ms !important; }
}
`;

// ── Error mapping (never surface raw RPC internals) ─────────────────────────
function mapMintError(e: any): ErrBox {
  const msg = String(e?.shortMessage || e?.details || e?.message || e || '');
  const code = e?.code;
  if (code === 4001 || /user rejected|user denied|rejected the request|reject/i.test(msg))
    return { kind: 'rejected', heading: 'TRANSACTION CANCELLED', message: 'You cancelled the request in your wallet.', detail: msg };
  if (/insufficient funds|exceeds balance|not enough|insufficient balance/i.test(msg))
    return { kind: 'insufficient', heading: 'INSUFFICIENT ETH', message: 'Add ETH on Robinhood Chain to cover the pack price and network fee.', detail: msg };
  if (/4902|unrecognized chain|wrong network|chain mismatch|does not match the target chain/i.test(msg))
    return { kind: 'wrong_network', heading: 'WRONG NETWORK', message: 'Switch your wallet to Robinhood Chain to continue.', detail: msg };
  if (/revert|execution reverted/i.test(msg))
    return { kind: 'failed', heading: 'MINT FAILED', message: 'The pack could not be minted. Only gas was spent.', detail: msg };
  if (/timeout|timed out|took too long/i.test(msg))
    return { kind: 'failed', heading: 'TRANSACTION TIMED OUT', message: 'The network did not confirm in time. Check your wallet before retrying.', detail: msg };
  if (/replaced|dropped|nonce/i.test(msg))
    return { kind: 'failed', heading: 'TRANSACTION REPLACED', message: 'This transaction was replaced or dropped. Check your wallet, then try again.', detail: msg };
  return { kind: 'failed', heading: 'TRANSACTION FAILED', message: 'Something went wrong submitting the transaction. Please try again.', detail: msg };
}

// ── Root page ───────────────────────────────────────────────────────────────
// `myName` is gone on purpose: ownership is no longer keyed by display name.
// The mint goes to the connected wallet and the server derives the collection
// from the session's proven address, so this page needs no identity prop.
export function BoostersPage({ onBack }: { onBack: () => void }) {
  const mobile = useIsMobile();

  // Wallet / network / funds — authoritative live values.
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [cost, setCost] = useState<{ price: bigint; gasCost: bigint; total: bigint } | null>(null);
  const [switching, setSwitching] = useState(false);

  // Transaction + reveal.
  const [tx, setTx] = useState<Tx>('idle');
  const [hash, setHash] = useState<`0x${string}` | null>(null);
  const [cards, setCards] = useState<RevealedCard[]>([]);
  const [errBox, setErrBox] = useState<ErrBox | null>(null);

  const [muted, setMuted] = useState<boolean>(() => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } });
  const [modal, setModal] = useState<null | 'cards' | 'odds'>(null);
  const [copied, setCopied] = useState(false);

  const connected = !!account;
  const onRobinhood = chainId === ROBINHOOD_CHAIN_ID;

  const refreshWallet = useCallback(async () => {
    const [a, cid] = await Promise.all([getConnectedAccount(), getWalletChainId()]);
    setAccount(a); setChainId(cid);
    if (a) { try { setBalance(await getEthBalance(a)); } catch { setBalance(null); } }
    else setBalance(null);
  }, []);

  // Initial load: price/gas estimate, wallet, and any pending mint recovery.
  useEffect(() => {
    packCostEstimate().then(setCost).catch(() => {});
    refreshWallet();
    // Refresh recovery: resume a mint that was pending across a page reload.
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      if (raw) {
        const p = JSON.parse(raw) as { hash: `0x${string}` };
        if (p?.hash) {
          setHash(p.hash); setTx('confirming');
          resumePack(p.hash)
            .then((pulled) => { setCards(pulled); void syncAfterMint(pulled.map((c) => c.id)); setTx('confirmed'); localStorage.removeItem(PENDING_KEY); })
            .catch((e) => { setErrBox(mapMintError(e)); setTx('failed'); localStorage.removeItem(PENDING_KEY); });
        }
      }
    } catch { /* ignore */ }

    const eth = (window as any).ethereum;
    if (!eth?.on) return;
    const onAcct = () => refreshWallet();
    const onChain = () => refreshWallet();
    eth.on('accountsChanged', onAcct);
    eth.on('chainChanged', onChain);
    return () => { eth.removeListener?.('accountsChanged', onAcct); eth.removeListener?.('chainChanged', onChain); };
  }, [refreshWallet]);

  // Reflect mute across any audio the app is playing elsewhere.
  useEffect(() => {
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch {}
    document.querySelectorAll('audio').forEach((a) => { (a as HTMLAudioElement).muted = muted; });
  }, [muted]);

  const priceEth = cost ? (+formatEther(cost.price)).toFixed(4) : (+PACK_PRICE_ETH).toFixed(4);
  const pending = tx === 'awaiting' || tx === 'confirming';
  const inReveal = tx === 'confirmed' || tx === 'revealing' || tx === 'complete';

  async function connect() {
    setErrBox(null);
    try { const w = await connectRobinhoodChain(); setAccount(w.address as Address); await refreshWallet(); }
    catch (e) { setErrBox(mapMintError(e)); }
  }

  async function doSwitch() {
    setErrBox(null); setSwitching(true);
    try { await switchToRobinhood(); await refreshWallet(); }
    catch (e) { setErrBox(mapMintError(e)); }
    finally { setSwitching(false); }
  }

  async function open() {
    if (pending) return; // prevent duplicate submissions
    setErrBox(null);
    // Recheck requirements immediately before submitting.
    await refreshWallet();
    const a = await getConnectedAccount();
    const cid = await getWalletChainId();
    if (!a) { await connect(); return; }
    if (cid !== ROBINHOOD_CHAIN_ID) { setTx('wrong_network'); return; }
    const fresh = await packCostEstimate().catch(() => cost);
    if (fresh) setCost(fresh);
    const bal = await getEthBalance(a).catch(() => null);
    if (bal != null) setBalance(bal);
    if (fresh && bal != null && bal < fresh.total) {
      setTx('insufficient');
      setErrBox({ kind: 'insufficient', heading: 'INSUFFICIENT ETH', message: 'Add ETH on Robinhood Chain to cover the pack price and network fee.' });
      return;
    }

    setTx('awaiting'); setCards([]); setHash(null);
    try {
      const pulled = await mintPack((h) => {
        setHash(h);
        try { localStorage.setItem(PENDING_KEY, JSON.stringify({ hash: h, account: a })); } catch {}
        setTx('confirming');
      });
      setCards(pulled);
      // The mint is a real on-chain transaction, so the SERVER is what decides
      // these cards are yours — the client no longer grants itself anything.
      // `syncAfterMint` shows them immediately and reconciles with the chain in
      // the background, tolerating indexer lag. Fire and forget: a sync failure
      // must never turn a successful mint into an error screen.
      void syncAfterMint(pulled.map((c) => c.id));
      try { localStorage.removeItem(PENDING_KEY); } catch {}
      setTx('confirmed');
    } catch (e) {
      try { localStorage.removeItem(PENDING_KEY); } catch {}
      const m = mapMintError(e);
      setErrBox(m);
      setTx(m.kind === 'insufficient' ? 'insufficient' : m.kind === 'wrong_network' ? 'wrong_network' : m.kind === 'rejected' ? 'rejected' : 'failed');
    }
  }

  function reset() { setTx('idle'); setCards([]); setHash(null); setErrBox(null); refreshWallet(); }

  async function copyAddr() {
    if (!account) return;
    try { await navigator.clipboard.writeText(account); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  }

  const stageIndex = (tx === 'confirming' || tx === 'awaiting') ? 1 : inReveal ? 2 : 0;

  return (
    <div style={{
      position: 'fixed', inset: 0, overflow: mobile ? 'auto' : 'hidden',
      background: C.bg0, color: C.textHi, fontFamily: F.body,
      display: 'flex', flexDirection: 'column', height: '100dvh',
    }}>
      <style>{CSS}</style>
      <VaultBackdrop />

      <TopBar
        onBack={onBack}
        connected={connected} onRobinhood={onRobinhood} switching={switching}
        account={account} copied={copied} onCopy={copyAddr}
        muted={muted} onToggleMute={() => setMuted((m) => !m)}
      />

      {/* Main two-column layout. */}
      <div style={{
        position: 'relative', zIndex: 1, flex: 1, minHeight: 0,
        display: 'grid',
        gridTemplateColumns: mobile ? '1fr' : 'minmax(0, 1.9fr) minmax(360px, 1fr)',
        gap: mobile ? 20 : 28, alignItems: 'stretch',
        maxWidth: 1600, width: '100%', margin: '0 auto',
        padding: mobile ? '18px 16px 40px' : '22px 34px 30px',
      }}>
        <PackHero mobile={mobile} minting={pending} onCardList={() => setModal('cards')} onOdds={() => setModal('odds')} />
        <PurchasePanel
          stageIndex={stageIndex} tx={tx} priceEth={priceEth} hash={hash}
          connected={connected} onRobinhood={onRobinhood} switching={switching}
          errBox={errBox} account={account} copied={copied}
          onConnect={connect} onSwitch={doSwitch} onOpen={open}
          onAddFunds={copyAddr} onRetry={reset} mobile={mobile}
        />
      </div>

      {inReveal && cards.length > 0 && (
        <RevealOverlay cards={cards} tx={tx} setTx={setTx} onDone={reset} onAnother={() => { reset(); }} priceEth={priceEth} />
      )}

      {modal === 'cards' && <CardListModal onClose={() => setModal(null)} />}
      {modal === 'odds' && <OddsModal onClose={() => setModal(null)} />}
    </div>
  );
}

// ── Responsive hook ─────────────────────────────────────────────────────────
function useIsMobile() {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

// ── Vault backdrop (real CSS, not a screenshot) ─────────────────────────────
function VaultBackdrop() {
  return (
    <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, background:
        `radial-gradient(60% 50% at 50% 30%, rgba(124,92,255,0.18), transparent 70%),
         radial-gradient(45% 40% at 50% 100%, rgba(217,180,90,0.10), transparent 70%),
         radial-gradient(120% 100% at 50% 0%, #14122b 0%, #0a0a14 55%, #06060d 100%)` }} />
      {/* faint architectural pillars */}
      <div style={{ position: 'absolute', inset: 0, background:
        'repeating-linear-gradient(90deg, transparent 0 12%, rgba(150,140,190,0.04) 12% 12.4%, transparent 12.4% 24%)', opacity: 0.5 }} />
      {/* crystal glints */}
      {[[8, 62], [16, 40], [86, 58], [92, 36], [23, 78], [78, 80]].map(([l, t], i) => (
        <div key={i} style={{ position: 'absolute', left: `${l}%`, top: `${t}%`, width: 3, height: 26,
          background: 'linear-gradient(180deg, transparent, #b79cff, transparent)', opacity: 0.5,
          filter: 'blur(1px)', transform: `rotate(${i % 2 ? 18 : -14}deg)`, animation: `ova-pulse-ring ${3 + i}s ease-in-out infinite` }} />
      ))}
      {/* vignette */}
      <div style={{ position: 'absolute', inset: 0, boxShadow: 'inset 0 0 240px 60px rgba(0,0,0,0.85)' }} />
    </div>
  );
}

// ── Top navigation ──────────────────────────────────────────────────────────
function TopBar({ onBack, connected, onRobinhood, switching, account, copied, onCopy, muted, onToggleMute }: {
  onBack: () => void; connected: boolean; onRobinhood: boolean; switching: boolean;
  account: Address | null; copied: boolean; onCopy: () => void; muted: boolean; onToggleMute: () => void;
}) {
  const dot = switching ? '#f0d489' : !connected ? C.danger : onRobinhood ? C.success : '#f0a020';
  const netLabel = switching ? 'Switching…' : !connected ? 'Disconnected' : onRobinhood ? 'Robinhood Chain' : 'Wrong Network';
  return (
    <div style={{
      position: 'relative', zIndex: 5, display: 'flex', alignItems: 'center', gap: 14,
      padding: '12px 20px', background: 'rgba(8,7,18,0.55)', backdropFilter: 'blur(10px)',
      borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
        <Emblem size={30} />
        <div style={{ lineHeight: 1, display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontFamily: F.display, fontWeight: 700, fontSize: 11, letterSpacing: '0.18em', color: C.textMid }}>ON-CHAIN</span>
          <span style={{ fontFamily: F.display, fontWeight: 700, fontSize: 13, letterSpacing: '0.12em', color: C.goldHi }}>VIRTUAL ARENA</span>
        </div>
        <button onClick={onBack} style={{
          marginLeft: 10, background: 'none', border: 'none', color: C.textMid, cursor: 'pointer',
          fontWeight: 700, letterSpacing: '0.1em', fontSize: 12,
          display: 'inline-flex', alignItems: 'center', gap: 8,
        }}><ArrowLeft size={14} /> BOOSTER PACKS</button>
      </div>

      <div style={{ fontFamily: F.display, fontWeight: 700, letterSpacing: '0.28em', fontSize: 14,
        color: C.goldHi, textShadow: '0 0 18px rgba(217,180,90,0.4)', whiteSpace: 'nowrap',
        display: 'inline-flex', alignItems: 'center', gap: 12 }}>
        <DiamondOutline size={9} /> BOOSTER VAULT <DiamondOutline size={9} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'flex-end', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: R.pill,
          background: C.bg2, border: `1px solid ${C.border}` }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, boxShadow: `0 0 8px ${dot}` }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: C.textHi, whiteSpace: 'nowrap' }}>{netLabel}</span>
        </div>
        {account && (
          <button onClick={onCopy} title="Copy address" style={{ display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 12px', borderRadius: R.pill, background: C.bg2, border: `1px solid ${C.border}`,
            color: C.textHi, cursor: 'pointer', fontFamily: F.mono, fontSize: 12 }}>
            {shortAddr(account)}
            <span style={{ color: copied ? C.success : C.textMid, display: 'inline-flex' }}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </span>
          </button>
        )}
        <button onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'} style={{
          width: 36, height: 36, display: 'grid', placeItems: 'center', borderRadius: 9,
          background: C.bg2, border: `1px solid ${C.gold}55`, color: C.goldHi, cursor: 'pointer', fontSize: 15 }}>
          {muted ? <SoundOff size={16} /> : <SoundOn size={16} />}
        </button>
      </div>
    </div>
  );
}

function Emblem({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden>
      <defs>
        <linearGradient id="ova-emb" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f0d489" /><stop offset="1" stopColor="#b98f34" />
        </linearGradient>
      </defs>
      <path d="M50 6 L86 28 V72 L50 94 L14 72 V28 Z" stroke="url(#ova-emb)" strokeWidth="5" />
      <path d="M50 30 L66 42 L50 54 L34 42 Z" fill="url(#ova-emb)" />
      <path d="M50 56 L66 68 L50 80 L34 68 Z" fill="#7c5cff" opacity="0.85" />
    </svg>
  );
}

// ── Pack presentation (left column) ─────────────────────────────────────────
function PackHero({ mobile, minting, onCardList, onOdds }: { mobile: boolean; minting: boolean; onCardList: () => void; onOdds: () => void }) {
  return (
    <section style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', textAlign: 'center', minHeight: 0, gap: mobile ? 8 : 4 }}>
      <h1 style={{ margin: 0, fontFamily: F.display, fontWeight: 700, letterSpacing: '-0.01em',
        fontSize: mobile ? 34 : 'clamp(38px, 4.6vw, 64px)',
        background: 'linear-gradient(180deg, #f7e6b0, #d9b45a 55%, #a67c2e)',
        WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
        textShadow: '0 2px 30px rgba(217,180,90,0.25)', lineHeight: 1.02 }}>
        GENESIS BOOSTER
      </h1>
      <div style={{ color: C.textMid, fontSize: mobile ? 12 : 14, fontWeight: 600, letterSpacing: '0.14em' }}>
        5 RANDOM CARDS + 1 GUARANTEED FOIL
      </div>
      <div style={{ color: C.accentHi, fontSize: 12, letterSpacing: '0.12em', opacity: 0.9,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
        <DiamondOutline size={8} /> Minted on Robinhood Chain <DiamondOutline size={8} />
      </div>

      {/* Pack on a glowing violet pedestal. */}
      <div style={{ position: 'relative', display: 'grid', placeItems: 'center', margin: mobile ? '6px 0' : '4px 0', width: '100%' }}>
        <Pedestal />
        <div style={{ position: 'relative', zIndex: 2 }}>
          <Pack3D spinning={minting} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Benefit icon="cards" label="6 CARDS" />
        <Benefit icon="foil" label="1 FOIL GUARANTEED" />
        <Benefit icon="chain" label="ON-CHAIN MINT" />
      </div>

      <div style={{ display: 'flex', gap: 18, alignItems: 'center', marginTop: 4 }}>
        <button className="ova-linkbtn" onClick={onCardList}>VIEW CARD LIST</button>
        <span style={{ color: C.gold, opacity: 0.5, display: 'inline-flex' }}><DiamondOutline size={9} /></span>
        <button className="ova-linkbtn" onClick={onOdds}>VIEW ODDS</button>
      </div>
    </section>
  );
}

function Pedestal() {
  return (
    <div aria-hidden style={{ position: 'absolute', bottom: 4, left: '50%', transform: 'translateX(-50%)', zIndex: 1,
      width: 300, height: 300, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', bottom: 30, width: 280, height: 70, borderRadius: '50%',
        background: 'radial-gradient(closest-side, rgba(124,92,255,0.45), transparent 75%)', filter: 'blur(6px)' }} />
      <div style={{ position: 'absolute', bottom: 44, width: 220, height: 220, borderRadius: '50%',
        border: '1px solid rgba(124,92,255,0.45)', animation: 'ova-rune-spin 26s linear infinite',
        boxShadow: '0 0 40px rgba(124,92,255,0.25) inset' }} />
      <div style={{ position: 'absolute', bottom: 66, width: 150, height: 150, borderRadius: '50%',
        border: '1px dashed rgba(217,180,90,0.4)', animation: 'ova-rune-spin 18s linear infinite reverse' }} />
      {[10, 30, 50, 70, 90].map((l, i) => (
        <div key={i} style={{ position: 'absolute', bottom: 60, left: `${l}%`, width: 2, height: 2, borderRadius: '50%',
          background: '#cdb8ff', animation: `ova-particle ${3 + i * 0.6}s ease-in ${i * 0.4}s infinite` }} />
      ))}
    </div>
  );
}

function Benefit({ icon, label }: { icon: 'cards' | 'foil' | 'chain'; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderRadius: R.md,
      background: 'rgba(20,18,40,0.7)', border: `1px solid ${C.gold}33` }}>
      <BenefitIcon kind={icon} />
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: C.textHi }}>{label}</span>
    </div>
  );
}

function BenefitIcon({ kind }: { kind: 'cards' | 'foil' | 'chain' }) {
  const s = { width: 16, height: 16 };
  if (kind === 'cards') return <svg {...s} viewBox="0 0 24 24" fill="none" stroke={C.goldHi} strokeWidth="1.8"><rect x="4" y="6" width="11" height="14" rx="2" /><path d="M9 4h9a2 2 0 0 1 2 2v11" opacity=".6" /></svg>;
  if (kind === 'foil') return <svg {...s} viewBox="0 0 24 24" fill="none" stroke={C.goldHi} strokeWidth="1.8"><path d="M12 3l2.2 5.6L20 10l-5.8 1.4L12 17l-2.2-5.6L4 10l5.8-1.4z" /></svg>;
  return <svg {...s} viewBox="0 0 24 24" fill="none" stroke={C.goldHi} strokeWidth="1.8"><path d="M9 12a3 3 0 0 1 3-3h2a3 3 0 0 1 0 6h-1" /><path d="M15 12a3 3 0 0 1-3 3h-2a3 3 0 0 1 0-6h1" /></svg>;
}

// ── 3D pack (self-contained web component; can't crash React) ───────────────
const ModelViewer = 'model-viewer' as any;

/**
 * `<model-viewer>` used to arrive as a <script> tag pointing at jsDelivr, which
 * the production gateway's `script-src 'self'` CSP blocks. It is now a real
 * dependency, dynamically imported so its ~1MB (it ships its own copy of
 * three.js) lands in a separate chunk that only the Boosters screen pays for.
 * The import registers the custom element as a side effect.
 */
let modelViewerPromise: Promise<unknown> | null = null;
function loadModelViewer(): Promise<unknown> {
  if (typeof customElements !== 'undefined' && customElements.get('model-viewer')) {
    return Promise.resolve();
  }
  modelViewerPromise ??= (async () => {
    // <model-viewer> lazily pulls its DRACO decoder, KTX2 transcoder and
    // Lottie loader from www.gstatic.com / cdn.jsdelivr.net by default — a
    // <script>/wasm fetch that `default-src 'self'` would block. It reads
    // `self.ModelViewerElement` as a config bag when an element is
    // constructed, so pinning these to same-origin paths *before* the import
    // guarantees no third-party request can ever be issued.
    //
    // booster-pack.glb needs none of them (its extensionsRequired are
    // EXT_meshopt_compression / EXT_texture_webp / KHR_mesh_quantization), so
    // these directories are intentionally empty. If a future model does use
    // DRACO or KTX2, drop the decoder files from
    // node_modules/three/examples/jsm/libs/{draco,basis}/ into public/ at
    // these paths — do not point them back at a CDN.
    const g = globalThis as any;
    g.ModelViewerElement = {
      ...(g.ModelViewerElement ?? {}),
      dracoDecoderLocation: '/model-viewer/draco/',
      ktx2TranscoderLocation: '/model-viewer/basis/',
      lottieLoaderLocation: '/model-viewer/lottie-loader.js',
    };
    await import('@google/model-viewer');
  })().catch((err) => {
    modelViewerPromise = null;  // let a later mount retry
    throw err;
  });
  return modelViewerPromise;
}

function Pack3D({ spinning }: { spinning?: boolean }) {
  const ref = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // Only true once the custom element is registered; until then we render the
  // CSS fallback pack rather than an inert <model-viewer>.
  const [defined, setDefined] = useState(
    () => typeof customElements !== 'undefined' && !!customElements.get('model-viewer'),
  );

  useEffect(() => {
    if (defined) return;
    let cancelled = false;
    loadModelViewer().then(
      () => { if (!cancelled) setDefined(true); },
      () => { if (!cancelled) setFailed(true); },
    );
    return () => { cancelled = true; };
  }, [defined]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onLoad = () => setReady(true);
    const onErr = () => setFailed(true);
    el.addEventListener('load', onLoad);
    el.addEventListener('error', onErr);
    const t = setTimeout(() => { if (!el.loaded) setFailed((f) => f || !(el as any).modelIsVisible); }, 8000);
    return () => { el.removeEventListener('load', onLoad); el.removeEventListener('error', onErr); clearTimeout(t); };
  }, [defined]);

  return (
    <div style={{ position: 'relative', width: 320, height: 360, display: 'grid', placeItems: 'center' }}>
      {(!ready || failed) && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          <StaticPack spinning={spinning} loading={!failed} />
        </div>
      )}
      {!failed && defined && (
        <ModelViewer
          ref={ref}
          src="/booster-pack.glb?v=2"
          camera-controls auto-rotate
          rotation-per-second={spinning ? '150deg' : '30deg'}
          interaction-prompt="none" disable-zoom
          exposure="1.15" shadow-intensity="0.6"
          style={{ width: '100%', height: '100%', background: 'transparent', opacity: ready ? 1 : 0, transition: 'opacity .45s ease' }}
        />
      )}
    </div>
  );
}

function StaticPack({ spinning, loading }: { spinning?: boolean; loading?: boolean }) {
  return (
    <div style={{
      position: 'relative', width: 210, height: 290, borderRadius: 16, overflow: 'hidden',
      background: 'linear-gradient(155deg, #1a1140 0%, #4a2fa8 40%, #7c5cff 62%, #d9b45a 100%)',
      border: '1px solid rgba(240,212,137,0.5)', boxShadow: `${SH.lg}, 0 0 34px rgba(124,92,255,0.45)`,
      animation: spinning ? 'ova-pack-shake .5s ease-in-out infinite' : 'ova-float 5s ease-in-out infinite',
    }}>
      {/* crimped edges */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 10, background: 'repeating-linear-gradient(90deg,#0d0a1e 0 4px,#2a2150 4px 8px)' }} />
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 10, background: 'repeating-linear-gradient(90deg,#0d0a1e 0 4px,#2a2150 4px 8px)' }} />
      <div aria-hidden style={{ position: 'absolute', top: 0, bottom: 0, width: '45%',
        background: 'linear-gradient(100deg, transparent, rgba(255,255,255,0.5), transparent)', animation: 'ova-sheen 2.8s linear infinite' }} />
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16 }}>
        <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 12, letterSpacing: '0.26em', color: '#f0d489' }}>ON-CHAIN</div>
        <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 20, lineHeight: 1, color: '#fff', textAlign: 'center', textShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>VIRTUAL<br />ARENA</div>
        <div style={{ marginTop: 6, fontSize: 10, fontWeight: 800, letterSpacing: '0.24em', color: '#0d0a1e', background: 'rgba(240,212,137,0.9)', borderRadius: 6, padding: '4px 12px' }}>
          {loading ? 'LOADING…' : 'GENESIS'}
        </div>
      </div>
    </div>
  );
}

// ── Purchase / transaction panel (right column) ─────────────────────────────
function PurchasePanel(props: {
  stageIndex: number; tx: Tx; priceEth: string; hash: `0x${string}` | null;
  connected: boolean; onRobinhood: boolean; switching: boolean;
  errBox: ErrBox | null; account: Address | null; copied: boolean;
  onConnect: () => void; onSwitch: () => void; onOpen: () => void;
  onAddFunds: () => void; onRetry: () => void; mobile: boolean;
}) {
  const { stageIndex, tx, priceEth, hash, connected, onRobinhood, switching, errBox, account, copied,
    onConnect, onSwitch, onOpen, onAddFunds, onRetry, mobile } = props;
  const pending = tx === 'awaiting' || tx === 'confirming';

  return (
    <aside style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 16, height: '100%',
        padding: mobile ? 20 : 24, borderRadius: R.lg, background: 'linear-gradient(180deg, rgba(28,24,56,0.92), rgba(12,11,26,0.94))',
        border: `1px solid ${C.gold}55`, boxShadow: `${EDGE.topHighlight}, ${DEPTH.panelHi}, 0 0 50px -26px rgba(217,180,90,0.6)`, overflow: 'auto' }}>
        {/* ornate corners */}
        {['tl', 'tr', 'bl', 'br'].map((k) => <Corner key={k} pos={k as any} />)}

        <div style={{ textAlign: 'center', fontFamily: F.display, fontWeight: 700, letterSpacing: '0.14em',
          fontSize: 16, color: C.goldHi, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <Diamond size={9} /> OPEN A GENESIS PACK <Diamond size={9} />
        </div>

        <Stepper stageIndex={stageIndex} tx={tx} />

        {/* product row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: R.md,
          background: C.bg1, border: `1px solid ${C.border}` }}>
          <div style={{ width: 34, height: 44, borderRadius: 6, background: 'linear-gradient(160deg,#2a1b5e,#7c5cff)', border: '1px solid rgba(240,212,137,0.4)' }} />
          <div style={{ fontWeight: 700, fontSize: 14 }}>Genesis Booster</div>
        </div>

        <Row label="PACK PRICE" value={`${priceEth} ETH`} />
        <Row label="NETWORK" value={<span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <span style={{ fontWeight: 700 }}>Robinhood Chain</span>
          <span style={{ fontSize: 11, color: C.textLo }}>Chain {ROBINHOOD_CHAIN_ID}</span>
        </span>} />
        <div style={{ height: 1, background: C.border }} />
        <Row label="TOTAL" accent value={`${priceEth} ETH`} big />

        {/* Primary action — reflects the live state machine. */}
        {/* The purchase path is gated: the backend has no read endpoint for
            Robinhood Chain, so a mint could be paid for and never confirmed.
            See src/pack-evm.ts. A disabled button with a stated reason beats a
            live one that takes ETH and hangs on the reveal. */}
        {PACK_MINTING_AVAILABLE ? (
          <>
            <PrimaryAction
              tx={tx} connected={connected} onRobinhood={onRobinhood} switching={switching} pending={pending}
              priceEth={priceEth} onConnect={onConnect} onSwitch={onSwitch} onOpen={onOpen}
            />
            <div style={{ textAlign: 'center', fontSize: 11, color: C.textLo }}>
              {pending ? 'You can safely wait — leaving this page won’t cancel the mint.' : 'Wallet confirmation required · Network fee not included'}
            </div>
          </>
        ) : (
          <ComingSoonNotice />
        )}

        {(tx === 'confirming') && hash && <PendingHash hash={hash} />}

        {errBox && (
          <ErrorCard box={errBox} account={account} copied={copied}
            onAddFunds={onAddFunds} onRetry={onRetry} onSwitch={onSwitch} />
        )}
      </div>
    </aside>
  );
}

function Corner({ pos }: { pos: 'tl' | 'tr' | 'bl' | 'br' }) {
  const base: React.CSSProperties = { position: 'absolute', width: 18, height: 18, borderColor: `${C.gold}88`, borderStyle: 'solid', borderWidth: 0 };
  const map: Record<string, React.CSSProperties> = {
    tl: { top: 6, left: 6, borderTopWidth: 2, borderLeftWidth: 2, borderTopLeftRadius: 6 },
    tr: { top: 6, right: 6, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: 6 },
    bl: { bottom: 6, left: 6, borderBottomWidth: 2, borderLeftWidth: 2, borderBottomLeftRadius: 6 },
    br: { bottom: 6, right: 6, borderBottomWidth: 2, borderRightWidth: 2, borderBottomRightRadius: 6 },
  };
  return <div aria-hidden style={{ ...base, ...map[pos] }} />;
}

function Stepper({ stageIndex, tx }: { stageIndex: number; tx: Tx }) {
  const steps = ['PURCHASE', 'MINT', 'REVEAL'];
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px' }}>
      {steps.map((s, i) => {
        const done = i < stageIndex || (i === stageIndex && tx === 'complete' && i === 2);
        const active = i === stageIndex && !done;
        return (
          <div key={s} style={{ display: 'flex', alignItems: 'center', flex: i < 2 ? 1 : 'none' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 30, height: 30, borderRadius: '50%', display: 'grid', placeItems: 'center',
                fontWeight: 800, fontSize: 13,
                background: done ? C.success : active ? C.accent : C.bg2,
                color: done || active ? '#fff' : C.textLo,
                border: `1px solid ${done ? C.success : active ? C.accentHi : C.border}`,
                boxShadow: active ? `0 0 14px ${C.accent}88` : 'none' }}>
                {done ? <Check size={15} /> : i + 1}
              </div>
              <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em', color: active ? C.textHi : C.textLo }}>{s}</span>
            </div>
            {i < 2 && <div style={{ flex: 1, height: 2, margin: '0 6px', marginBottom: 16,
              background: i < stageIndex ? C.success : C.border }} />}
          </div>
        );
      })}
    </div>
  );
}

function Row({ label, value, accent, big }: { label: string; value: React.ReactNode; accent?: boolean; big?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', color: accent ? C.accentHi : C.textMid }}>{label}</span>
      <span style={{ fontSize: big ? 22 : 15, fontWeight: 800, color: accent ? C.accentHi : C.textHi, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

/**
 * Shown in place of the buy button while pack minting is off.
 *
 * Two separate things are unavailable and the copy says so plainly rather than
 * implying a date:
 *   • this EVM pack contract has no read path through the backend's RPC proxy
 *     (src/pack-evm.ts);
 *   • the backend's own booster tickets never mint an NFT either —
 *     `GET /wager/boosters/supply` reports `mintingEnabled: false`
 *     (INTEGRATION.md §7).
 */
function ComingSoonNotice() {
  return (
    <div style={{
      padding: '16px 18px', borderRadius: R.md,
      background: C.bg1, border: `1px dashed ${C.accent}66`,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 9,
        fontFamily: F.serif, fontWeight: 700, fontSize: 13.5, letterSpacing: '0.16em',
        textTransform: 'uppercase', color: C.accentHi,
      }}><Warning size={15} /> Packs coming soon</div>
      <div style={{ fontSize: 12.5, color: C.textMid, marginTop: 8, lineHeight: 1.6 }}>
        {PACK_MINTING_UNAVAILABLE_MESSAGE}
      </div>
      <div style={{ fontSize: 12.5, color: C.textLo, marginTop: 8, lineHeight: 1.6 }}>
        Booster tickets on the new backend do not mint an NFT yet either, so
        nothing here would arrive in your wallet. The card list and pull rates
        below are real and final — you just cannot buy in yet.
      </div>
    </div>
  );
}

function PrimaryAction({ tx, connected, onRobinhood, switching, pending, priceEth, onConnect, onSwitch, onOpen }: {
  tx: Tx; connected: boolean; onRobinhood: boolean; switching: boolean; pending: boolean;
  priceEth: string; onConnect: () => void; onSwitch: () => void; onOpen: () => void;
}) {
  let label: string; let onClick: () => void; let disabled = false;
  if (!connected) { label = 'CONNECT WALLET'; onClick = onConnect; }
  else if (switching) { label = 'SWITCHING NETWORK…'; onClick = () => {}; disabled = true; }
  else if (!onRobinhood) { label = 'SWITCH TO ROBINHOOD CHAIN'; onClick = onSwitch; }
  else if (tx === 'awaiting') { label = 'CONFIRM IN WALLET…'; onClick = () => {}; disabled = true; }
  else if (tx === 'confirming') { label = 'MINTING PACK…'; onClick = () => {}; disabled = true; }
  else if (tx === 'insufficient') { label = `OPEN PACK · ${priceEth} ETH`; onClick = () => {}; disabled = true; }
  else { label = `OPEN PACK · ${priceEth} ETH`; onClick = onOpen; }

  return (
    <button onClick={onClick} disabled={disabled} style={{
      position: 'relative', width: '100%', padding: '16px 18px', borderRadius: R.md, cursor: disabled ? 'not-allowed' : 'pointer',
      fontFamily: F.serif, fontWeight: 700, fontSize: 15, letterSpacing: '0.16em', textTransform: 'uppercase',
      color: disabled ? 'rgba(240,230,201,0.42)' : '#22190a',
      background: disabled ? SURF.goldPlateDead : SURF.goldPlate,
      border: `1px solid ${disabled ? '#4a4230' : EDGE.bronze}`,
      textShadow: disabled ? 'none' : '0 1px 0 rgba(255,255,255,0.28)',
      boxShadow: disabled ? 'inset 0 1px 0 rgba(255,255,255,0.06)' : `${EDGE.bevel}, ${DEPTH.goldGlow}`,
      transition: 'transform 160ms cubic-bezier(0.2,0.8,0.2,1), box-shadow 180ms ease, background 180ms ease',
      overflow: 'hidden', filter: disabled ? 'saturate(0.45)' : undefined,
    }}
      onMouseEnter={(e) => { if (!disabled) { const el = e.currentTarget as HTMLButtonElement; el.style.background = SURF.goldPlateHot; el.style.boxShadow = `${EDGE.bevel}, ${DEPTH.goldGlowHot}`; el.style.transform = 'translateY(-1px)'; } }}
      onMouseDown={(e) => { if (!disabled) { const el = e.currentTarget as HTMLButtonElement; el.style.transform = 'translateY(1px)'; el.style.boxShadow = `${EDGE.bevelSunk}, 0 2px 8px -4px rgba(217,180,90,0.5)`; } }}
      onMouseUp={(e) => { if (!disabled) { const el = e.currentTarget as HTMLButtonElement; el.style.transform = 'translateY(-1px)'; el.style.boxShadow = `${EDGE.bevel}, ${DEPTH.goldGlowHot}`; } }}
      onMouseLeave={(e) => { const el = e.currentTarget as HTMLButtonElement; el.style.transform = 'none'; el.style.background = disabled ? SURF.goldPlateDead : SURF.goldPlate; el.style.boxShadow = disabled ? 'inset 0 1px 0 rgba(255,255,255,0.06)' : `${EDGE.bevel}, ${DEPTH.goldGlow}`; }}
    >
      {pending && <span aria-hidden style={{ position: 'absolute', top: 0, bottom: 0, width: '40%',
        background: 'linear-gradient(100deg, transparent, rgba(255,255,255,0.35), transparent)', animation: 'ova-sheen 1.4s linear infinite' }} />}
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
        <Diamond size={9} /> {label} <Diamond size={9} />
      </span>
    </button>
  );
}

function PendingHash({ hash }: { hash: `0x${string}` }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(hash); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch {} };
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      padding: '9px 12px', borderRadius: R.md, background: C.bg1, border: `1px solid ${C.accent}44` }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: C.textMid }}>TX HASH</span>
      <button onClick={copy} title="Copy transaction hash" style={{ display: 'flex', alignItems: 'center', gap: 8,
        background: 'none', border: 'none', color: C.textHi, cursor: 'pointer', fontFamily: F.mono, fontSize: 12 }}>
        {shortAddr(hash)} <span style={{ color: copied ? C.success : C.textMid, display: 'inline-flex' }}>{copied ? <Check size={13} /> : <Copy size={13} />}</span>
      </button>
    </div>
  );
}

function ErrorCard({ box, account, copied, onAddFunds, onRetry, onSwitch }: {
  box: ErrBox; account: Address | null; copied: boolean;
  onAddFunds: () => void; onRetry: () => void; onSwitch: () => void;
}) {
  const [showDiag, setShowDiag] = useState(false);
  return (
    <div style={{ padding: 14, borderRadius: R.md, background: 'rgba(255,107,107,0.08)', border: `1px solid ${C.danger}66` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ color: C.danger, display: 'inline-flex' }}><Warning size={17} /></span>
        <span style={{ fontWeight: 800, letterSpacing: '0.08em', color: C.danger, fontSize: 14 }}>{box.heading}</span>
      </div>
      <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.5 }}>{box.message}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        {box.kind === 'insufficient' && (
          <button onClick={onAddFunds} style={{ padding: '9px 16px', borderRadius: R.sm, background: C.danger, color: '#fff',
            border: 'none', fontWeight: 800, letterSpacing: '0.06em', fontSize: 12, cursor: 'pointer' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              {copied ? <>ADDRESS COPIED <Check size={13} /></> : 'ADD FUNDS'}
            </span>
          </button>
        )}
        {box.kind === 'wrong_network' && (
          <button onClick={onSwitch} style={{ padding: '9px 16px', borderRadius: R.sm, background: C.accent, color: '#fff',
            border: 'none', fontWeight: 800, letterSpacing: '0.06em', fontSize: 12, cursor: 'pointer' }}>SWITCH NETWORK</button>
        )}
        <button onClick={onRetry} style={{ background: 'none', border: 'none', color: C.textHi, fontWeight: 700,
          letterSpacing: '0.06em', fontSize: 12, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }}>TRY AGAIN</button>
      </div>
      {box.kind === 'insufficient' && account && (
        <div style={{ marginTop: 8, fontSize: 11, color: C.textLo, lineHeight: 1.5 }}>
          No on-ramp is built in. Send ETH on Robinhood Chain to your address: <span style={{ fontFamily: F.mono, color: C.textMid }}>{shortAddr(account)}</span>
        </div>
      )}
      {box.detail && (
        <div style={{ marginTop: 8 }}>
          <button onClick={() => setShowDiag((v) => !v)} style={{ background: 'none', border: 'none', color: C.textLo,
            fontSize: 11, cursor: 'pointer', textDecoration: 'underline' }}>{showDiag ? 'Hide' : 'Show'} diagnostics</button>
          {showDiag && <div style={{ marginTop: 6, padding: 8, borderRadius: 6, background: '#00000055',
            fontFamily: F.mono, fontSize: 10.5, color: C.textLo, wordBreak: 'break-word', maxHeight: 120, overflow: 'auto' }}>{box.detail}</div>}
        </div>
      )}
    </div>
  );
}

// ── Reveal overlay ──────────────────────────────────────────────────────────
function RevealOverlay({ cards, tx, setTx, onDone, onAnother, priceEth }: {
  cards: RevealedCard[]; tx: Tx; setTx: (t: Tx) => void; onDone: () => void; onAnother: () => void; priceEth: string;
}) {
  const [flipped, setFlipped] = useState<boolean[]>(() => cards.map(() => false));
  const [focus, setFocus] = useState(0);
  const [burst, setBurst] = useState<number | null>(null);

  // Reveal order: non-foils first, the guaranteed foil last (strongest finish).
  const order = cards.map((_, i) => i).sort((a, b) => (cards[a].foil ? 1 : 0) - (cards[b].foil ? 1 : 0));

  const revealAt = useCallback((idx: number) => {
    setFlipped((prev) => { if (prev[idx]) return prev; const n = [...prev]; n[idx] = true; return n; });
    setFocus(idx);
    if (cards[idx]?.foil) setBurst(idx);
  }, [cards]);

  const revealNext = useCallback(() => {
    const next = order.find((i) => !flipped[i]);
    if (next != null) revealAt(next);
  }, [order, flipped, revealAt]);

  const revealAll = useCallback(() => {
    order.forEach((i, k) => setTimeout(() => revealAt(i), k * 220));
  }, [order, revealAt]);

  const skip = useCallback(() => { setFlipped(cards.map(() => true)); const foil = cards.findIndex((c) => c.foil); if (foil >= 0) setBurst(foil); }, [cards]);

  // Sync tx stage with reveal progress.
  useEffect(() => {
    const done = flipped.length === cards.length && flipped.every(Boolean);
    const any = flipped.some(Boolean);
    if (done && tx !== 'complete') setTx('complete');
    else if (any && !done && tx !== 'revealing') setTx('revealing');
  }, [flipped, cards.length, tx, setTx]);

  // Keyboard controls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); revealNext(); }
      else if (e.key === 'ArrowRight') setFocus((f) => Math.min(cards.length - 1, f + 1));
      else if (e.key === 'ArrowLeft') setFocus((f) => Math.max(0, f - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [revealNext, cards.length]);

  const allDone = flipped.every(Boolean);
  const n = cards.length;

  // Ownership is recorded server-side from the chain, and indexing lags the
  // receipt slightly. Say which state we are in rather than leaving the player
  // wondering whether the pack "counted".
  const collection = useCollection();
  const ownershipNote = collection.pendingCount > 0
    ? 'Confirming ownership on-chain — your cards are minted and will appear in your collection shortly.'
    : collection.source === 'signed-out'
      ? null
      : 'Ownership confirmed — these cards are in your collection.';

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 22, padding: 20,
      background: 'radial-gradient(60% 60% at 50% 40%, rgba(20,16,44,0.86), rgba(4,4,10,0.96))', backdropFilter: 'blur(6px)' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 'clamp(22px,3.4vw,34px)', color: C.goldHi,
          letterSpacing: '0.06em', textShadow: '0 0 26px rgba(217,180,90,0.4)' }}>
          {allDone ? 'YOUR GENESIS PULL' : 'GENESIS PACK OPENED'}
        </div>
        <div style={{ color: C.textMid, fontSize: 13, marginTop: 4 }}>
          {allDone ? `${n} cards minted to your wallet` : 'Reveal your cards — the foil comes last.'}
        </div>
        {allDone && ownershipNote && (
          <div role="status" style={{ color: collection.pendingCount > 0 ? C.textLo : C.textMid, fontSize: 11.5, marginTop: 6,
            display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
            <span aria-hidden style={{ display: 'inline-flex', color: collection.pendingCount > 0 ? C.gold : C.textLo }}>
              {collection.pendingCount > 0 ? <Hourglass size={12} /> : <Check size={12} />}
            </span>
            {ownershipNote}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 1100, perspective: 1200 }}>
        {cards.map((c, i) => (
          <RevealCard key={i} card={c} flipped={flipped[i]} focused={focus === i} burst={burst === i}
            arc={(i - (n - 1) / 2) * 4} onClick={() => (flipped[i] ? setFocus(i) : revealAt(i))} onFocus={() => setFocus(i)} />
        ))}
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        {!allDone ? (
          <>
            <OverlayBtn onClick={revealNext} variant="primary">REVEAL NEXT</OverlayBtn>
            <OverlayBtn onClick={revealAll}>REVEAL ALL</OverlayBtn>
            <OverlayBtn onClick={skip} subtle>SKIP ANIMATION</OverlayBtn>
          </>
        ) : (
          <>
            <OverlayBtn onClick={onAnother} variant="primary">OPEN ANOTHER · {priceEth} ETH</OverlayBtn>
            <OverlayBtn onClick={onDone}>DONE</OverlayBtn>
          </>
        )}
      </div>
    </div>
  );
}

function OverlayBtn({ children, onClick, variant, subtle }: { children: React.ReactNode; onClick: () => void; variant?: 'primary'; subtle?: boolean }) {
  const primary = variant === 'primary';
  return (
    <button onClick={onClick} style={{
      padding: '12px 22px', borderRadius: R.md, cursor: 'pointer', fontFamily: F.display, fontWeight: 800,
      letterSpacing: '0.08em', fontSize: 13,
      color: primary ? '#20170a' : subtle ? C.textLo : C.textHi,
      background: primary ? 'linear-gradient(180deg,#f7e6b0,#d9b45a 55%,#b98f34)' : subtle ? 'transparent' : C.bg2,
      border: primary ? '1px solid #8a6d24' : `1px solid ${subtle ? 'transparent' : C.border}`,
      boxShadow: primary ? '0 8px 24px rgba(217,180,90,0.4)' : 'none',
    }}>{children}</button>
  );
}

function RevealCard({ card, flipped, focused, burst, arc, onClick, onFocus }: {
  card: RevealedCard; flipped: boolean; focused: boolean; burst: boolean; arc: number; onClick: () => void; onFocus: () => void;
}) {
  const chainColor = CARDS[card.id]?.color;
  const chainHex = (chainColor && COLOR_META[chainColor]?.hex) || C.accent;
  return (
    <div
      role="button" tabIndex={0}
      onClick={onClick} onFocus={onFocus} onMouseEnter={onFocus}
      onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onClick(); } }}
      className={`ova-flip ${flipped ? 'is-flipped' : ''}`}
      style={{ position: 'relative', width: 128, height: 178, cursor: 'pointer', outline: 'none',
        transform: `rotate(${flipped ? 0 : arc}deg) translateY(${focused && flipped ? -14 : 0}px) scale(${focused && flipped ? 1.08 : 1})`,
        transition: 'transform .3s cubic-bezier(.2,.8,.2,1)', zIndex: focused ? 3 : 1 }}>
      {burst && <div aria-hidden style={{ position: 'absolute', inset: -20, borderRadius: '50%', pointerEvents: 'none',
        background: 'radial-gradient(closest-side, rgba(240,212,137,0.9), transparent 70%)', animation: 'ova-burst .8s ease-out forwards' }} />}
      <div className="ova-flip-inner">
        {/* back (face down) */}
        <div className="ova-flip-face" style={{ background: 'linear-gradient(160deg,#1a1140,#3a2a80)', border: `1px solid ${C.gold}55`,
          display: 'grid', placeItems: 'center' }}>
          <Emblem size={54} />
        </div>
        {/* front */}
        <div className="ova-flip-face ova-flip-back" style={{ padding: 8, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 6,
          background: card.foil ? 'linear-gradient(135deg,#2a1b5e,#7c5cff 45%,#d9b45a)' : `linear-gradient(160deg,${C.bg2},${C.bg1})`,
          border: `1px solid ${card.foil ? '#f0d489' : C.border}`,
          boxShadow: card.foil ? '0 0 26px rgba(217,180,90,0.6)' : SH.md }}>
          {card.foil && <div aria-hidden style={{ position: 'absolute', top: 0, bottom: 0, width: '45%',
            background: 'linear-gradient(100deg, transparent, rgba(255,255,255,0.5), transparent)', animation: 'ova-sheen 2.2s linear infinite' }} />}
          {card.image
            ? <img src={card.image} alt={card.name} style={{ width: '100%', height: '64%', objectFit: 'contain', zIndex: 1, filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.5))' }} />
            /* Nothing else on this reveal names the chain, so the logo carries
               it and takes a real alt. Unknown ids keep the old colour blob. */
            : chainColor
              ? <ChainLogo color={chainColor} size={72} alt={COLOR_META[chainColor].name} style={{ zIndex: 1 }} />
              : <div style={{ width: '66%', height: '60%', borderRadius: 10, background: `radial-gradient(circle at 50% 40%, ${chainHex}, transparent 70%)`, zIndex: 1 }} />}
          <div style={{ fontSize: 11, fontWeight: 700, color: '#fff', textAlign: 'center', lineHeight: 1.15, zIndex: 1 }}>{card.name}</div>
          {card.foil && <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.2em', color: '#ffe9a8', zIndex: 1, display: 'flex', alignItems: 'center', gap: 5 }}><Star size={9} /> FOIL</div>}
        </div>
      </div>
    </div>
  );
}

// ── Card list + odds modals (real catalogue data) ───────────────────────────
function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 210, display: 'grid', placeItems: 'center',
      background: 'rgba(4,4,10,0.8)', backdropFilter: 'blur(4px)', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(720px, 100%)', maxHeight: '82dvh', overflow: 'auto',
        background: C.bg1, border: `1px solid ${C.gold}44`, borderRadius: R.lg, padding: 22, boxShadow: SH.lg }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontFamily: F.display, fontWeight: 700, letterSpacing: '0.1em', color: C.goldHi, fontSize: 17 }}>{title}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textMid, fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CardListModal({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell title={`CARD LIST · ${CATALOG.length} CARDS`} onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px,1fr))', gap: 10 }}>
        {CATALOG.map((c) => {
          const hex = (COLOR_META[c.color]?.hex) || C.accent;
          return (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: R.sm,
              background: C.bg2, border: `1px solid ${C.border}` }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: hex, flex: 'none' }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: C.textHi, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
}

function OddsModal({ onClose }: { onClose: () => void }) {
  const n = CATALOG.length;
  const pct = n ? (100 / n).toFixed(2) : '0';
  return (
    <ModalShell title="PACK ODDS" onClose={onClose}>
      <div style={{ fontSize: 14, color: C.textMid, lineHeight: 1.7 }}>
        <p style={{ marginTop: 0 }}>Every Genesis Booster mints <b style={{ color: C.textHi }}>6 cards</b> on-chain:</p>
        <ul style={{ paddingLeft: 18, margin: '8px 0' }}>
          <li><b style={{ color: C.textHi }}>5 base slots</b> — each an independent draw from all <b style={{ color: C.textHi }}>{n}</b> cards, so any specific card has a <b style={{ color: C.accentHi }}>{pct}%</b> chance per slot.</li>
          <li><b style={{ color: C.goldHi }}>1 guaranteed foil slot</b> — always a foil, drawn the same equal-chance way from the full set.</li>
        </ul>
        <p style={{ color: C.textLo, fontSize: 12, marginBottom: 0 }}>
          Draws use the contract's on-chain randomness at mint time. No card is more or less likely than another; the only guarantee is that slot six is always foil.
        </p>
      </div>
    </ModalShell>
  );
}

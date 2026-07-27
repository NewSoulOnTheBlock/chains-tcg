// src/Boosters.tsx
// Booster Packs — a clean, self-contained pack-opening experience for On-Chain
// Virtual Arena. Buying a pack mints 5 random cards + 1 foil random card as NFTs
// on Robinhood Chain (CardPack contract). Built on the shared design tokens.

import { useEffect, useState, Suspense, Component, type ReactNode } from 'react';
import { Canvas } from '@react-three/fiber';
import { useGLTF, OrbitControls, Center, Bounds } from '@react-three/drei';
import { color as C, font as F, radius as R, shadow as SH } from './theme';
import { Button } from './ui';
import { detectEvmWallet } from './wallet';
import { CARDS, COLOR_META } from './cards';
import { mintPack, fetchPackPrice, PACK_PRICE_ETH, type RevealedCard } from './pack-evm';
import { formatEther } from 'viem';

type Phase = 'idle' | 'minting' | 'revealed';

const CSS = `
@keyframes ova-pack-float { 0%,100%{transform:translateY(0) rotate(-1deg)} 50%{transform:translateY(-12px) rotate(1deg)} }
@keyframes ova-pack-shake { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-6px) rotate(-2deg)} 40%{transform:translateX(6px) rotate(2deg)} 60%{transform:translateX(-4px)} 80%{transform:translateX(4px)} }
@keyframes ova-sheen { 0%{transform:translateX(-120%)} 100%{transform:translateX(220%)} }
@keyframes ova-pop { from{opacity:0; transform:translateY(14px) scale(0.9)} to{opacity:1; transform:translateY(0) scale(1)} }
@keyframes ova-foil-hue { 0%{filter:hue-rotate(0deg)} 100%{filter:hue-rotate(360deg)} }
.ova-reveal { animation: ova-pop .5s cubic-bezier(.2,.8,.2,1) both; }
`;

export function BoostersPage({ myName, onBack }: { myName: string; onBack: () => void }) {
  void myName;
  const [phase, setPhase] = useState<Phase>('idle');
  const [cards, setCards] = useState<RevealedCard[]>([]);
  const [err, setErr] = useState('');
  const [priceEth, setPriceEth] = useState(PACK_PRICE_ETH);
  const evm = detectEvmWallet();

  useEffect(() => {
    fetchPackPrice().then(w => setPriceEth(formatEther(w))).catch(() => {});
  }, []);

  async function open() {
    if (!evm.installed) { window.open('https://metamask.io/download/', '_blank', 'noopener'); return; }
    setErr(''); setCards([]); setPhase('minting');
    try {
      const pulled = await mintPack();
      setCards(pulled);
      setPhase('revealed');
    } catch (e: any) {
      setErr(String(e?.shortMessage || e?.message || e));
      setPhase('idle');
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'auto', background: C.bg0, color: C.textHi, fontFamily: F.body }}>
      <style>{CSS}</style>
      {/* ambient */}
      <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none',
        background: `radial-gradient(70% 55% at 50% 18%, ${C.accentDim}, transparent 70%),
          radial-gradient(50% 40% at 50% 100%, rgba(217,180,90,0.10), transparent 70%)` }} />

      {/* header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 5, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 20px', background: 'rgba(10,10,20,0.6)', backdropFilter: 'blur(10px)', borderBottom: `1px solid ${C.border}` }}>
        <Button variant="ghost" onClick={onBack}>← Back</Button>
        <div style={{ fontFamily: F.display, fontWeight: 700, letterSpacing: '0.02em', fontSize: 16 }}>Booster Packs</div>
        <div style={{ width: 64 }} />
      </div>

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 920, margin: '0 auto', padding: '32px 18px 90px', textAlign: 'center' }}>
        {phase !== 'revealed' && (
          <>
            <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 'clamp(26px,5vw,40px)', letterSpacing: '-0.01em' }}>Genesis Booster</div>
            <div style={{ color: C.textMid, fontSize: 14, marginTop: 6 }}>5 random cards + 1 guaranteed foil · minted on Robinhood Chain</div>

            {/* 3D pack — isolated so a WebGL/GLB failure can never blank the page. */}
            <div style={{ display: 'grid', placeItems: 'center', margin: '14px 0 20px', minHeight: 380 }}>
              <PackErrorBoundary fallback={<StaticPack spinning={phase === 'minting'} />}>
                <Suspense fallback={<StaticPack spinning={phase === 'minting'} loading />}>
                  <Pack3D spinning={phase === 'minting'} />
                </Suspense>
              </PackErrorBoundary>
            </div>

            <Button variant="primary" onClick={open} disabled={phase === 'minting'}
              style={{ minWidth: 240, padding: '15px 24px', fontSize: 16 }}>
              {phase === 'minting' ? 'Ripping the foil…' : (evm.installed ? `Open Pack · ${(+priceEth).toFixed(4)} ETH` : 'Install MetaMask')}
            </Button>
            <div style={{ color: C.textLo, fontSize: 12, marginTop: 12 }}>
              {phase === 'minting' ? 'Confirm in your wallet — minting 6 NFTs…' : 'Pays in ETH on Robinhood Chain (chain 4663).'}
            </div>
            {err && <div style={{ marginTop: 14, color: C.danger, fontSize: 13 }}>{err}</div>}
          </>
        )}

        {phase === 'revealed' && (
          <>
            <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 'clamp(24px,5vw,36px)' }}>Your Pull</div>
            <div style={{ color: C.textMid, fontSize: 13, marginTop: 6 }}>6 cards minted to your wallet</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 14, margin: '26px 0 30px' }}>
              {cards.map((c, i) => <CardTile key={i} card={c} delay={i * 90} />)}
            </div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Button variant="primary" onClick={open} style={{ minWidth: 200 }}>Open Another · {(+priceEth).toFixed(4)} ETH</Button>
              <Button variant="secondary" onClick={() => { setPhase('idle'); setCards([]); }}>Done</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PackModel() {
  // The GLB is meshopt-compressed; args enable DRACO + Meshopt decoders in drei.
  const { scene } = useGLTF('/booster-pack.glb?v=2', true, true);
  return <primitive object={scene} />;
}

function Pack3D({ spinning }: { spinning?: boolean }) {
  return (
    <Canvas camera={{ position: [0, 0, 3.4], fov: 42 }} dpr={[1, 2]} style={{ width: 340, height: 380 }}>
      <ambientLight intensity={0.75} />
      <directionalLight position={[4, 6, 5]} intensity={1.5} />
      <directionalLight position={[-5, -1, -4]} intensity={0.55} color="#9d86ff" />
      {/* No inner <Suspense>: the model's loading state bubbles to the DOM-level
          <Suspense> so we can show the styled StaticPack while the GLB downloads. */}
      <Bounds fit clip observe margin={1.15}>
        <Center><PackModel /></Center>
      </Bounds>
      <OrbitControls enableZoom={false} enablePan={false} autoRotate autoRotateSpeed={spinning ? 9 : 1.8} />
    </Canvas>
  );
}

/** Styled CSS booster pack — shown while the 3D model loads and if WebGL/GLB fails. */
function StaticPack({ spinning, loading }: { spinning?: boolean; loading?: boolean }) {
  return (
    <div style={{
      position: 'relative', width: 220, height: 300, borderRadius: 18, overflow: 'hidden',
      background: 'linear-gradient(150deg, #2a1b5e 0%, #7c5cff 42%, #d9b45a 100%)',
      border: '1px solid rgba(255,255,255,0.25)', boxShadow: `${SH.lg}, ${SH.glow}`,
      animation: spinning ? 'ova-pack-shake .5s ease-in-out infinite' : 'ova-pack-float 5s ease-in-out infinite',
    }}>
      <div aria-hidden style={{ position: 'absolute', top: 0, bottom: 0, width: '45%',
        background: 'linear-gradient(100deg, transparent, rgba(255,255,255,0.5), transparent)', animation: 'ova-sheen 2.8s linear infinite' }} />
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 16 }}>
        <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 13, letterSpacing: '0.28em', color: '#0d0a1e' }}>ON-CHAIN</div>
        <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 22, lineHeight: 1, color: '#fff', textShadow: '0 2px 8px rgba(0,0,0,0.5)', textAlign: 'center' }}>VIRTUAL<br />ARENA</div>
        <div style={{ marginTop: 8, fontSize: 10, fontWeight: 800, letterSpacing: '0.2em', color: '#0d0a1e', background: 'rgba(255,255,255,0.55)', borderRadius: 999, padding: '4px 10px' }}>
          {loading ? 'LOADING 3D…' : 'GENESIS SET'}
        </div>
      </div>
    </div>
  );
}

class PackErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { console.warn('[boosters] 3D pack failed, using fallback:', e); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function CardTile({ card, delay }: { card: RevealedCard; delay: number }) {
  const chainHex = (CARDS[card.id]?.color && COLOR_META[CARDS[card.id].color]?.hex) || C.accent;
  return (
    <div className="ova-reveal" style={{ animationDelay: `${delay}ms` }}>
      <div style={{
        position: 'relative', borderRadius: R.md, overflow: 'hidden', padding: 10,
        aspectRatio: '3 / 4', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
        background: card.foil
          ? 'linear-gradient(135deg, #2a1b5e, #7c5cff 45%, #d9b45a)'
          : `linear-gradient(160deg, ${C.bg2}, ${C.bg1})`,
        border: `1px solid ${card.foil ? '#f0d489' : C.border}`,
        boxShadow: card.foil ? '0 0 26px rgba(217,180,90,0.55)' : SH.md,
      }}>
        {card.foil && (
          <div aria-hidden style={{ position: 'absolute', top: 0, bottom: 0, width: '45%',
            background: 'linear-gradient(100deg, transparent, rgba(255,255,255,0.45), transparent)',
            animation: 'ova-sheen 2.4s linear infinite' }} />
        )}
        {card.image
          ? <img src={card.image} alt={card.name} style={{ width: '100%', height: '62%', objectFit: 'contain', filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.5))', zIndex: 1 }} />
          : <div style={{ width: '68%', height: '62%', borderRadius: 10, background: `radial-gradient(circle at 50% 40%, ${chainHex}, transparent 70%)`, zIndex: 1 }} />}
        <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', textAlign: 'center', zIndex: 1, lineHeight: 1.15 }}>{card.name}</div>
        {card.foil && <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.2em', color: '#ffe9a8', zIndex: 1 }}>✦ FOIL</div>}
      </div>
    </div>
  );
}

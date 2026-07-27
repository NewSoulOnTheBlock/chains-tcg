// src/masterquest/MasterquestPage.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Memetic Masterquest — campaign mode UI.
//
// Renders a 100×100 SVG map of all 15 Sacred Sites arranged in three
// concentric rings (one per Act), with travel paths between consecutive
// sites. Visited sites glow; the current site pulses; locked sites are dim.
//
// Click the current site -> interlude modal (pre-fight lore + "BEGIN DUEL").
// Click a cleared site -> re-read modal (post-fight lore).
// On duel victory -> post-fight interlude + "TRAVEL ONWARD" -> unlock next.
// After Site 15 -> EPILOGUE.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { SoloClient } from '../SoloClient';
import type { Color } from '../cards';
import { validateDeck } from '../cards';
import { listDecksApi, type DeckEntry } from '../profiles';
import {
  PROLOGUE, ACTS, SITES, EPILOGUE, INTERLUDES,
  mapPosOf, MAP_VIEWBOX, type SacredSite, type SiteId, type Interlude,
} from './lore';
import {
  ArrowLeft, ArrowRight, Check, Refresh, Warning, Wizard, Map as MapIcon,
  Diamond, DiamondOutline, Swords, Cards,
} from '../icons';
import {
  loadProgress, recordClear, markEpilogueSeen,
  isCleared, isUnlocked, currentSiteId, isQuestComplete,
  clearProgress, type Progress,
} from './progress';

// ── Chain -> colour palette (matches the rest of the game) ──────────────────
const CHAIN_HEX: Record<Color, string> = {
  bnb:       '#f3ba2f', // yellow
  sol:       '#9945ff', // violet
  eth:       '#e8eaf6', // white-ish
  robinhood: '#00C805', // green
  base:      '#0052FF', // blue
};

const CHAIN_LABEL: Record<Color, string> = {
  bnb:       'Yellow Court',
  sol:       'Violet Conclave',
  eth:       'Pale Senate',
  robinhood: 'Green Exchange',
  base:      'Blue Vanguard',
};

const ACT_LABEL: Record<keyof typeof ACTS, string> = {
  awakening:  'Act I — Awakening',
  pilgrimage: 'Act II — Pilgrimage',
  coronation: 'Act III — Coronation',
};

// ─── Page ──────────────────────────────────────────────────────────────────

export function MasterquestPage({
  myName, onBack,
}: { myName: string; onBack: () => void }) {
  const [progress, setProgress] = useState<Progress>(() => loadProgress());
  const [openSiteId, setOpenSiteId] = useState<SiteId | null>(null);
  const [activeDuel, setActiveDuel] = useState<{ site: SacredSite; deckCards: string[] } | null>(null);
  const [postFight, setPostFight] = useState<{ site: SacredSite } | null>(null);
  const [showPrologue, setShowPrologue] = useState<boolean>(() => loadProgress().cleared.length === 0);
  const [showEpilogue, setShowEpilogue] = useState<boolean>(false);

  // ── Deck chooser ───────────────────────────────────────────────────────
  // Masterquest requires a CUSTOM deck — no starters allowed. The player
  // must have built and saved a legal deck in the Library first.
  const [decks, setDecks] = useState<DeckEntry[]>([]);
  const [decksLoading, setDecksLoading] = useState<boolean>(true);
  const [selectedDeckId, setSelectedDeckId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setDecksLoading(true);
      try {
        const list = await listDecksApi(myName);
        if (cancelled) return;
        const legal = list.filter(d => validateDeck(d.cards).ok);
        setDecks(legal);
        // Auto-select the first legal deck for convenience.
        if (legal.length > 0) setSelectedDeckId(legal[0].id);
      } catch {
        if (!cancelled) setDecks([]);
      } finally {
        if (!cancelled) setDecksLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [myName]);

  const selectedDeck = useMemo(
    () => decks.find(d => d.id === selectedDeckId) ?? null,
    [decks, selectedDeckId],
  );
  const canDuel = !!selectedDeck;

  const cur = currentSiteId(progress);
  const complete = isQuestComplete(progress);

  const openSite = useMemo(() => openSiteId ? SITES.find(s => s.id === openSiteId) ?? null : null, [openSiteId]);

  const handleSiteClick = useCallback((s: SacredSite) => {
    if (isCleared(s.id, progress) || isUnlocked(s.id, progress)) {
      setOpenSiteId(s.id);
    }
  }, [progress]);

  const handleBeginDuel = useCallback(() => {
    if (!openSite || !selectedDeck) return;
    setActiveDuel({ site: openSite, deckCards: selectedDeck.cards });
    setOpenSiteId(null);
  }, [openSite, selectedDeck]);

  const handleDuelEnd = useCallback((info: { win: boolean; turns: number }) => {
    if (!activeDuel) return;
    if (info.win) {
      const updated = recordClear(activeDuel.site.id);
      setProgress(updated);
      setPostFight({ site: activeDuel.site });
      setActiveDuel(null);
    }
    // On loss the player stays in the SoloClient screen; "Exit Solo" returns here.
  }, [activeDuel]);

  const handleTravelOnward = useCallback(() => {
    const site = postFight?.site;
    setPostFight(null);
    if (site && site.id === 'cipher_peak') {
      markEpilogueSeen();
      setShowEpilogue(true);
    }
  }, [postFight]);

  const handleResetCampaign = useCallback(() => {
    if (typeof window !== 'undefined' && window.confirm('Erase Masterquest progress and start again from Site 1?')) {
      clearProgress();
      setProgress(loadProgress());
      setShowPrologue(true);
    }
  }, []);

  // Active duel takes over the screen.
  if (activeDuel) {
    return (
      <SoloClient
        playerName={myName || 'Sorendo'}
        difficulty={activeDuel.site.rival.difficulty}
        mode="casual"
        playerDeckColor="sol"
        customDeck={activeDuel.deckCards}
        botDeckColor={activeDuel.site.rival.botColor}
        matchLabel={`${activeDuel.site.rival.name} — ${activeDuel.site.rival.title}`}
        onExit={() => setActiveDuel(null)}
        onMatchEnd={handleDuelEnd}
      />
    );
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, overflowY: 'auto',
      background: 'radial-gradient(circle at 50% 45%, #1a0f3a 0%, #08051a 60%, #02010a 100%)',
      color: '#f5f3ff', fontFamily: 'Inter, sans-serif',
    }}>
      {/* Header */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 5,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '12px 20px',
        background: 'linear-gradient(180deg, rgba(8,5,26,0.94) 0%, rgba(8,5,26,0.6) 100%)',
        borderBottom: '1px solid #2a1f55',
      }}>
        <button onClick={onBack} style={btnSecondary}><ArrowLeft size={14} /> Back</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontWeight: 900, fontSize: 18, letterSpacing: 2 }}>
          <MapIcon size={20} /> MEMETIC MASTERQUEST
        </div>
        <button onClick={handleResetCampaign} style={{ ...btnSecondary, fontSize: 11, opacity: 0.6 }}>
          <Refresh size={12} /> reset
        </button>
      </div>

      {/* Status bar */}
      <div style={{
        padding: '14px 24px', textAlign: 'center',
        background: 'rgba(108,75,216,0.08)',
      }}>
        <div style={{ fontSize: 13, letterSpacing: 1, opacity: 0.85 }}>
          {complete
            ? <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}><Diamond size={9} /> THE FIVE-CHAIN CROWN IS YOURS <Diamond size={9} /></span>
            : `Sites cleared: ${progress.cleared.length} / 15${cur ? ` · Next: ${SITES.find(s => s.id === cur)?.name}` : ''}`}
        </div>
        {complete && !showEpilogue && (
          <button onClick={() => setShowEpilogue(true)} style={{ ...btnPrimary, marginTop: 10 }}>
            <Diamond size={10} /> Read the Epilogue
          </button>
        )}
      </div>

      {/* Deck chooser — Masterquest requires a custom (saved) deck */}
      <DeckChooser
        decks={decks}
        loading={decksLoading}
        selectedDeckId={selectedDeckId}
        onSelect={setSelectedDeckId}
      />

      {/* Map */}
      <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 16px 32px' }}>
        <div style={{ width: '100%', maxWidth: 1280 }}>
          <MapSvg progress={progress} onSiteClick={handleSiteClick} />
          <ActLegend />
        </div>
      </div>

      {/* Modals */}
      {showPrologue && <PrologueModal onClose={() => setShowPrologue(false)} />}
      {showEpilogue && <EpilogueModal onClose={() => setShowEpilogue(false)} />}
      {openSite && (
        <SiteModal
          site={openSite}
          cleared={isCleared(openSite.id, progress)}
          interlude={INTERLUDES[openSite.id]}
          selectedDeck={selectedDeck}
          canDuel={canDuel}
          onClose={() => setOpenSiteId(null)}
          onBeginDuel={handleBeginDuel}
        />
      )}
      {postFight && (
        <PostFightModal
          site={postFight.site}
          interlude={INTERLUDES[postFight.site.id]}
          onTravelOnward={handleTravelOnward}
        />
      )}
    </div>
  );
}

// ─── Map SVG ───────────────────────────────────────────────────────────────

function MapSvg({
  progress, onSiteClick,
}: { progress: Progress; onSiteClick: (s: SacredSite) => void }) {
  const positioned = SITES.map(s => ({ s, p: mapPosOf(s) }));
  const cur = currentSiteId(progress);
  const VW = MAP_VIEWBOX.w;
  const VH = MAP_VIEWBOX.h;

  return (
    <svg
      viewBox={`0 0 ${VW} ${VH}`}
      style={{
        width: '100%', height: 'auto', display: 'block',
        borderRadius: 10, border: '1px solid #3a2f6a',
        boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
      }}
      aria-label="Memetic Masterquest map"
    >
      {/* Painted Map of the Aetherweb (drawn first, everything else overlays) */}
      <image href="/masterquest-map.png?v=1" x={0} y={0} width={VW} height={VH}
        preserveAspectRatio="xMidYMid slice" />

      {/* Travel path: faint dashed line connecting consecutive sites in clear-order */}
      {positioned.slice(1).map(({ s, p }, i) => {
        const prev = positioned[i].p;
        const traversed = isCleared(s.id, progress) || s.id === cur;
        return (
          <line key={`path-${s.id}`}
            x1={prev.x} y1={prev.y} x2={p.x} y2={p.y}
            stroke={traversed ? '#ffe066' : '#cfc4ff'}
            strokeWidth={traversed ? 5 : 3}
            strokeOpacity={traversed ? 0.75 : 0.25}
            strokeDasharray={traversed ? '0' : '12,10'}
          />
        );
      })}

      {/* Site nodes — large enough to be tappable over the painted map */}
      {positioned.map(({ s, p }) => {
        const cleared = isCleared(s.id, progress);
        const unlocked = s.id === cur;
        const dim = !cleared && !unlocked;
        const fill = CHAIN_HEX[s.chain];
        const baseR = unlocked ? 36 : cleared ? 30 : 26;
        return (
          <g key={s.id}
            onClick={() => onSiteClick(s)}
            style={{ cursor: (cleared || unlocked) ? 'pointer' : 'not-allowed' }}>
            {/* Pulsing halo around the current site */}
            {unlocked && (
              <circle cx={p.x} cy={p.y} r={baseR + 18} fill={fill} opacity={0.22}>
                <animate attributeName="r"
                  values={`${baseR + 8};${baseR + 28};${baseR + 8}`}
                  dur="2.4s" repeatCount="indefinite" />
                <animate attributeName="opacity"
                  values="0.12;0.36;0.12"
                  dur="2.4s" repeatCount="indefinite" />
              </circle>
            )}
            {cleared && (
              <circle cx={p.x} cy={p.y} r={baseR + 10} fill={fill} opacity={0.28} />
            )}
            {/* Outer ring */}
            <circle cx={p.x} cy={p.y} r={baseR + 4}
              fill="#0a0716" stroke="#000" strokeWidth={2}
              opacity={dim ? 0.65 : 0.9} />
            {/* Inner colour disc */}
            <circle cx={p.x} cy={p.y} r={baseR}
              fill={dim ? '#1a1230' : fill}
              stroke={dim ? '#3a2f6a' : '#fff'}
              strokeWidth={3}
              opacity={dim ? 0.85 : 1} />
            {/* Numeric label */}
            <text x={p.x} y={p.y + 9} textAnchor="middle"
              fontSize={28} fontWeight={900}
              fontFamily="'Cinzel', serif"
              fill={dim ? '#7a6fa5' : (s.chain === 'eth' ? '#222' : '#fff')}
              pointerEvents="none">
              {toRoman(s.index)}
            </text>
            {/* Cleared checkmark */}
            {cleared && (
              <path
                d={`M ${p.x + baseR - 6} ${p.y - baseR + 4} l 6 6 l 11 -13`}
                fill="none" stroke="#a5ffb0" strokeWidth={5}
                strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
            )}
          </g>
        );
      })}

      {/* Sorendo avatar floating above the current site */}
      {cur && (() => {
        const here = positioned.find(({ s }) => s.id === cur);
        if (!here) return null;
        return (
          <g pointerEvents="none">
            <g transform={`translate(${here.p.x - 22} ${here.p.y - 94}) scale(1.85)`}
              fill="none" stroke="#fff" strokeWidth={1.8}
              strokeLinecap="round" strokeLinejoin="round"
              style={{ filter: 'drop-shadow(0 0 6px rgba(255,255,255,0.8))' }}>
              <path d="M12 2.5 7 12h10z" />
              <path d="M5.5 12h13l1.5 3.5a2 2 0 0 1-1.9 2.8H5.9A2 2 0 0 1 4 15.5z" />
              <path d="M12 6.5v2" />
            </g>
          </g>
        );
      })()}
    </svg>
  );
}

function toRoman(n: number): string {
  const r: Record<number, string> = {
    1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V',
    6: 'VI', 7: 'VII', 8: 'VIII', 9: 'IX', 10: 'X',
    11: 'XI', 12: 'XII', 13: 'XIII', 14: 'XIV', 15: 'XV',
  };
  return r[n] ?? String(n);
}

function ActLegend() {
  return (
    <div style={{
      display: 'flex', justifyContent: 'center', flexWrap: 'wrap',
      padding: '14px 8px 0', gap: 18,
      fontSize: 11, opacity: 0.85, color: '#cfc4ff',
    }}>
      <div>{ACT_LABEL.awakening} — Sites I–V</div>
      <div>{ACT_LABEL.pilgrimage} — Sites VI–X</div>
      <div>{ACT_LABEL.coronation} — Sites XI–XV</div>
    </div>
  );
}

// ─── Modals ────────────────────────────────────────────────────────────────

function modalShell(children: React.ReactNode, onClose?: () => void) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 300,
      background: 'rgba(2,1,10,0.86)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, overflowY: 'auto',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'linear-gradient(160deg, #1a1230, #0a0716)',
        border: '1px solid #6c4bd8', borderRadius: 14,
        padding: 22, maxWidth: 640, width: '100%',
        color: '#f5f3ff', fontFamily: 'Inter, sans-serif',
        boxShadow: '0 24px 60px rgba(0,0,0,0.7)',
        maxHeight: '92vh', overflowY: 'auto',
      }}>{children}</div>
    </div>
  );
}

function PrologueModal({ onClose }: { onClose: () => void }) {
  return modalShell(<>
    <div style={{ fontSize: 12, opacity: 0.6, letterSpacing: 2 }}>PROLOGUE</div>
    <h2 style={{ marginTop: 4, marginBottom: 14, fontSize: 22 }}>Sorendo the Unhoused</h2>
    <PreservedText text={PROLOGUE} />
    <div style={{ marginTop: 18, textAlign: 'right' }}>
      <button onClick={onClose} style={btnPrimary}>Begin the Quest <ArrowRight size={15} /></button>
    </div>
  </>, onClose);
}

function EpilogueModal({ onClose }: { onClose: () => void }) {
  return modalShell(<>
    <div style={{ fontSize: 12, opacity: 0.6, letterSpacing: 2, color: '#ffe066' }}>EPILOGUE</div>
    <h2 style={{ marginTop: 4, marginBottom: 14, fontSize: 22 }}>The Five-Chain Crown</h2>
    <PreservedText text={EPILOGUE} />
    <div style={{ marginTop: 18, textAlign: 'right' }}>
      <button onClick={onClose} style={btnPrimary}>Close</button>
    </div>
  </>, onClose);
}

function SiteModal({
  site, cleared, interlude, selectedDeck, canDuel, onClose, onBeginDuel,
}: {
  site: SacredSite; cleared: boolean; interlude: Interlude;
  selectedDeck: DeckEntry | null; canDuel: boolean;
  onClose: () => void; onBeginDuel: () => void;
}) {
  return modalShell(<>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
      <div>
        <div style={{ fontSize: 11, opacity: 0.7, letterSpacing: 2 }}>
          SITE {site.index} / 15 · {ACT_LABEL[site.act]}
        </div>
        <h2 style={{ margin: '4px 0 6px', fontSize: 22 }}>{site.name}</h2>
        <ChainPill chain={site.chain} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', lineHeight: 1, color: cleared ? '#a5ffb0' : '#cfc4ff' }}>{cleared ? <Check size={26} /> : <DiamondOutline size={22} />}</div>
    </div>

    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75, fontStyle: 'italic' }}>
      {site.region}
    </div>
    <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.55, opacity: 0.92 }}>
      {site.description}
    </div>

    <h3 style={{ marginTop: 22, marginBottom: 8, fontSize: 16, color: '#ffd166' }}>
      The Approach
    </h3>
    <PreservedText text={interlude.pre} />

    <div style={{
      marginTop: 22, padding: 14,
      background: 'rgba(108,75,216,0.10)', borderRadius: 10,
      border: '1px solid #3a2f6a',
    }}>
      <div style={{ fontSize: 11, opacity: 0.65, letterSpacing: 1, marginBottom: 4 }}>YOUR RIVAL</div>
      <div style={{ fontSize: 18, fontWeight: 900 }}>{site.rival.name}</div>
      <div style={{ fontSize: 12, opacity: 0.75, fontStyle: 'italic' }}>{site.rival.title}</div>
      <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.5 }}>{site.rival.bio}</div>
      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
        Difficulty: <b style={{ color: difficultyColor(site.rival.difficulty) }}>
          {site.rival.difficulty.toUpperCase()}
        </b>
        {' · '}Deck: <b style={{ color: CHAIN_HEX[site.rival.botColor] }}>{CHAIN_LABEL[site.rival.botColor]}</b>
      </div>
      <div style={{ marginTop: 10, fontSize: 13, fontStyle: 'italic', opacity: 0.9 }}>
        “{site.rival.quote}”
      </div>
    </div>

    <div style={{ marginTop: 16, fontSize: 12, opacity: 0.8 }}>
      <b>Reward:</b> {site.reward}
    </div>

    {/* Selected-deck reminder + warning when no custom deck is selected */}
    <div style={{
      marginTop: 14, padding: 10,
      background: canDuel ? 'rgba(165,255,176,0.06)' : 'rgba(255,107,107,0.10)',
      border: `1px solid ${canDuel ? '#2c5d3a' : '#a83b3b'}`,
      borderRadius: 8, fontSize: 12,
    }}>
      {canDuel ? (
        <>
          <b style={{ color: '#a5ffb0' }}>Your deck:</b>{' '}
          {selectedDeck!.name || `Deck #${selectedDeck!.id}`}{' '}
          <span style={{ opacity: 0.7 }}>({selectedDeck!.cards.length} cards)</span>
        </>
      ) : (
        <>
          <b style={{ color: '#ff9a9a', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Warning size={13} /> No custom deck selected.</b>{' '}
          Masterquest requires a deck you built yourself — open the Library on the
          Profile page, build &amp; save a legal 60-card deck, then return here and
          pick it from the chooser above the map.
        </>
      )}
    </div>

    <div style={{ marginTop: 22, display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      <button onClick={onClose} style={btnSecondary}>Withdraw</button>
      {!cleared && (
        <button onClick={onBeginDuel}
          disabled={!canDuel}
          style={canDuel ? btnPrimary : btnDisabled}
          title={canDuel ? '' : 'Pick a custom deck first'}>
          <Swords size={16} /> Begin Duel
        </button>
      )}
      {cleared && (
        <button onClick={onBeginDuel}
          disabled={!canDuel}
          style={canDuel ? btnPrimary : btnDisabled}
          title={canDuel ? '' : 'Pick a custom deck first'}>
          <Refresh size={16} /> Re-Duel
        </button>
      )}
    </div>
  </>, onClose);
}

function PostFightModal({
  site, interlude, onTravelOnward,
}: { site: SacredSite; interlude: Interlude; onTravelOnward: () => void }) {
  return modalShell(<>
    <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 2, color: '#a5ffb0' }}>
      VICTORY · SITE {site.index} / 15
    </div>
    <h2 style={{ marginTop: 4, marginBottom: 12, fontSize: 22 }}>{site.name}</h2>

    <PreservedText text={interlude.post} />

    <div style={{
      marginTop: 18, padding: 12,
      background: 'rgba(165,255,176,0.08)', borderRadius: 10,
      border: '1px solid #2c5d3a', fontSize: 13,
    }}>
      <b style={{ color: '#a5ffb0' }}>Reward earned:</b> {site.reward}
    </div>

    <div style={{ marginTop: 22, textAlign: 'right' }}>
      <button onClick={onTravelOnward} style={btnPrimary}>
        {site.id === 'cipher_peak'
          ? <><Diamond size={11} /> Reforge the Aetherweb</>
          : <>Travel Onward <ArrowRight size={15} /></>}
      </button>
    </div>
  </>);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function PreservedText({ text }: { text: string }) {
  // Render paragraph-by-paragraph (split on blank lines). Preserves the
  // hand-written line breaks in the lore source as <br/>s within paragraphs.
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return (
    <div>
      {paragraphs.map((para, i) => (
        <p key={i} style={{
          fontSize: 14, lineHeight: 1.6,
          margin: '10px 0', color: '#e8e3ff', whiteSpace: 'pre-wrap',
        }}>{para}</p>
      ))}
    </div>
  );
}

function ChainPill({ chain }: { chain: Color }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 9px', borderRadius: 999,
      fontSize: 11, fontWeight: 800,
      background: CHAIN_HEX[chain],
      color: chain === 'eth' ? '#222' : '#fff',
      border: '1px solid rgba(0,0,0,0.4)',
    }}>{CHAIN_LABEL[chain]}</span>
  );
}

function difficultyColor(d: 'easy' | 'normal' | 'hard'): string {
  return d === 'easy' ? '#a5ffb0' : d === 'normal' ? '#cfc4ff' : '#ff8a8a';
}

// Forged amethyst plate — bevelled top highlight, dark bottom shadow, warm
// outer glow. Matches the shared button language in src/ui.tsx.
const btnPrimary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 9,
  background: 'linear-gradient(180deg, #b9a4ff 0%, #8a6bff 34%, #6a46e8 62%, #4b30ab 100%)',
  color: '#fff',
  border: '1px solid #4b30ab', borderRadius: 10,
  padding: '12px 20px', fontWeight: 700, fontSize: 13,
  fontFamily: '"Cinzel", "EB Garamond", Georgia, serif',
  letterSpacing: '0.12em', textTransform: 'uppercase',
  textShadow: '0 1px 0 rgba(0,0,0,0.35)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5), inset 0 -1px 0 rgba(0,0,0,0.42), 0 0 0 1px rgba(124,92,255,0.30), 0 10px 28px -10px rgba(124,92,255,0.6)',
  cursor: 'pointer',
  transition: 'transform 160ms cubic-bezier(0.2,0.8,0.2,1), box-shadow 180ms ease, background 180ms ease',
};

// Obsidian plate with an engraved gold hairline.
const btnSecondary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
  background: 'linear-gradient(180deg, #201c38 0%, #16142a 70%, #121026 100%)',
  color: '#f0d489',
  border: '1px solid rgba(217,180,90,0.32)', borderRadius: 10,
  padding: '10px 15px', fontWeight: 700, fontSize: 12, letterSpacing: '0.08em',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 6px 18px -10px rgba(3,2,10,0.9)',
  cursor: 'pointer',
  transition: 'transform 160ms cubic-bezier(0.2,0.8,0.2,1), box-shadow 180ms ease, border-color 180ms ease, color 180ms ease',
};

const btnDisabled: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 9,
  background: 'linear-gradient(180deg, #2a2440 0%, #1c1830 60%, #16132a 100%)',
  color: 'rgba(207,196,255,0.38)',
  border: '1px solid #2a2150', borderRadius: 10,
  padding: '12px 20px', fontWeight: 700, fontSize: 13,
  fontFamily: '"Cinzel", "EB Garamond", Georgia, serif',
  letterSpacing: '0.12em', textTransform: 'uppercase',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
  cursor: 'not-allowed', filter: 'saturate(0.45)',
};

// ─── Deck chooser strip ────────────────────────────────────────────────────

function DeckChooser({
  decks, loading, selectedDeckId, onSelect,
}: {
  decks: DeckEntry[];
  loading: boolean;
  selectedDeckId: number | null;
  onSelect: (id: number | null) => void;
}) {
  return (
    <div style={{
      padding: '12px 20px',
      background: 'rgba(108,75,216,0.06)',
      borderBottom: '1px solid #2a1f55',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        flexWrap: 'wrap', maxWidth: 1280, margin: '0 auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, letterSpacing: 1.5, opacity: 0.8, fontWeight: 700 }}>
          <Cards size={13} /> YOUR DECK
        </div>

        {loading && (
          <div style={{ fontSize: 12, opacity: 0.65 }}>loading saved decks…</div>
        )}

        {!loading && decks.length === 0 && (
          <div style={{ fontSize: 12, color: '#ff9a9a' }}>
            No legal custom decks found. Build a 60-card deck in the Library
            (Profile &rarr; Library) first — Masterquest does <b>not</b> allow starter
            decks.
          </div>
        )}

        {!loading && decks.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {decks.map(d => {
                const active = selectedDeckId === d.id;
                return (
                  <button key={d.id}
                    onClick={() => onSelect(d.id)}
                    style={{
                      background: active ? '#6c4bd8' : '#1a1230',
                      color: active ? '#fff' : '#cfc4ff',
                      border: `2px solid ${active ? '#8a6bf0' : '#3a2f6a'}`,
                      borderRadius: 8, padding: '8px 12px',
                      fontWeight: 700, fontSize: 12, cursor: 'pointer',
                      letterSpacing: 0.3,
                    }}>
                    {d.name || `Deck #${d.id}`}{' '}
                    <span style={{ opacity: 0.65, fontWeight: 400 }}>
                      ({d.cards.length})
                    </span>
                  </button>
                );
              })}
            </div>
            {selectedDeckId == null && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#ff9a9a' }}>
                <Warning size={12} /> Select a deck above to unlock the duels.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

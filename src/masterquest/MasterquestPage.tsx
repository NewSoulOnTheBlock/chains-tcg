// src/masterquest/MasterquestPage.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Memetic Masterquest — campaign mode UI.
//
// Renders a 100×100 SVG map of all 15 Sacred Sites arranged in three
// concentric rings (one per Act), with travel paths between consecutive
// sites. Visited sites glow; the current site pulses; locked sites are dim.
//
// Click the current site → interlude modal (pre-fight lore + "BEGIN DUEL").
// Click a cleared site → re-read modal (post-fight lore).
// On duel victory → post-fight interlude + "TRAVEL ONWARD" → unlock next.
// After Site 15 → EPILOGUE.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState, useCallback } from 'react';
import { SoloClient } from '../SoloClient';
import type { Color } from '../cards';
import {
  PROLOGUE, ACTS, SITES, EPILOGUE, INTERLUDES,
  mapPosOf, type SacredSite, type SiteId, type Interlude,
} from './lore';
import {
  loadProgress, recordClear, markEpilogueSeen,
  isCleared, isUnlocked, currentSiteId, isQuestComplete,
  clearProgress, type Progress,
} from './progress';

// ── Chain → colour palette (matches the rest of the game) ──────────────────
const CHAIN_HEX: Record<Color, string> = {
  bnb:  '#f3ba2f', // yellow
  sol:  '#9945ff', // violet
  avax: '#2bd6a3', // green (Iron Order = Hyperliquid green in this campaign)
  eth:  '#e8eaf6', // white-ish
  xrp:  '#1f1f1f', // black
};

const CHAIN_LABEL: Record<Color, string> = {
  bnb:  'Yellow Court',
  sol:  'Violet Conclave',
  avax: 'Iron Order',
  eth:  'Pale Senate',
  xrp:  'Black Ledger',
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
  const [activeDuel, setActiveDuel] = useState<{ site: SacredSite } | null>(null);
  const [postFight, setPostFight] = useState<{ site: SacredSite } | null>(null);
  const [showPrologue, setShowPrologue] = useState<boolean>(() => loadProgress().cleared.length === 0);
  const [showEpilogue, setShowEpilogue] = useState<boolean>(false);

  const cur = currentSiteId(progress);
  const complete = isQuestComplete(progress);

  const openSite = useMemo(() => openSiteId ? SITES.find(s => s.id === openSiteId) ?? null : null, [openSiteId]);

  const handleSiteClick = useCallback((s: SacredSite) => {
    if (isCleared(s.id, progress) || isUnlocked(s.id, progress)) {
      setOpenSiteId(s.id);
    }
  }, [progress]);

  const handleBeginDuel = useCallback(() => {
    if (!openSite) return;
    setActiveDuel({ site: openSite });
    setOpenSiteId(null);
  }, [openSite]);

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
    if (site && site.id === 'obsidian_mirror') {
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
        <button onClick={onBack} style={btnSecondary}>← Back</button>
        <div style={{ fontWeight: 900, fontSize: 18, letterSpacing: 2 }}>
          🗺  MEMETIC MASTERQUEST
        </div>
        <button onClick={handleResetCampaign} style={{ ...btnSecondary, fontSize: 11, opacity: 0.6 }}>
          ↻ reset
        </button>
      </div>

      {/* Status bar */}
      <div style={{
        padding: '14px 24px', textAlign: 'center',
        background: 'rgba(108,75,216,0.08)',
      }}>
        <div style={{ fontSize: 13, letterSpacing: 1, opacity: 0.85 }}>
          {complete
            ? '✦ THE FIVE-CHAIN CROWN IS YOURS ✦'
            : `Sites cleared: ${progress.cleared.length} / 15${cur ? ` · Next: ${SITES.find(s => s.id === cur)?.name}` : ''}`}
        </div>
        {complete && !showEpilogue && (
          <button onClick={() => setShowEpilogue(true)} style={{ ...btnPrimary, marginTop: 10 }}>
            ✦ Read the Epilogue
          </button>
        )}
      </div>

      {/* Map */}
      <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 16px 32px' }}>
        <div style={{ width: '100%', maxWidth: 760 }}>
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

  return (
    <svg
      viewBox="0 0 100 100"
      style={{ width: '100%', height: 'auto', maxHeight: '70vh', display: 'block' }}
      aria-label="Memetic Masterquest map"
    >
      {/* Three concentric rings to suggest the three Acts */}
      {[
        { r: 40, op: 0.18, dash: '1,1' },
        { r: 26, op: 0.14, dash: '1,1' },
        { r: 13, op: 0.10, dash: '1,1' },
      ].map((c, i) => (
        <circle key={i} cx={50} cy={50} r={c.r}
          fill="none" stroke="#a08bff" strokeOpacity={c.op}
          strokeWidth={0.2} strokeDasharray={c.dash} />
      ))}

      {/* Travel path: lines between consecutive sites */}
      {positioned.slice(1).map(({ s, p }, i) => {
        const prev = positioned[i].p;
        const traversed = isCleared(s.id, progress) || s.id === cur;
        return (
          <line key={`path-${s.id}`}
            x1={prev.x} y1={prev.y} x2={p.x} y2={p.y}
            stroke={traversed ? '#9d7bff' : '#3a2f6a'}
            strokeWidth={traversed ? 0.5 : 0.3}
            strokeOpacity={traversed ? 0.85 : 0.4}
            strokeDasharray={traversed ? '0' : '0.8,0.6'}
          />
        );
      })}

      {/* Site nodes */}
      {positioned.map(({ s, p }) => {
        const cleared = isCleared(s.id, progress);
        const unlocked = s.id === cur;
        const dim = !cleared && !unlocked;
        const fill = CHAIN_HEX[s.chain];
        const baseR = unlocked ? 3.2 : cleared ? 2.6 : 2.2;
        return (
          <g key={s.id}
            onClick={() => onSiteClick(s)}
            style={{ cursor: (cleared || unlocked) ? 'pointer' : 'not-allowed' }}>
            {/* Glow for unlocked + pulse animation */}
            {unlocked && (
              <circle cx={p.x} cy={p.y} r={baseR + 2.5} fill={fill} opacity={0.18}>
                <animate attributeName="r" values={`${baseR + 1.5};${baseR + 4};${baseR + 1.5}`} dur="2.4s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.10;0.32;0.10" dur="2.4s" repeatCount="indefinite" />
              </circle>
            )}
            {cleared && (
              <circle cx={p.x} cy={p.y} r={baseR + 1.4} fill={fill} opacity={0.25} />
            )}
            <circle cx={p.x} cy={p.y} r={baseR}
              fill={dim ? '#221a40' : fill}
              stroke={dim ? '#3a2f6a' : '#000'}
              strokeWidth={0.4}
              opacity={dim ? 0.55 : 1} />
            {/* Numeric label */}
            <text x={p.x} y={p.y + 0.7} textAnchor="middle"
              fontSize={2.2} fontWeight={900}
              fill={dim ? '#7a6fa5' : (s.chain === 'eth' ? '#222' : '#fff')}
              pointerEvents="none">
              {s.index}
            </text>
            {/* Site name tag */}
            <text x={p.x} y={p.y + baseR + 3} textAnchor="middle"
              fontSize={1.7} fill={dim ? '#5a4f80' : '#cfc4ff'}
              pointerEvents="none">
              {shortName(s.name)}
            </text>
            {/* Cleared checkmark */}
            {cleared && (
              <text x={p.x + baseR - 0.2} y={p.y - baseR + 0.5}
                fontSize={2.5} fill="#a5ffb0" fontWeight={900} pointerEvents="none">✓</text>
            )}
          </g>
        );
      })}

      {/* Sorendo icon at current site */}
      {cur && (() => {
        const here = positioned.find(({ s }) => s.id === cur);
        if (!here) return null;
        return (
          <g pointerEvents="none">
            <text x={here.p.x} y={here.p.y - 5.5} textAnchor="middle"
              fontSize={3.6} fill="#fff">🧙</text>
          </g>
        );
      })()}
    </svg>
  );
}

function shortName(name: string): string {
  // Drop "The" prefix and any subtitle after a long-dash for the map label.
  return name.replace(/^The\s+/, '').split(/[—–]/)[0].trim().slice(0, 22);
}

function ActLegend() {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-around', flexWrap: 'wrap',
      padding: '14px 8px 0', gap: 12,
      fontSize: 11, opacity: 0.85, color: '#cfc4ff',
    }}>
      <div>● Outer ring — {ACT_LABEL.awakening}</div>
      <div>● Middle ring — {ACT_LABEL.pilgrimage}</div>
      <div>● Inner ring — {ACT_LABEL.coronation}</div>
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
      <button onClick={onClose} style={btnPrimary}>Begin the Quest →</button>
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
  site, cleared, interlude, onClose, onBeginDuel,
}: {
  site: SacredSite; cleared: boolean; interlude: Interlude;
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
      <div style={{ fontSize: 28, lineHeight: 1 }}>{cleared ? '✓' : '◇'}</div>
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

    <div style={{ marginTop: 22, display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      <button onClick={onClose} style={btnSecondary}>Withdraw</button>
      {!cleared && <button onClick={onBeginDuel} style={btnPrimary}>⚔  Begin Duel</button>}
      {cleared && <button onClick={onBeginDuel} style={btnPrimary}>↻  Re-Duel</button>}
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
        {site.id === 'obsidian_mirror' ? '✦  Reforge the Aetherweb' : 'Travel Onward →'}
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

const btnPrimary: React.CSSProperties = {
  background: '#6c4bd8', color: '#fff',
  border: '1px solid #8a6bf0', borderRadius: 8,
  padding: '10px 18px', fontWeight: 800, fontSize: 13,
  cursor: 'pointer', letterSpacing: 0.5,
};

const btnSecondary: React.CSSProperties = {
  background: '#1a1230', color: '#cfc4ff',
  border: '1px solid #3a2f6a', borderRadius: 8,
  padding: '8px 14px', fontWeight: 700, fontSize: 12,
  cursor: 'pointer',
};

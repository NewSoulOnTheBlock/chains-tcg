// src/Board.tsx
// React board for Chains TCG.
import React, { useState, useEffect, useRef } from 'react';
import type { BoardProps } from 'boardgame.io/react';
import {
  CARDS, COLOR_META, COLORS, templateFor,
  type Color, type CardDef,
} from './cards';
import type { GState, Instance } from './Game';
import { mulliganDrawCount, MULLIGAN_FLOOR, MULLIGAN_INITIAL_HAND } from './Game';
import { recordResultApi, getProfileApi, formatRecord, type Profile } from './profiles';
import { CardHover } from './CardPreview';

type Props = BoardProps<GState>;

function useIsMobile(breakpoint = 720) {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.innerWidth <= breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = () => setM(mq.matches);
    onChange();
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, [breakpoint]);
  return m;
}

const COLOR_BAR: React.CSSProperties = { display: 'flex', gap: 6, fontSize: 12, marginTop: 4 };

function Pip({ c, n }: { c: Color | 'any'; n: number }) {
  if (!n) return null;
  const meta = c === 'any'
    ? { hex: '#c8c8d0', ink: '#1a1a1a' }
    : COLOR_META[c];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 18, height: 18, borderRadius: 9,
      background: meta.hex, color: meta.ink,
      fontWeight: 700, fontSize: 11, border: '1px solid #0003',
    }}>{n}</span>
  );
}

function CostPips({ def }: { def: CardDef }) {
  if (!def.cost) return null;
  return (
    <div style={COLOR_BAR}>
      <Pip c="any" n={def.cost.any ?? 0} />
      {COLORS.map(c => <Pip key={c} c={c} n={def.cost?.[c] ?? 0} />)}
    </div>
  );
}

function CardFace({
  defId, instance, footer, onClick, selected, faceDown,
}: {
  defId: string;
  instance?: Instance;
  footer?: React.ReactNode;
  onClick?: () => void;
  selected?: boolean;
  faceDown?: boolean;
}) {
  const mobile = useIsMobile();
  const W = mobile ? 92 : 138;
  const H = mobile ? 134 : 200;
  if (faceDown) {
    return (
      <div style={{
        width: W, height: H, margin: 2, borderRadius: 8,
        background: 'repeating-linear-gradient(45deg, #333 0 8px, #555 8px 16px)',
        border: '1px solid #000', flex: '0 0 auto',
      }} />
    );
  }
  const def = CARDS[defId];
  if (!def) return null;
  const meta = COLOR_META[def.color];
  const dimmed = instance?.summoningSick || instance?.tapped;
  const tpl = templateFor(def);
  return (
    <CardHover defId={defId}>
    <div onClick={onClick}
      style={{
        width: W, height: H, margin: 2, padding: tpl ? 0 : 5, borderRadius: 8,
        background: tpl ? undefined : meta.hex,
        backgroundImage: tpl ? `url(${tpl.url})` : undefined,
        backgroundSize: tpl ? '100% 100%' : undefined,
        backgroundRepeat: 'no-repeat',
        color: meta.ink,
        border: selected ? '3px solid #ff0' : (tpl ? 'none' : '1px solid #000'),
        cursor: onClick ? 'pointer' : 'default',
        boxShadow: instance?.tapped ? 'inset 0 0 0 4px #0008' : undefined,
        transform: instance?.tapped ? 'rotate(8deg)' : undefined,
        opacity: dimmed && def.type === 'meme' ? 0.55 : 1,
        fontFamily: 'system-ui, sans-serif',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        position: 'relative', flex: '0 0 auto',
      }}>
      {tpl ? <TemplatedCardFaceContent def={def} instance={instance} footer={footer} tpl={tpl} /> : <>
      <div style={{ fontWeight: 700, fontSize: 10, lineHeight: 1.05 }}>{def.name}</div>
      <div style={{ fontSize: 8, opacity: 0.85, marginTop: 1, lineHeight: 1.1 }}>
        {def.type.toUpperCase()}
        {instance?.summoningSick && <span style={{ marginLeft: 3, color: '#000', background: '#ffeb3b', padding: '0 3px', borderRadius: 2, fontSize: 7 }}>SICK</span>}
        {instance?.tapped && !instance?.summoningSick && <span style={{ marginLeft: 3, color: '#000', background: '#aaa', padding: '0 3px', borderRadius: 2, fontSize: 7 }}>TAPPED</span>}
      </div>
      <div style={{ fontSize: 8, marginTop: 3, flex: 1, overflow: 'hidden', lineHeight: 1.15 }}>{def.text}</div>
      {def.type === 'meme' && (
        <div style={{ alignSelf: 'flex-end', fontWeight: 700, fontSize: 11 }}>
          {def.power}/{(def.toughness ?? 1) - (instance?.damage ?? 0)}
        </div>
      )}
      <CostPips def={def} />
      {footer && <div style={{ fontSize: 8, lineHeight: 1.1 }}>{footer}</div>}
      </>}
    </div>
    </CardHover>
  );
}

/** Content placed inside a templated MTG-style frame (per-color via COLOR_META.template). */
function TemplatedCardFaceContent({ def, instance, footer, tpl }: { def: CardDef; instance?: Instance; footer?: React.ReactNode; tpl: { url: string; glyph?: string } }) {
  const meta = COLOR_META[def.color];
  return (
    <>
      {/* Name on the top grey bar */}
      <div style={{
        position: 'absolute', top: '5.6%', left: '9%', right: '9%', height: '5%',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 4, padding: '0 4px',
        fontSize: 8, fontWeight: 800, color: '#1a1a1a',
      }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{def.name}</span>
        {def.cost && (
          <span style={{ display: 'flex', gap: 1 }}>
            {(['any', ...COLORS] as const).map(c => {
              const n = def.cost?.[c] ?? 0; if (!n) return null;
              const cm = c === 'any' ? { hex: '#c8c8d0', ink: '#1a1a1a' } : COLOR_META[c];
              return (
                <span key={c} style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 10, height: 10, borderRadius: 5,
                  background: cm.hex, color: cm.ink,
                  fontWeight: 800, fontSize: 7,
                }}>{n}</span>
              );
            })}
          </span>
        )}
      </div>
      {/* Art zone — image sits inside the template's black window */}
      <div style={{
        position: 'absolute', top: '13%', left: '8.5%', right: '8.5%', height: '44%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden',
      }}>
        <span style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: meta.ink, fontWeight: 900,
          fontSize: (tpl.glyph ?? meta.glyph ?? meta.name).length > 4 ? 11 : 18,
          letterSpacing: (tpl.glyph ?? meta.glyph ?? meta.name).length > 4 ? 1 : 2,
          textShadow: '0 2px 6px #000',
        }}>{tpl.glyph ?? meta.glyph ?? meta.name}</span>
        {def.image && (
          <img src={def.image} alt="" loading="lazy"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            style={{ position: 'relative', width: '100%', height: '100%', objectFit: 'cover' }} />
        )}
        {/* Status badges overlay on top-right of art */}
        {instance?.summoningSick && <span style={{ position: 'absolute', top: 2, right: 2, color: '#000', background: '#ffeb3b', padding: '0 3px', borderRadius: 2, fontSize: 6, fontWeight: 800 }}>SICK</span>}
        {instance?.tapped && !instance?.summoningSick && <span style={{ position: 'absolute', top: 2, right: 2, color: '#000', background: '#aaa', padding: '0 3px', borderRadius: 2, fontSize: 6, fontWeight: 800 }}>TAP</span>}
      </div>
      {/* Type bar */}
      <div style={{
        position: 'absolute', top: '58.5%', left: '9%', right: '9%', height: '4.5%',
        display: 'flex', alignItems: 'center', padding: '0 4px',
        fontSize: 7, fontWeight: 700, color: '#1a1a1a',
        letterSpacing: 0.5, textTransform: 'uppercase',
      }}>
        {def.type}
      </div>
      {/* Rules text box */}
      <div style={{
        position: 'absolute', top: '67%', left: '9%', right: '9%', bottom: '7%',
        padding: '3px 5px',
        fontSize: 7, lineHeight: 1.15, color: '#1a1a1a',
        overflow: 'hidden',
      }}>
        {def.text}
        {def.type === 'meme' && (
          <div style={{
            position: 'absolute', right: 4, bottom: 2,
            fontWeight: 800, fontSize: 10, color: '#1a1a1a',
            padding: '0 4px', background: '#e8e6c8',
            border: '1px solid #4a5a3a', borderRadius: 2,
          }}>
            {def.power}/{(def.toughness ?? 1) - (instance?.damage ?? 0)}
          </div>
        )}
        {footer && <div style={{ fontSize: 6, lineHeight: 1.05, marginTop: 2 }}>{footer}</div>}
      </div>
    </>
  );
}

function GasBar({ gas }: { gas: Record<Color, number> }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <span style={{ fontSize: 12, opacity: 0.7 }}>Gas:</span>
      {COLORS.map(c => <Pip key={c} c={c} n={gas[c]} />)}
    </div>
  );
}

export function ChainsBoard(props: Props) {
  const { G, ctx, moves, playerID, isActive, chatMessages, sendChatMessage, matchID, matchData } = props as Props & {
    matchID?: string;
    matchData?: Array<{ id: number; name?: string; isConnected?: boolean }>;
  };
  const mobile = useIsMobile();
  const myId  = playerID ?? '0';
  const oppId = myId === '0' ? '1' : '0';
  const me   = G.players[myId];
  const opp  = G.players[oppId];

  const [selectedHand, setSelectedHand] = useState<number | null>(null);
  const [targetMode, setTargetMode] = useState<null | { kind: 'meme' | 'any' | 'machine' }>(null);

  const myTurn = ctx.currentPlayer === myId;
  const inBlockers = ctx.activePlayers?.[myId] === 'blockers';
  const pickPhase = !!me?.needsColorPick || !!opp?.needsColorPick;
  const iMustPick = !!me?.needsColorPick;
  const mulliganPhase = ctx.phase === 'mulligan';
  const myMulliganDone = !!G.mulligan?.done?.[myId];
  const oppMulliganDone = !!G.mulligan?.done?.[oppId];
  const myMulliganCount = G.mulligan?.counts?.[myId] ?? 0;

  // Auto-apply the joiner's stashed deck choice from the lobby modal, once.
  const pickAppliedRef = useRef(false);
  useEffect(() => {
    if (!iMustPick || pickAppliedRef.current) return;
    let stashedDeck: string | null = null;
    let stashedColor: string | null = null;
    try {
      stashedDeck = sessionStorage.getItem('pendingCustomDeck');
      stashedColor = sessionStorage.getItem('pendingPickColor');
    } catch {}
    if (stashedDeck) {
      try {
        const deck = JSON.parse(stashedDeck);
        if (Array.isArray(deck) && deck.length > 0) {
          pickAppliedRef.current = true;
          try { sessionStorage.removeItem('pendingCustomDeck'); } catch {}
          try { sessionStorage.removeItem('pendingPickColor'); } catch {}
          // The first arg is ignored when a custom deck is provided; pass any color.
          moves.chooseColor('sol' as Color, deck);
          return;
        }
      } catch {}
    }
    if (stashedColor && COLORS.includes(stashedColor as Color)) {
      pickAppliedRef.current = true;
      try { sessionStorage.removeItem('pendingPickColor'); } catch {}
      moves.chooseColor(stashedColor as Color);
    }
  }, [iMustPick, moves]);

  // Auto-pass: after combat resolves on my turn, if I have no playable cards
  // in hand AND no untapped, non-sick memes that could still attack, end the
  // turn automatically. Honors target-selection mode so we never interrupt it.
  const wasBlockersRef = useRef(false);
  const autoPassedTurnRef = useRef<number | null>(null);
  useEffect(() => {
    if (pickPhase || !myTurn || ctx.gameover) return;
    const oppInBlockers = ctx.activePlayers?.[oppId] === 'blockers';
    if (oppInBlockers) { wasBlockersRef.current = true; return; }
    if (!wasBlockersRef.current) return;
    // Combat just resolved on my main phase.
    wasBlockersRef.current = false;
    if (autoPassedTurnRef.current === ctx.turn) return;
    if (selectedHand != null || targetMode != null) return;

    // Untapped, non-sick meme that could attack again?
    const hasReadyAttacker = me.memes.some(m => !m.tapped && !m.summoningSick);

    // Potential gas this turn = current pool + 1 of each untapped node's color.
    const avail: Record<Color, number> = { ...me.gas } as Record<Color, number>;
    for (const n of me.nodes) {
      if (!n.tapped) {
        const ndef = CARDS[n.defId];
        if (ndef) avail[ndef.color] = (avail[ndef.color] ?? 0) + 1;
      }
    }
    const extraNodes = me.machines.filter(mm => CARDS[mm.defId]?.effect === 'extra_node_per_turn').length;
    const nodesLeft = (1 + extraNodes) - me.nodesPlayedThisTurn;

    const canPlayAnything = me.hand.some(defId => {
      const def = CARDS[defId];
      if (!def) return false;
      if (def.type === 'node') return nodesLeft > 0;
      const cost = def.cost ?? {};
      // Colored requirement
      let leftover = 0;
      let okColored = true;
      for (const c of COLORS) {
        const need = cost[c] ?? 0;
        if (need > (avail[c] ?? 0)) { okColored = false; break; }
        leftover += (avail[c] ?? 0) - need;
      }
      if (!okColored) return false;
      return (cost.any ?? 0) <= leftover;
    });

    if (!canPlayAnything && !hasReadyAttacker) {
      autoPassedTurnRef.current = ctx.turn;
      const t = window.setTimeout(() => {
        // Re-check the latest state-derived predicates via closure-fresh values.
        moves.passTurn();
      }, 500);
      return () => window.clearTimeout(t);
    }
  }, [ctx.activePlayers, ctx.turn, ctx.gameover, myTurn, oppId, pickPhase, selectedHand, targetMode, me, moves]);

  // Auto-skip block phase: if I'm the defender in the blockers stage and I have
  // no untapped memes available to block, confirm-blocks immediately.
  const autoSkippedBlockTurnRef = useRef<number | null>(null);
  useEffect(() => {
    if (pickPhase || ctx.gameover) return;
    if (ctx.activePlayers?.[myId] !== 'blockers') return;
    if (autoSkippedBlockTurnRef.current === ctx.turn) return;
    const hasBlocker = me.memes.some(m => !m.tapped);
    if (hasBlocker) return;
    autoSkippedBlockTurnRef.current = ctx.turn;
    const t = window.setTimeout(() => moves.confirmBlocks(), 500);
    return () => window.clearTimeout(t);
  }, [ctx.activePlayers, ctx.turn, ctx.gameover, myId, pickPhase, me, moves]);

  function tryPlay(idx: number) {
    const defId = me.hand[idx];
    const def = CARDS[defId];
    if (!def) return;
    if (def.type === 'move') {
      const needsTarget =
        def.effect === 'destroyMeme' || def.effect === 'bounceMeme' ||
        def.effect === 'destroyMachine' ||
        def.effect === 'damage2' || def.effect === 'damage3' || def.effect === 'damage5';
      if (needsTarget) {
        setSelectedHand(idx);
        const kind: 'meme' | 'any' | 'machine' =
          def.effect === 'destroyMachine' ? 'machine' :
          (def.effect === 'damage2' || def.effect === 'damage3' || def.effect === 'damage5') ? 'any' :
          'meme';
        setTargetMode({ kind });
        return;
      }
    }
    moves.playCard(idx);
  }

  function pickTarget(uid: string) {
    if (selectedHand == null) return;
    moves.playCard(selectedHand, uid);
    setSelectedHand(null);
    setTargetMode(null);
  }

  const [blockSel, setBlockSel] = useState<{ blockerUid?: string }>({});
  const [notice, setNotice] = useState<string>('');
  function flash(msg: string) {
    setNotice(msg);
    window.setTimeout(() => setNotice(n => (n === msg ? '' : n)), 2200);
  }

  // ── Profile names from lobby + W/L tracking via API ────────────────────────
  // Prefer lobby-supplied player names (online play). Fall back to in-game profileName (local play).
  const myName  = matchData?.find(p => String(p.id) === myId )?.name  || me.profileName  || `Player ${myId}`;
  const oppName = matchData?.find(p => String(p.id) === oppId)?.name  || opp.profileName || `Player ${oppId}`;

  const [myProfile,  setMyProfile]  = useState<Profile | null>(null);
  const [oppProfile, setOppProfile] = useState<Profile | null>(null);

  // Fetch profiles initially and again whenever a result is recorded.
  const refreshProfiles = React.useCallback(() => {
    getProfileApi(myName).then(setMyProfile).catch(() => {});
    getProfileApi(oppName).then(setOppProfile).catch(() => {});
  }, [myName, oppName]);
  useEffect(() => { refreshProfiles(); }, [refreshProfiles]);

  // On gameover, post result to API. Server dedupes by matchID so it's safe for both clients to post.
  const recordedRef = useRef(false);
  useEffect(() => {
    if (!ctx.gameover || recordedRef.current || !matchID) return;
    recordedRef.current = true;
    const draw = !!ctx.gameover.draw;
    const winnerId = ctx.gameover.winner as string | undefined;
    const winnerName = winnerId === myId ? myName : winnerId === oppId ? oppName : null;
    const loserName  = winnerName ? (winnerName === myName ? oppName : myName) : null;
    const rankedMeta = G.ranked
      ? {
          ranked: true,
          seasonId: G.ranked.seasonId,
          // Seat 0 / 1 mapping: keep stable as p0/p1 for the rating service.
          player0: myId === '0' ? myName : oppName,
          player1: myId === '0' ? oppName : myName,
          startedAt: G.ranked.startedAt,
          replaySeed: matchID,
        }
      : {};
    const wagerMeta = G.wager?.kind === 'master' && G.wager.onchainId && !draw
      ? { wager: { onchainId: G.wager.onchainId, winnerSeat: winnerId === '0' ? '0' : '1' } }
      : {};
    recordResultApi(matchID, {
      winner: draw ? null : winnerName,
      loser:  draw ? null : loserName,
      draw,
      ...rankedMeta,
      ...wagerMeta,
    } as any).then(() => refreshProfiles()).catch(e => console.warn('record result failed', e));
  }, [ctx.gameover, matchID, myId, oppId, myName, oppName, refreshProfiles]);

  // ── Render ────────────────────────────────────────────────────────────────
  const [showRules, setShowRules] = useState(false);
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: mobile ? 6 : 8, color: '#eee', background: '#0a0a10', minHeight: '100vh', height: mobile ? 'auto' : '100dvh', display: 'flex', flexDirection: 'column', overflow: mobile ? 'visible' : 'hidden' }}>
      {/* Compact top status bar */}
      <TurnBanner
        myTurn={myTurn} turn={ctx.turn}
        phase={inBlockers ? 'block' : myTurn ? 'main' : 'wait'}
        myName={myName} oppName={oppName}
        myProfile={myProfile} oppProfile={oppProfile}
        onOpenRules={() => setShowRules(true)}
        onEndTurn={() => moves.passTurn()}
        canEndTurn={myTurn && !inBlockers && !ctx.gameover && !mulliganPhase}
        attackerCount={G.combat.attackers.length}
        onConfirmAttackers={() => moves.confirmAttackers()}
        canAttack={myTurn && !inBlockers && !ctx.gameover && !mulliganPhase}
        inBlockers={inBlockers}
        onConfirmBlocks={() => moves.confirmBlocks()}
      />

      {/* Floating Rules drawer */}
      {showRules && <RulesDrawer onClose={() => setShowRules(false)} />}

      {/* Pre-game mulligan overlay */}
      {mulliganPhase && !iMustPick && (
        <MulliganModal
          hand={me.hand}
          mulliganCount={myMulliganCount}
          done={myMulliganDone}
          oppDone={oppMulliganDone}
          deadline={G.mulligan?.deadline ?? 0}
          onKeep={() => moves.keepHand()}
          onMulligan={() => moves.mulligan()}
          onForceEnd={() => moves.forceKeepOpponent()}
        />
      )}

      {/* Deck-pick overlay — second player picks here if they arrived without a stashed color */}
      {iMustPick && (
        <div style={{
          padding: 16, marginBottom: 10,
          background: 'linear-gradient(180deg, rgba(26,18,64,0.92), rgba(10,10,30,0.92))',
          border: '1px solid #4c1d95', borderRadius: 6,
          boxShadow: '0 0 14px rgba(139,92,246,0.25)',
          fontFamily: '"EB Garamond", Garamond, "Times New Roman", serif',
          color: '#ece1c7',
        }}>
          <div style={{
            fontFamily: '"Cinzel", "Times New Roman", serif',
            fontWeight: 800, fontSize: 14, letterSpacing: 2,
            color: '#f0b32a', textTransform: 'uppercase',
            textShadow: '0 0 8px rgba(240,179,42,0.35)',
            marginBottom: 6,
          }}>Choose your deck</div>
          <div style={{ fontSize: 12, color: '#cdbf99', marginBottom: 10 }}>
            The match has begun. Pick a chain to play with — your deck will be shuffled and dealt.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {COLORS.map(c => {
              const meta = COLOR_META[c];
              return (
                <button key={c} onClick={() => moves.chooseColor(c)} style={{
                  padding: '10px 16px',
                  background: meta.hex, color: meta.ink,
                  border: '2px solid #000', borderRadius: 6, fontWeight: 800, cursor: 'pointer', fontSize: 13,
                }}>{meta.name}</button>
              );
            })}
          </div>
        </div>
      )}

      {/* Waiting banner — opponent hasn't picked yet */}
      {!iMustPick && opp?.needsColorPick && (
        <div style={{
          padding: '8px 14px', marginBottom: 10, fontSize: 13,
          fontFamily: '"EB Garamond", Garamond, "Times New Roman", serif',
          background: 'linear-gradient(180deg, rgba(26,18,64,0.92), rgba(10,10,30,0.92))',
          border: '1px solid #4c1d95', borderRadius: 6, color: '#ece1c7',
          boxShadow: '0 0 14px rgba(139,92,246,0.25)',
        }}>
          Waiting for opponent to choose their deck…
        </div>
      )}

      {/* Step instructions */}
      {!ctx.gameover && !pickPhase && (
        <div style={{
          padding: '8px 14px', marginBottom: 6, fontSize: 13,
          fontFamily: '"EB Garamond", Garamond, "Times New Roman", serif',
          background: inBlockers
            ? 'linear-gradient(180deg, rgba(64,40,8,0.92), rgba(28,16,4,0.92))'
            : (myTurn
                ? 'linear-gradient(180deg, rgba(26,18,64,0.92), rgba(10,10,30,0.92))'
                : 'linear-gradient(180deg, rgba(20,20,28,0.92), rgba(10,10,16,0.92))'),
          border: `1px solid ${inBlockers ? '#a8740f' : (myTurn ? '#4c1d95' : '#2a2a36')}`,
          borderRadius: 6,
          color: '#ece1c7',
          boxShadow: inBlockers
            ? '0 0 14px rgba(240,179,42,0.25)'
            : (myTurn ? '0 0 14px rgba(139,92,246,0.25)' : 'none'),
        }}>
          {inBlockers
            ? <><CTA color="#f0b32a">Declare blockers:</CTA> click an untapped meme below to select it, then click an attacking opponent meme above. Press <i>Confirm Blocks</i> when done (or with no blockers to take damage).</>
            : myTurn
              ? (G.combat.attackers.length > 0
                  ? <><CTA color="#f0b32a">{G.combat.attackers.length} attacker(s) selected.</CTA> Click another untapped meme to add, or press <i>Attack with {G.combat.attackers.length} meme(s)</i> to swing.</>
                  : <><CTA color="#b896ff">Your main phase.</CTA> Play nodes, tap them for gas, cast cards. Click an untapped, non-sick meme to mark it as an attacker, then press <i>Attack</i>.</>)
              : <>Waiting for opponent…</>}
        </div>
      )}

      {notice && (
        <div style={{ padding: '6px 10px', marginBottom: 6, fontSize: 12, background: '#3a0a0a', border: '1px solid #844', borderRadius: 4, color: '#fdd' }}>
          {notice}
        </div>
      )}

      {ctx.gameover && (
        <div style={{ padding: 12, background: '#222', border: '1px solid #555', marginBottom: 8 }}>
          {ctx.gameover.draw
            ? <b>Draw! Both records +1 D.</b>
            : <b>Winner: {ctx.gameover.winner === myId ? myName : oppName} — {ctx.gameover.winner === myId ? 'you got +1 W' : 'you got +1 L'}</b>}
        </div>
      )}

      <WagerPayoutModal
        gameover={ctx.gameover}
        wager={G.wager}
        myId={myId}
        oppId={oppId}
        myName={myName} oppName={oppName}
        myProfile={myProfile} oppProfile={oppProfile}
      />

      <WinnerShareModal
        gameover={ctx.gameover}
        myId={myId}
        myName={myName}
      />

      {/* Combat zone display */}
      <CombatStrip G={G} ctx={ctx} myId={myId} />

      {/* Playmat — sized to fit alongside hand without scrolling */}
      <div style={{
        margin: '8px auto',
        width: '100%',
        maxWidth: mobile ? '100%' : 'min(1280px, calc(100dvh - 280px))',
      }}>
        <Playmat
        me={me} opp={opp} myId={myId} oppId={oppId}
        myName={myName} oppName={oppName}
        myDeckCount={(G as any).deckCounts?.[myId]  ?? 0}
        oppDeckCount={(G as any).deckCounts?.[oppId] ?? 0}
        attackers={G.combat.attackers.map(a => a.memeUid)}
        attackerSide={ctx.currentPlayer === myId ? 'me' : 'opp'}
        blocks={G.combat.blocks}
        selectedBlocker={blockSel.blockerUid}
        memeTargetable={targetMode?.kind === 'meme' || targetMode?.kind === 'any'}
        machineTargetable={targetMode?.kind === 'machine'}
        playerTargetable={targetMode?.kind === 'any'}
        onOppPlayerClick={() => pickTarget(oppId === '0' ? '__p0__' : '__p1__')}
        onMyPlayerClick={()  => pickTarget(myId  === '0' ? '__p0__' : '__p1__')}
        onNodeClick={uid => isActive && myTurn && !inBlockers && moves.tapNode(uid)}
        onMyMemeClick={uid => {
          if (targetMode?.kind === 'meme' || targetMode?.kind === 'any') pickTarget(uid);
          else if (inBlockers) {
            const m = me.memes.find(x => x.uid === uid); if (!m) return;
            if (m.tapped) { flash(`That meme is tapped — can't block.`); return; }
            setBlockSel({ blockerUid: uid });
          } else if (myTurn) {
            const m = me.memes.find(x => x.uid === uid); if (!m) return;
            if (m.summoningSick) { flash(`${CARDS[m.defId].name} is summoning sick — can't attack until your next turn.`); return; }
            if (m.tapped)        { flash(`${CARDS[m.defId].name} is tapped — can't attack.`); return; }
            moves.declareAttacker(uid);
          }
        }}
        onOppMemeClick={uid => {
          if (targetMode?.kind === 'meme' || targetMode?.kind === 'any') { pickTarget(uid); return; }
          if (inBlockers) {
            // Assigning a block: must have a blocker selected and the clicked
            // opponent meme must actually be an attacker.
            if (!blockSel.blockerUid) { flash('Click one of your untapped memes first to select a blocker.'); return; }
            if (!G.combat.attackers.some(a => a.memeUid === uid)) { flash('That opponent meme is not attacking — pick one of the attackers above.'); return; }
            moves.declareBlocker(blockSel.blockerUid, uid);
            setBlockSel({});
          }
        }}
        onMachineClick={uid => { if (targetMode?.kind === 'machine') pickTarget(uid); }}
      />
      </div>

      {/* Hand — curved fan layout on desktop */}
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 11, opacity: 0.6, letterSpacing: 1, textTransform: 'uppercase', fontWeight: 700, textAlign: 'center', marginBottom: 4 }}>
          ✋ Hand · {me.hand.length}
        </div>
        <div style={{
          display: 'flex', flexWrap: mobile ? 'nowrap' : 'nowrap',
          overflowX: mobile ? 'auto' : 'visible',
          WebkitOverflowScrolling: 'touch',
          paddingBottom: mobile ? 6 : 0,
          justifyContent: 'center', alignItems: 'flex-end',
          minHeight: mobile ? 130 : 160,
          perspective: 1200,
        }}>
          {me.hand.map((id, i) => {
            const n = me.hand.length;
            // Curve: rotate cards around an arc, slight upward lift toward center.
            const t = n === 1 ? 0 : (i - (n - 1) / 2) / Math.max(1, (n - 1) / 2);  // -1..1
            const rot = mobile ? 0 : t * 6;          // ±6° fan
            const lift = mobile ? 0 : Math.abs(t) * 8;
            const overlap = mobile ? 0 : -18;        // slight overlap
            return (
              <div key={i} style={{
                transform: `translateY(${lift}px) rotate(${rot}deg)`,
                transformOrigin: '50% 100%',
                marginLeft: i === 0 ? 0 : overlap,
                transition: 'transform 0.18s ease',
                zIndex: selectedHand === i ? 10 : i,
              }}
                onMouseEnter={e => { if (!mobile) e.currentTarget.style.transform = `translateY(-14px) rotate(${rot * 0.4}deg) scale(1.08)`; }}
                onMouseLeave={e => { if (!mobile) e.currentTarget.style.transform = `translateY(${lift}px) rotate(${rot}deg)`; }}
              >
                <CardFace
                  defId={id}
                  selected={selectedHand === i}
                  onClick={() => isActive && myTurn && !inBlockers && tryPlay(i)}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Action bar */}
      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <GasBar gas={me.gas} />
        {myTurn && !inBlockers && (
          <>
            <button onClick={() => moves.confirmAttackers()} disabled={G.combat.attackers.length === 0}>
              Attack with {G.combat.attackers.length} meme(s)
            </button>
            <button onClick={() => moves.passTurn()}>End Turn</button>
          </>
        )}
        {inBlockers && (
          <>
            <button onClick={() => moves.confirmBlocks()}>Confirm Blocks</button>
            <span style={{ fontSize: 12 }}>
              {blockSel.blockerUid
                ? `Blocker selected (${blockSel.blockerUid}). Click an attacking opponent meme above to assign it.`
                : 'Click one of your untapped memes to block.'}
            </span>
          </>
        )}
        {targetMode && (
          <button onClick={() => { setSelectedHand(null); setTargetMode(null); }}>Cancel target</button>
        )}
      </div>

      {/* Block assignment row */}
      {inBlockers && blockSel.blockerUid && (
        <div style={{ marginTop: 8, padding: 8, border: '1px dashed #888' }}>
          <div style={{ fontSize: 12, marginBottom: 4 }}>Assign blocker {blockSel.blockerUid} to attacker:</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {G.combat.attackers.map(a => (
              <button key={a.memeUid} onClick={() => {
                moves.declareBlocker(blockSel.blockerUid!, a.memeUid);
                setBlockSel({});
              }}>{a.memeUid}</button>
            ))}
          </div>
        </div>
      )}

      {/* Log */}
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: 'pointer', opacity: 0.7 }}>Log ({G.log.length})</summary>
        <pre style={{ fontSize: 11, maxHeight: 200, overflow: 'auto', background: '#000', padding: 8 }}>
          {G.log.slice(-80).join('\n')}
        </pre>
      </details>

      {/* Chat */}
      <ChatPanel
        myId={myId}
        messages={chatMessages ?? []}
        sendChatMessage={sendChatMessage}
      />
    </div>
  );
}

function ChatPanel({
  myId, messages, sendChatMessage,
}: {
  myId: string;
  messages: Array<{ id: string; sender: string; payload: any }>;
  sendChatMessage?: (msg: any) => void;
}) {
  const [draft, setDraft] = useState('');
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length]);

  function send() {
    const text = draft.trim();
    if (!text || !sendChatMessage) return;
    sendChatMessage({ text });
    setDraft('');
  }

  return (
    <div style={{ marginTop: 12, border: '1px solid #444', borderRadius: 6, background: '#161616' }}>
      <div style={{ padding: '6px 10px', background: '#222', fontSize: 12, fontWeight: 700, color: '#ccc', borderBottom: '1px solid #333' }}>
        Chat
      </div>
      <div ref={listRef} style={{ maxHeight: 160, overflowY: 'auto', padding: 8, fontSize: 12, fontFamily: 'system-ui' }}>
        {messages.length === 0 && (
          <div style={{ color: '#666', fontStyle: 'italic' }}>No messages yet. Talk smack.</div>
        )}
        {messages.map(m => {
          const mine = m.sender === myId;
          const text = typeof m.payload === 'string'
            ? m.payload
            : (m.payload && typeof m.payload.text === 'string' ? m.payload.text : JSON.stringify(m.payload));
          return (
            <div key={m.id} style={{ marginBottom: 4, color: mine ? '#9f9' : '#9cf' }}>
              <span style={{ fontWeight: 700 }}>P{m.sender}{mine ? ' (you)' : ''}:</span>{' '}
              <span style={{ color: '#eee' }}>{text}</span>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 6, padding: 6, borderTop: '1px solid #333', background: '#1a1a1a' }}>
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send(); }}
          placeholder={sendChatMessage ? 'Type a message and press Enter' : 'Chat unavailable'}
          disabled={!sendChatMessage}
          style={{
            flex: 1, padding: '6px 8px', background: '#000', color: '#eee',
            border: '1px solid #444', borderRadius: 4, fontFamily: 'system-ui', fontSize: 12,
          }}
        />
        <button
          onClick={send}
          disabled={!sendChatMessage || !draft.trim()}
          style={{
            padding: '6px 14px', background: '#2a7', color: '#fff',
            border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 700, fontSize: 12,
          }}
        >Send</button>
      </div>
    </div>
  );
}

function WagerPayoutModal({
  gameover, wager, myId, oppId, myName, oppName, myProfile, oppProfile,
}: {
  gameover: any;
  wager: GState['wager'];
  myId: string; oppId: string;
  myName: string; oppName: string;
  myProfile: Profile | null; oppProfile: Profile | null;
}) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { setDismissed(false); }, [gameover?.winner, gameover?.draw]);
  if (!gameover || !wager || wager.kind !== 'master' || !wager.amount) return null;
  if (gameover.draw) return null;
  if (dismissed) return null;

  const iWon = gameover.winner === myId;
  const winnerName = iWon ? myName : oppName;
  const winnerProfile = iWon ? myProfile : oppProfile;
  const winnerWallet = winnerProfile?.walletAddress || null;
  const winnerChain = (winnerProfile?.walletChain || '').toUpperCase() || 'WALLET';
  const amount = wager.amount;
  const loserId = iWon ? oppId : myId;
  void loserId;

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); } catch {}
  }

  return (
    <div onClick={() => setDismissed(true)} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
      fontFamily: '"EB Garamond", Garamond, "Times New Roman", serif',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'linear-gradient(180deg, #1a1240 0%, #0a0a1e 100%)',
        border: '2px solid #4c1d95', borderRadius: 10,
        padding: 24, width: 'min(520px, calc(100vw - 24px))',
        boxShadow: '0 0 40px rgba(139,92,246,0.45)',
        color: '#ece1c7',
      }}>
        <div style={{
          fontFamily: '"Cinzel", "Times New Roman", serif',
          fontSize: 20, fontWeight: 800, letterSpacing: 2,
          color: '#f0b32a', textTransform: 'uppercase',
          textShadow: '0 0 14px rgba(240,179,42,0.45)',
          textAlign: 'center', marginBottom: 4,
        }}>
          {iWon ? 'Victory' : 'Defeat'}
        </div>
        <div style={{ textAlign: 'center', color: '#b896ff', fontSize: 13, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 16 }}>
          Wagered Match · {amount} $MASTER
        </div>

        <div style={{
          padding: 14, background: 'rgba(0,0,0,0.45)',
          border: '1px solid rgba(240,179,42,0.4)', borderRadius: 6, marginBottom: 14,
        }}>
          <div style={{ fontSize: 12, color: '#a99878', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
            Winner
          </div>
          <div style={{
            fontFamily: '"Cinzel", "Times New Roman", serif',
            fontSize: 18, fontWeight: 700, color: '#ffd66e', marginBottom: 10,
          }}>{winnerName}</div>

          <div style={{ fontSize: 12, color: '#a99878', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
            {winnerChain} Wallet
          </div>
          {winnerWallet ? (
            <div style={{
              display: 'flex', gap: 8, alignItems: 'center',
              padding: '8px 10px', background: '#000',
              border: '1px solid #4c1d95', borderRadius: 4,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 12, color: '#ece1c7', wordBreak: 'break-all',
            }}>
              <span style={{ flex: 1 }}>{winnerWallet}</span>
              <button onClick={() => copy(winnerWallet)} style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 800,
                background: '#4c1d95', color: '#fff', border: '1px solid #6b2fc9',
                borderRadius: 3, cursor: 'pointer', letterSpacing: 0.5, textTransform: 'uppercase',
              }}>Copy</button>
            </div>
          ) : (
            <div style={{
              padding: '8px 10px', background: 'rgba(120,80,20,0.25)',
              border: '1px solid #a8740f', borderRadius: 4,
              fontSize: 12, color: '#f0b32a',
            }}>Winner has no wallet linked to their profile.</div>
          )}
        </div>

        <div style={{
          fontSize: 15, textAlign: 'center', color: '#ece1c7',
          padding: '10px 6px', lineHeight: 1.45,
        }}>
          {iWon
            ? <>You won the wager. Ask <b style={{ color: '#ffd66e' }}>{oppName}</b> to send you <b style={{ color: '#ffd66e' }}>{amount} $MASTER</b>.</>
            : <>Please pay the winner <b style={{ color: '#ffd66e' }}>{amount} $MASTER</b>.</>}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={() => setDismissed(true)} style={{
            padding: '8px 16px', fontWeight: 800, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase',
            background: 'linear-gradient(180deg, #f0b32a, #a8740f)', color: '#1a1408',
            border: '1px solid #6a5520', borderRadius: 4, cursor: 'pointer',
            fontFamily: '"Cinzel", "Times New Roman", serif',
          }}>Close</button>
        </div>
      </div>
    </div>
  );
}

function WinnerShareModal({ gameover, myId, myName }: { gameover: any; myId: string; myName: string }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { setDismissed(false); }, [gameover?.winner, gameover?.draw]);
  if (!gameover || gameover.draw) return null;
  if (gameover.winner !== myId) return null;
  if (dismissed) return null;

  const siteUrl = (typeof window !== 'undefined' ? window.location.origin : 'https://memetic-masters.onrender.com');
  const imgUrl = `${siteUrl}/share-win.jpg`;
  const tweetText = `I just won in Memetic Masters TCG! ⚔️\n\nPlay the 5-chain meme card game at ${siteUrl}`;
  const intentUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;

  async function downloadImage() {
    try {
      const r = await fetch('/share-win.jpg');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'memetic-masters-win.jpg';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      window.open('/share-win.jpg', '_blank');
    }
  }

  return (
    <div onClick={() => setDismissed(true)} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 199,
      fontFamily: '"EB Garamond", Garamond, "Times New Roman", serif',
      padding: 12,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'linear-gradient(180deg, #1a1240 0%, #0a0a1e 100%)',
        border: '2px solid #4c1d95', borderRadius: 10,
        padding: 20, width: 'min(560px, calc(100vw - 24px))',
        maxHeight: 'calc(100vh - 24px)', overflowY: 'auto',
        boxShadow: '0 0 40px rgba(139,92,246,0.45)',
        color: '#ece1c7',
      }}>
        <div style={{
          fontFamily: '"Cinzel", "Times New Roman", serif',
          fontSize: 22, fontWeight: 800, letterSpacing: 2,
          color: '#f0b32a', textTransform: 'uppercase',
          textShadow: '0 0 14px rgba(240,179,42,0.45)',
          textAlign: 'center', marginBottom: 4,
        }}>Victory, {myName}</div>
        <div style={{
          textAlign: 'center', color: '#b896ff',
          fontSize: 12, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 14,
        }}>Share your win</div>

        <img src={imgUrl} alt="I just won in Memetic Masters"
          style={{
            display: 'block', width: '100%', height: 'auto',
            borderRadius: 6, border: '1px solid rgba(240,179,42,0.4)',
            marginBottom: 12,
          }}
        />

        <div style={{
          fontSize: 13, color: '#cdbf99', lineHeight: 1.45,
          padding: '0 4px 12px', textAlign: 'center',
        }}>
          Click <b style={{ color: '#ffd66e' }}>Share on X</b> to open a pre-filled post,
          then attach the downloaded image.
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          <a href={intentUrl} target="_blank" rel="noopener noreferrer" style={{
            padding: '10px 18px', fontWeight: 800, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase',
            background: '#000', color: '#fff', border: '1px solid #ffd66e', borderRadius: 4,
            textDecoration: 'none', cursor: 'pointer',
            fontFamily: '"Cinzel", "Times New Roman", serif',
          }}>Share on X</a>
          <button onClick={downloadImage} style={{
            padding: '10px 18px', fontWeight: 800, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase',
            background: 'linear-gradient(180deg, #4c1d95, #2a0f5a)', color: '#ece1c7',
            border: '1px solid #6b2fc9', borderRadius: 4, cursor: 'pointer',
            fontFamily: '"Cinzel", "Times New Roman", serif',
          }}>Download Image</button>
          <button onClick={() => setDismissed(true)} style={{
            padding: '10px 18px', fontWeight: 800, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase',
            background: 'linear-gradient(180deg, #f0b32a, #a8740f)', color: '#1a1408',
            border: '1px solid #6a5520', borderRadius: 4, cursor: 'pointer',
            fontFamily: '"Cinzel", "Times New Roman", serif',
          }}>Close</button>
        </div>
      </div>
    </div>
  );
}

function CTA({ color, children }: { color: string; children: React.ReactNode }) {
  return <b style={{
    fontFamily: '"Cinzel", "Times New Roman", serif',
    color, letterSpacing: 1.2, textTransform: 'uppercase', fontWeight: 700,
    textShadow: `0 0 6px ${color}55`,
  }}>{children}</b>;
}

function PlayerHeaderTargetable({ label, clickable, onClick }: { label: string; clickable: boolean; onClick: () => void }) {
  return (
    <div onClick={clickable ? onClick : undefined}
      style={{
        padding: '4px 8px', margin: '4px 0',
        background: clickable ? '#553' : '#222',
        cursor: clickable ? 'pointer' : 'default',
        border: '1px solid #555', fontWeight: 700,
      }}>
      {label} {clickable && <span style={{fontSize:11, opacity:0.7}}>(click to target)</span>}
    </div>
  );
}

// ── Playmat — positions zones over the splash mat image ─────────────────────
/**
 * Beginner rules columns shown either side of the playmat on desktop.
 * Two halves so each side fits a roughly 1100px-tall playmat without scrolling.
 */
function RulesPanel({ side }: { side: 'left' | 'right' }) {
  const sections: Array<{ heading: string; body: React.ReactNode }> = side === 'left'
    ? [
        {
          heading: 'Goal',
          body: 'Reduce your opponent\u2019s life from 20 to 0. You win when they hit zero (or run out of cards in their deck and can\u2019t draw).',
        },
        {
          heading: 'Gas (mana)',
          body: 'Every non-Node card has a cost shown by colored pips: Orange\u00A0BnB, Purple\u00A0Solana, Green\u00A0Hyperliquid, White\u00A0Ethereum, Black\u00A0XRP. You pay that cost by tapping your Nodes.',
        },
        {
          heading: 'Nodes',
          body: 'Nodes are your land. Once per turn you may play one Node from hand — it enters untapped. Click it any time on your turn to tap it for 1 gas of its color. Nodes untap at the start of your next turn.',
        },
        {
          heading: 'The 4 card types',
          body: (
            <>
              <div><b style={{ color: '#ffd66e' }}>Node</b> — land, generates 1 gas of its color when tapped.</div>
              <div><b style={{ color: '#ffd66e' }}>Meme</b> — creature with Power/Toughness. Attacks and blocks.</div>
              <div><b style={{ color: '#ffd66e' }}>Machine</b> — artifact. Stays in play and gives a constant effect.</div>
              <div><b style={{ color: '#ffd66e' }}>Move</b> — single-use spell. Resolves once then goes to graveyard.</div>
            </>
          ),
        },
        {
          heading: 'Summoning sickness',
          body: 'Memes you just played CAN\u2019T attack the turn they enter. They can block right away though. A small SICK badge marks them.',
        },
        {
          heading: 'Turn order',
          body: (
            <>
              <div>1. <b style={{ color: '#ffd66e' }}>Untap</b> — your Nodes and Memes untap.</div>
              <div>2. <b style={{ color: '#ffd66e' }}>Draw</b> — draw 1 card.</div>
              <div>3. <b style={{ color: '#ffd66e' }}>Main</b> — play 1 Node, summon Memes, deploy Machines, cast Moves, tap Nodes for gas.</div>
              <div>4. <b style={{ color: '#ffd66e' }}>Combat</b> — pick attackers, opponent picks blockers, damage resolves.</div>
              <div>5. <b style={{ color: '#ffd66e' }}>End</b> — press <i>Pass Turn</i>.</div>
            </>
          ),
        },
      ]
    : [
        {
          heading: 'Attacking',
          body: 'During your turn click an untapped, non-sick meme to add it to the attack. Press the Attack button to swing — attackers tap.',
        },
        {
          heading: 'Blocking',
          body: 'When opponent attacks, click ONE of your untapped memes to select it as a blocker, then click the attacker you want it to block. Repeat for each block. Press Confirm Blocks when done.',
        },
        {
          heading: 'Damage',
          body: 'In a fight, both memes deal their Power to each other. If a meme takes damage ≥ its Toughness it dies and goes to the graveyard. Unblocked attackers hit the defender\u2019s life total directly.',
        },
        {
          heading: 'Hand limit',
          body: 'No hand size limit during your turn. Drawing from an empty deck means you lose. Start with 7 cards.',
        },
        {
          heading: 'Machines',
          body: 'Machines are permanent. As long as one is on the battlefield, its effect is active — e.g. "your memes get +1/+1." Stack multiple for stronger effects.',
        },
        {
          heading: 'Moves',
          body: 'Casting a Move resolves its effect right away, then sends it to the graveyard. Targeted Moves will ask you to click a target (meme, machine, or player).',
        },
        {
          heading: 'First-game tips',
          body: (
            <>
              <div>• Play a Node every turn if you can — gas is everything.</div>
              <div>• Don\u2019t over-extend into removal Moves; keep one defender back.</div>
              <div>• Hover any card to see a big preview with its full text.</div>
              <div>• Tap multiple nodes BEFORE casting so you can afford the spell.</div>
            </>
          ),
        },
      ];

  return (
    <aside style={{
      flex: '0 0 210px',
      maxWidth: 230,
      alignSelf: 'stretch',
      padding: 12,
      background: 'linear-gradient(180deg, rgba(26,18,64,0.92) 0%, rgba(10,10,30,0.92) 100%)',
      border: '1px solid #4c1d95',
      borderRadius: 8,
      boxShadow: '0 0 22px rgba(139,92,246,0.25), inset 0 0 24px rgba(0,0,0,0.45)',
      color: '#ece1c7',
      fontSize: 12,
      lineHeight: 1.45,
      fontFamily: '"EB Garamond", Garamond, "Times New Roman", serif',
      maxHeight: '1100px',
      overflowY: 'auto',
    }}>
      <div style={{
        fontFamily: '"Cinzel", "Times New Roman", serif',
        fontWeight: 800, fontSize: 13, letterSpacing: 2,
        color: '#f0b32a', textTransform: 'uppercase',
        textShadow: '0 0 8px rgba(240,179,42,0.4)',
        borderBottom: '1px solid rgba(240,179,42,0.35)', paddingBottom: 6, marginBottom: 10,
        textAlign: 'center',
      }}>
        {side === 'left' ? 'How to Play · I' : 'How to Play · II'}
      </div>
      {sections.map((s, i) => (
        <div key={i} style={{ marginBottom: 12 }}>
          <div style={{
            fontFamily: '"Cinzel", "Times New Roman", serif',
            fontWeight: 700, fontSize: 11.5, letterSpacing: 1.5,
            color: '#b896ff', textTransform: 'uppercase',
            marginBottom: 4,
          }}>{s.heading}</div>
          <div style={{ color: '#ece1c7' }}>{s.body}</div>
        </div>
      ))}
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cascade-stack rendering for Nodes. When a player controls 3+ copies of the
// same Node def, we collapse them visually into one tile with ghost layers
// behind it. Clicking the stack taps the next available untapped node.
// ─────────────────────────────────────────────────────────────────────────────
function NodeStack({
  group, onClick,
}: {
  group: Instance[];
  onClick?: (uid: string) => void;
}) {
  // Untapped nodes float to the front so the click target is always live.
  const sorted = [...group].sort((a, b) => Number(a.tapped) - Number(b.tapped));
  const top = sorted[0];
  const tappedCount = group.filter(g => g.tapped).length;
  const allTapped = tappedCount === group.length;
  const ghostLayers = Math.min(3, group.length - 1);
  const total = group.length;

  const handleClick = () => {
    if (allTapped || !onClick) return;
    const target = sorted.find(g => !g.tapped);
    if (target) onClick(target.uid);
  };

  return (
    <div style={{
      position: 'relative',
      width: 68, height: 96,
      // Reserve room for the offset ghost layers so adjacent zones don't overlap us.
      marginRight: 4 * ghostLayers,
      marginBottom: 4 * ghostLayers,
    }}
    title={allTapped
      ? `All ${total} tapped — wait for next turn.`
      : `×${total} stacked (${tappedCount} tapped). Click to tap the next available.`}
    >
      {/* Ghost copies of the stack — purely cosmetic, slight rotation + offset. */}
      {Array.from({ length: ghostLayers }).map((_, i) => {
        const depth = ghostLayers - i;       // 1..ghostLayers, deepest first
        const def = CARDS[top.defId];
        if (!def) return null;
        const meta = COLOR_META[def.color];
        const rot  = (i % 2 === 0 ? 1 : -1) * 1.5 * (depth);
        return (
          <div key={i} aria-hidden style={{
            position: 'absolute',
            left: 4 * depth, top: 4 * depth,
            width: 68, height: 96, borderRadius: 6,
            background: meta.hex, opacity: 0.55,
            border: '1px solid #000',
            boxShadow: '0 2px 6px #000a',
            transform: `rotate(${rot}deg)`,
            pointerEvents: 'none',
            zIndex: 0,
          }} />
        );
      })}
      {/* Top live card */}
      <div style={{ position: 'relative', zIndex: 1 }}>
        <MiniCard
          defId={top.defId}
          instance={top}
          faceUp
          onClick={onClick && !allTapped ? handleClick : undefined}
        />
      </div>
      {/* Count badge */}
      <div style={{
        position: 'absolute',
        right: -6, top: -6,
        background: allTapped ? '#7a3030' : '#1e7a3a',
        color: '#fff',
        border: '1px solid #000',
        borderRadius: 10,
        padding: '1px 6px',
        fontSize: 10, fontWeight: 800,
        letterSpacing: 0.5,
        boxShadow: '0 1px 4px #000a',
        zIndex: 2,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}>
        ×{total}{tappedCount > 0 && <span style={{ opacity: 0.85, marginLeft: 3 }}>({tappedCount}⤓)</span>}
      </div>
    </div>
  );
}

/** Group nodes by defId; collapse same-def groups of 3+ into a NodeStack tile. */
function renderNodes(
  nodes: Instance[],
  onNodeClick?: (uid: string) => void,
): React.ReactNode {
  const groups = new Map<string, Instance[]>();
  // Preserve original visual order: each defId's first appearance fixes its slot.
  for (const inst of nodes) {
    if (!groups.has(inst.defId)) groups.set(inst.defId, []);
    groups.get(inst.defId)!.push(inst);
  }
  const out: React.ReactNode[] = [];
  for (const [defId, group] of groups) {
    if (group.length >= 3) {
      out.push(<NodeStack key={`stack-${defId}`} group={group} onClick={onNodeClick} />);
    } else {
      for (const inst of group) {
        out.push(
          <MiniCard
            key={inst.uid}
            defId={inst.defId}
            instance={inst}
            faceUp
            onClick={onNodeClick ? () => onNodeClick(inst.uid) : undefined}
          />
        );
      }
    }
  }
  return out;
}

function Playmat(props: {
  me: GState['players'][string];
  opp: GState['players'][string];
  myId: string; oppId: string;
  myDeckCount: number; oppDeckCount: number;
  attackers: string[]; attackerSide: 'me' | 'opp';
  blocks: Record<string, string[]>;
  selectedBlocker?: string;
  memeTargetable: boolean; machineTargetable: boolean; playerTargetable: boolean;
  onOppPlayerClick: () => void; onMyPlayerClick: () => void;
  onNodeClick: (uid: string) => void;
  onMyMemeClick: (uid: string) => void;
  onOppMemeClick: (uid: string) => void;
  onMachineClick: (uid: string) => void;
  myName?: string; oppName?: string;
}) {
  const {
    me, opp, myId, oppId, myDeckCount, oppDeckCount,
    attackers, attackerSide, blocks, selectedBlocker,
    memeTargetable, machineTargetable, playerTargetable,
    onOppPlayerClick, onMyPlayerClick,
    onNodeClick, onMyMemeClick, onOppMemeClick, onMachineClick,
    myName, oppName,
  } = props;

  // Zone rectangles in percentage of the mat (left, top, width, height).
  // Tuned to match the labels on /playmat.png.
  const Z = {
    // Opponent (top half, rendered rotated 180° so cards face them)
    oppGrave:    { left: 1,  top: 1,  w: 13, h: 18 },
    oppNodes:    { left: 15, top: 1,  w: 70, h: 18 },
    oppDeck:     { left: 86, top: 1,  w: 13, h: 18 }, // draw deck
    oppMachines: { left: 1,  top: 20, w: 13, h: 17 },
    oppBattle:   { left: 15, top: 20, w: 70, h: 25 }, // memes / battlefield
    oppMaindeck: { left: 86, top: 20, w: 13, h: 17 }, // decorative
    oppLife:     { left: 86, top: 38, w: 13, h: 7  },
    // Me (bottom half)
    myLife:      { left: 1,  top: 55, w: 13, h: 7  },
    myBattle:    { left: 15, top: 55, w: 70, h: 25 }, // memes / battlefield
    myMachines:  { left: 86, top: 62, w: 13, h: 17 },
    myMaindeck:  { left: 1,  top: 62, w: 13, h: 17 }, // decorative
    myDeck:      { left: 1,  top: 80, w: 13, h: 18 }, // draw deck
    myNodes:     { left: 15, top: 80, w: 70, h: 18 },
    myGrave:     { left: 86, top: 80, w: 13, h: 18 },
  };

  return (
    <div style={{
      position: 'relative',
      width: '100%',
      maxWidth: 'min(1280px, calc(100dvh - 280px))',
      aspectRatio: '1 / 1',
      margin: '8px auto', borderRadius: 10, overflow: 'hidden',
      boxShadow: '0 0 30px #000a inset, 0 4px 24px #000c',
      isolation: 'isolate',
    }}>
      {/* Background image — blurred + darkened so cards pop */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: 'url(/playmat.png)', backgroundSize: 'cover', backgroundPosition: 'center',
        filter: 'blur(2px) brightness(0.45) saturate(0.7)',
        zIndex: 0,
      }} />
      <div style={{
        position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse at center, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.55) 100%)',
        zIndex: 0,
      }} />
      <div style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
      {/* ─── OPPONENT SIDE (rotated for face-to-face feel) ─── */}
      <ZoneSlot rect={Z.oppGrave} icon="☠️" label={`Graveyard (${opp.graveyard.length})`} compactLabel={`☠️ ${opp.graveyard.length}`} rotated>
        {opp.graveyard.slice(-1).map((id, i) => <MiniCard key={i} defId={id} faceUp />)}
      </ZoneSlot>
      <ZoneSlot rect={Z.oppNodes} icon="🌐" label={`Opp Nodes (${opp.nodes.length})`} compactLabel={`🌐 Nodes · ${opp.nodes.length}`} rotated>
        {renderNodes(opp.nodes)}
      </ZoneSlot>
      <ZoneSlot rect={Z.oppDeck} icon="📚" label={`Deck (${oppDeckCount})`} compactLabel={`📚 ${oppDeckCount}`} rotated>
        {oppDeckCount > 0 && <MiniCard faceDown />}
      </ZoneSlot>
      <ZoneSlot rect={Z.oppMaindeck} icon="✋" label={`Hand (${opp.hand.length})`} compactLabel={`✋ ${opp.hand.length}`} rotated>
        {opp.hand.length > 0 && (
          <div style={{ color: '#fff', fontSize: 14, fontWeight: 700, textShadow: '0 1px 4px #000' }}>
            🂠 × {opp.hand.length}
          </div>
        )}
      </ZoneSlot>
      <ZoneSlot rect={Z.oppMachines} icon="⚙️" label={`Machines (${opp.machines.length})`} compactLabel={`⚙️ ${opp.machines.length}`} rotated>
        {opp.machines.map(inst => (
          <MiniCard key={inst.uid} defId={inst.defId} instance={inst} faceUp
            onClick={machineTargetable ? () => onMachineClick(inst.uid) : undefined}
            targetable={machineTargetable} />
        ))}
      </ZoneSlot>
      <ZoneSlot rect={Z.oppBattle} icon="⚔️" label={`Battlefield — ${COLOR_META[opp.color].name}`} compactLabel={`⚔️ ${COLOR_META[opp.color].name}`} rotated>
        {opp.memes.map(inst => {
          const attacking = attackerSide === 'opp' && attackers.includes(inst.uid);
          const blockedBy = blocks[inst.uid] ?? [];
          const blockerSelected = !!selectedBlocker;
          const isAttacker = attackerSide === 'opp' && attackers.includes(inst.uid);
          const blockable = blockerSelected && isAttacker;
          return (
            <MiniCard key={inst.uid} defId={inst.defId} instance={inst} faceUp
              onClick={(memeTargetable || blockable) ? () => onOppMemeClick(inst.uid) : undefined}
              targetable={memeTargetable || blockable}
              selected={attacking}
              footer={
                <>{attacking && '⚔️'}{blockedBy.length > 0 && ` 🛡${blockedBy.length}`}</>
              } />
          );
        })}
      </ZoneSlot>
      {/* Large opponent life badge — corner, MTG-Arena style */}
      <LifeBadge
        life={opp.life} name={oppName ?? 'Opponent'} color={opp.color}
        position="topRight" targetable={playerTargetable}
        onClick={playerTargetable ? onOppPlayerClick : undefined}
      />

      {/* ─── ME ─── */}
      <LifeBadge
        life={me.life} name={myName ?? 'You'} color={me.color}
        position="bottomLeft" targetable={playerTargetable}
        onClick={playerTargetable ? onMyPlayerClick : undefined}
      />
      <ZoneSlot rect={Z.myBattle} icon="⚔️" label={`Your Battlefield — ${COLOR_META[me.color].name}`} compactLabel={`⚔️ ${COLOR_META[me.color].name}`}>
        {me.memes.map(inst => {
          const attacking = attackerSide === 'me' && attackers.includes(inst.uid);
          const blockedBy = blocks[inst.uid] ?? [];
          return (
            <MiniCard key={inst.uid} defId={inst.defId} instance={inst} faceUp
              onClick={() => onMyMemeClick(inst.uid)}
              targetable={memeTargetable}
              selected={inst.uid === selectedBlocker || attacking}
              footer={
                <>{attacking && '⚔️'}{blockedBy.length > 0 && ` 🛡${blockedBy.length}`}</>
              } />
          );
        })}
      </ZoneSlot>
      <ZoneSlot rect={Z.myMachines} icon="⚙️" label={`Machines (${me.machines.length})`} compactLabel={`⚙️ ${me.machines.length}`}>
        {me.machines.map(inst => (
          <MiniCard key={inst.uid} defId={inst.defId} instance={inst} faceUp
            onClick={machineTargetable ? () => onMachineClick(inst.uid) : undefined}
            targetable={machineTargetable} />
        ))}
      </ZoneSlot>
      <ZoneSlot rect={Z.myMaindeck} icon="📜" label="Main Deck" compactLabel="📜">
        <div style={{ color: '#888', fontSize: 10 }}>—</div>
      </ZoneSlot>
      <ZoneSlot rect={Z.myDeck} icon="📚" label={`Deck (${myDeckCount})`} compactLabel={`📚 ${myDeckCount}`}>
        {myDeckCount > 0 && <MiniCard faceDown />}
      </ZoneSlot>
      <ZoneSlot rect={Z.myNodes} icon="🌐" label={`Your Nodes (${me.nodes.length}) — click to tap`} compactLabel={`🌐 Nodes · ${me.nodes.length}`}>
        {renderNodes(me.nodes, onNodeClick)}
      </ZoneSlot>
      <ZoneSlot rect={Z.myGrave} icon="☠️" label={`Graveyard (${me.graveyard.length})`} compactLabel={`☠️ ${me.graveyard.length}`}>
        {me.graveyard.slice(-1).map((id, i) => <MiniCard key={i} defId={id} faceUp />)}
      </ZoneSlot>
      </div>
    </div>
  );
}

function ZoneSlot({
  rect, label, compactLabel, icon, children, rotated, onClick, targetable,
}: {
  rect: { left: number; top: number; w: number; h: number };
  label: string; compactLabel?: string; icon?: string;
  children: React.ReactNode; rotated?: boolean;
  onClick?: () => void; targetable?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      title={label}
      style={{
        position: 'absolute',
        left: `${rect.left}%`, top: `${rect.top}%`,
        width: `${rect.w}%`, height: `${rect.h}%`,
        border: targetable ? '2px dashed #ffeb3b' : '1px solid rgba(120,180,255,0.18)',
        borderRadius: 8,
        background: 'rgba(0,0,0,0.35)',
        backdropFilter: 'blur(1px)',
        boxShadow: targetable
          ? '0 0 14px rgba(255,235,59,0.45), inset 0 0 12px rgba(0,0,0,0.4)'
          : 'inset 0 0 12px rgba(0,0,0,0.45)',
        padding: 3,
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        transform: rotated ? 'rotate(180deg)' : undefined,
        transition: 'box-shadow 0.2s ease, border-color 0.2s ease',
      }}
    >
      <div style={{
        position: 'absolute', top: 3, left: 6, right: 6,
        fontSize: 11, color: 'rgba(220,235,255,0.92)',
        letterSpacing: 0.6, textShadow: '0 1px 3px #000, 0 0 4px #000',
        pointerEvents: 'none', fontWeight: 700,
        display: 'flex', alignItems: 'center', gap: 4,
      }}>
        <span>{compactLabel ?? (icon ? `${icon} ${label}` : label)}</span>
      </div>
      <div style={{
        position: 'absolute', top: 18, left: 3, right: 3, bottom: 3,
        display: 'flex', flexWrap: 'wrap', gap: 3,
        alignContent: 'flex-start', justifyContent: 'center', alignItems: 'center',
        overflow: 'hidden',
      }}>{children}</div>
    </div>
  );
}

/** Large MTG-Arena style circular life badge anchored to a playmat corner. */
function LifeBadge({
  life, name, color, position, onClick, targetable,
}: {
  life: number; name: string; color: Color;
  position: 'topRight' | 'bottomLeft';
  onClick?: () => void; targetable?: boolean;
}) {
  const meta = COLOR_META[color];
  const pos: React.CSSProperties = position === 'topRight'
    ? { top: 12, right: 14 }
    : { bottom: 12, left: 14 };
  const glow = targetable ? '0 0 22px rgba(255,235,59,0.85), 0 0 4px rgba(255,235,59,0.9)' : `0 0 24px ${meta.hex}aa, 0 4px 18px #000c`;
  return (
    <div
      onClick={onClick}
      title={`${name} — ${life} life`}
      style={{
        position: 'absolute', ...pos, zIndex: 5,
        display: 'flex', alignItems: 'center', gap: 8,
        cursor: onClick ? 'pointer' : 'default',
        pointerEvents: 'auto',
        flexDirection: position === 'topRight' ? 'row-reverse' : 'row',
      }}>
      <div style={{
        width: 78, height: 78, borderRadius: '50%',
        background: `radial-gradient(circle at 30% 30%, ${meta.hex}, #1a1a22 75%)`,
        border: targetable ? '3px solid #ffeb3b' : `3px solid ${meta.hex}`,
        boxShadow: glow,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#fff', textShadow: '0 2px 8px #000',
        fontFamily: '"Cinzel", "Times New Roman", serif',
        fontWeight: 900, fontSize: 36, lineHeight: 1,
        transition: 'transform 0.15s ease',
      }}>{life}</div>
      <div style={{
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(4px)',
        padding: '4px 10px', borderRadius: 6,
        border: `1px solid ${meta.hex}66`,
        color: '#fff', fontSize: 12, fontWeight: 700,
        maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        letterSpacing: 0.4,
      }}>{name}</div>
    </div>
  );
}

/** Top-of-screen turn banner with chain-color glow + pulse. */
// ─────────────────────────────────────────────────────────────────────────────
function MulliganModal({
  hand, mulliganCount, done, oppDone, deadline, onKeep, onMulligan, onForceEnd,
}: {
  hand: string[];
  mulliganCount: number;
  done: boolean;
  oppDone: boolean;
  deadline: number;
  onKeep: () => void;
  onMulligan: () => void;
  onForceEnd: () => void;
}) {
  const nextSize = mulliganDrawCount(mulliganCount + 1);
  const atFloor = hand.length <= MULLIGAN_FLOOR;
  // Live countdown tick.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const remainingMs = deadline > 0 ? Math.max(0, deadline - now) : 0;
  const remainingS  = Math.ceil(remainingMs / 1000);
  const waitingOnOpp = done && !oppDone;
  const expired = deadline > 0 && now >= deadline;
  // Auto-fire the escape hatch once the deadline lapses while we're waiting
  // on the opponent. Only fires once thanks to the guard.
  const firedRef = useRef(false);
  useEffect(() => {
    if (waitingOnOpp && expired && !firedRef.current) {
      firedRef.current = true;
      try { onForceEnd(); } catch { /* INVALID_MOVE is fine */ }
    }
  }, [waitingOnOpp, expired, onForceEnd]);
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 150,
      background: 'rgba(4,6,12,0.86)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
    }}>
      <div style={{
        width: 'min(960px, 100%)', maxHeight: '92dvh', overflow: 'auto',
        background: 'linear-gradient(180deg, rgba(28,18,52,0.96), rgba(10,8,22,0.96))',
        border: '1px solid rgba(143,92,255,0.55)',
        boxShadow: '0 0 32px rgba(143,92,255,0.35)',
        borderRadius: 12, padding: 24,
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: '"Cinzel", serif', fontSize: 22, fontWeight: 800, letterSpacing: 2, color: '#fff' }}>
            ⏳ MULLIGAN
          </div>
          <div style={{ fontSize: 12, color: '#aab', marginTop: 4 }}>
            {done
              ? oppDone
                ? 'Both players ready — starting…'
                : 'Waiting for opponent to keep or mulligan…'
              : `Your opening hand (${hand.length} cards). Keep it, or mulligan to redraw ${nextSize} card${nextSize === 1 ? '' : 's'}.`}
          </div>
          <div style={{ fontSize: 11, color: '#7a8', marginTop: 6, fontStyle: 'italic' }}>
            London mulligan · 1st free · −1 each redraw · floor {MULLIGAN_FLOOR}
            {mulliganCount > 0 && ` · mull #${mulliganCount}`}
          </div>
        </div>

        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 8,
          justifyContent: 'center', padding: 12,
          background: 'rgba(0,0,0,0.35)', borderRadius: 8,
        }}>
          {hand.map((defId, i) => (
            <CardFace key={i} defId={defId} />
          ))}
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={onKeep}
            disabled={done}
            style={{
              background: done ? 'rgba(255,255,255,0.08)' : 'linear-gradient(180deg, #56d97a, #1e7a3a)',
              color: '#fff', border: '1px solid #1e7a3a',
              padding: '10px 24px', borderRadius: 8,
              cursor: done ? 'default' : 'pointer',
              fontWeight: 800, fontSize: 14, letterSpacing: 1,
              opacity: done ? 0.5 : 1,
              boxShadow: done ? 'none' : '0 0 12px rgba(86,217,122,0.4)',
            }}>✓ KEEP HAND</button>
          <button
            onClick={onMulligan}
            disabled={done || atFloor}
            title={atFloor ? `Already at floor (${MULLIGAN_FLOOR} cards).` : `Redraw to ${nextSize} cards.`}
            style={{
              background: (done || atFloor) ? 'rgba(255,255,255,0.08)' : 'linear-gradient(180deg, #f0b32a, #c46a1c)',
              color: '#fff', border: '1px solid #7a4010',
              padding: '10px 24px', borderRadius: 8,
              cursor: (done || atFloor) ? 'default' : 'pointer',
              fontWeight: 800, fontSize: 14, letterSpacing: 1,
              opacity: (done || atFloor) ? 0.5 : 1,
              boxShadow: (done || atFloor) ? 'none' : '0 0 12px rgba(240,179,42,0.4)',
            }}>🔄 MULLIGAN ({nextSize})</button>
          {waitingOnOpp && expired && (
            <button
              onClick={onForceEnd}
              title="Opponent ran out of time — start the match anyway."
              style={{
                background: 'linear-gradient(180deg, #ef4444, #7a1d1d)',
                color: '#fff', border: '1px solid #7a1d1d',
                padding: '10px 24px', borderRadius: 8,
                cursor: 'pointer',
                fontWeight: 800, fontSize: 14, letterSpacing: 1,
                boxShadow: '0 0 12px rgba(239,68,68,0.5)',
              }}>⚡ START MATCH</button>
          )}
        </div>

        {waitingOnOpp && deadline > 0 && (
          <div style={{
            textAlign: 'center', fontSize: 11, color: expired ? '#ef4444' : '#aab', letterSpacing: 1,
          }}>
            {expired
              ? '⏰ Opponent timed out — click Start Match to begin.'
              : `Auto-starting in ${remainingS}s if opponent doesn't respond…`}
          </div>
        )}

        <div style={{
          display: 'flex', justifyContent: 'center', gap: 18,
          fontSize: 11, color: '#9aa', letterSpacing: 1,
        }}>
          <span style={{ color: done ? '#56d97a' : '#aab' }}>● You {done ? 'ready' : 'choosing…'}</span>
          <span style={{ color: oppDone ? '#56d97a' : '#aab' }}>● Opponent {oppDone ? 'ready' : 'choosing…'}</span>
        </div>
      </div>
    </div>
  );
}

// Suppress unused-warning for the constant on initial scaffolding.
void MULLIGAN_INITIAL_HAND;

// ─────────────────────────────────────────────────────────────────────────────
function TurnBanner({
  myTurn, turn, phase, myName, oppName, myProfile, oppProfile, onOpenRules,
  onEndTurn, canEndTurn,
  attackerCount, onConfirmAttackers, canAttack,
  inBlockers, onConfirmBlocks,
}: {
  myTurn: boolean; turn: number; phase: string;
  myName: string; oppName: string;
  myProfile?: any; oppProfile?: any;
  onOpenRules: () => void;
  onEndTurn: () => void;
  canEndTurn: boolean;
  attackerCount: number;
  onConfirmAttackers: () => void;
  canAttack: boolean;
  inBlockers: boolean;
  onConfirmBlocks: () => void;
}) {
  const dotColor = myTurn ? '#48d97a' : '#e85c5c';
  const headline = myTurn ? 'YOUR TURN' : "OPPONENT'S TURN";

  // 60-second auto-end-turn timer. Resets whenever turn/phase ownership changes.
  const TURN_LIMIT = 60;
  const [secondsLeft, setSecondsLeft] = useState(TURN_LIMIT);
  const firedRef = useRef(false);
  useEffect(() => {
    setSecondsLeft(TURN_LIMIT);
    firedRef.current = false;
  }, [turn, myTurn, canEndTurn]);
  useEffect(() => {
    if (!canEndTurn) return;
    const id = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) {
          if (!firedRef.current) { firedRef.current = true; onEndTurn(); }
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [canEndTurn, onEndTurn]);

  const lowTime = canEndTurn && secondsLeft <= 10;
  const timerColor = lowTime ? '#ff5d73' : '#ffd76a';

  return (
    <div style={{
      position: 'relative',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 12, padding: '6px 14px', borderRadius: 10,
      background: 'linear-gradient(180deg, rgba(20,20,30,0.95), rgba(10,10,14,0.95))',
      border: `1px solid ${dotColor}55`,
      boxShadow: `0 0 18px ${dotColor}33`,
    }}>
      <div style={{ fontSize: 11, color: '#9aa', fontWeight: 600, minWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        VS <b style={{ color: '#fff' }}>{oppName}</b> <span style={{ opacity: 0.6 }}>({formatRecord(oppProfile)})</span>
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        fontFamily: '"Cinzel", "Times New Roman", serif',
        fontWeight: 800, fontSize: 18, letterSpacing: 2,
        color: '#fff', textShadow: `0 0 12px ${dotColor}aa`,
      }}>
        <span style={{
          display: 'inline-block', width: 12, height: 12, borderRadius: '50%',
          background: dotColor, boxShadow: `0 0 12px ${dotColor}`,
          animation: 'pulse-dot 1.6s ease-in-out infinite',
        }} />
        {headline}
        <span style={{ fontFamily: 'system-ui', fontWeight: 600, fontSize: 11, color: '#aab', letterSpacing: 1 }}>
          · TURN {turn} · {phase.toUpperCase()}
        </span>
        {canEndTurn && (
          <span style={{
            fontFamily: 'system-ui', fontWeight: 800, fontSize: 13, letterSpacing: 1,
            color: timerColor, padding: '2px 8px', borderRadius: 6,
            background: `${timerColor}22`, border: `1px solid ${timerColor}66`,
            animation: lowTime ? 'pulse-dot 0.8s ease-in-out infinite' : 'none',
          }} title="Auto-end-turn in">⏱ {secondsLeft}s</span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 160, justifyContent: 'flex-end' }}>
        <span style={{ fontSize: 11, color: '#9aa', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <b style={{ color: '#fff' }}>{myName}</b> <span style={{ opacity: 0.6 }}>({formatRecord(myProfile)})</span>
        </span>
        {canAttack && attackerCount > 0 && (
          <button onClick={onConfirmAttackers} title="Swing with selected attackers"
            style={{
              background: 'linear-gradient(180deg, #ff7e5f, #c43e1c)',
              color: '#fff', border: '1px solid #7a2510',
              borderRadius: 6, padding: '5px 12px', cursor: 'pointer',
              fontWeight: 800, fontSize: 12, letterSpacing: 1,
              boxShadow: '0 0 10px #ff5d3388',
              animation: 'pulse-dot 1.6s ease-in-out infinite',
            }}>⚔ ATTACK ({attackerCount})</button>
        )}
        {inBlockers && (
          <button onClick={onConfirmBlocks} title="Lock in blockers and resolve combat"
            style={{
              background: 'linear-gradient(180deg, #5fcfff, #1c75c4)',
              color: '#fff', border: '1px solid #103a6a',
              borderRadius: 6, padding: '5px 12px', cursor: 'pointer',
              fontWeight: 800, fontSize: 12, letterSpacing: 1,
              boxShadow: '0 0 10px #5fcfff88',
            }}>🛡 CONFIRM BLOCKS</button>
        )}
        {canEndTurn && (
          <button onClick={onEndTurn} title="End your turn (auto-ends at 0s)"
            style={{
              background: 'linear-gradient(180deg, #f0d27a, #c69533)',
              color: '#1a1408', border: '1px solid #8a6d24',
              borderRadius: 6, padding: '5px 12px', cursor: 'pointer',
              fontWeight: 800, fontSize: 12, letterSpacing: 1,
              boxShadow: '0 0 8px #d9b85f55',
            }}>END TURN</button>
        )}
        <button onClick={onOpenRules} title="How to play"
          style={{
            background: 'linear-gradient(180deg,#3a2a55,#22163a)',
            color: '#ffd76a', border: '1px solid #ffd76a55',
            borderRadius: '50%', width: 28, height: 28, cursor: 'pointer',
            fontWeight: 800, fontSize: 14, lineHeight: 1,
            boxShadow: '0 0 8px #ffd76a44',
          }}>?</button>
      </div>
      <style>{`@keyframes pulse-dot { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.55; transform: scale(0.85); } }`}</style>
    </div>
  );
}

/** Slide-in rules drawer launched by the floating ? button. */
function RulesDrawer({ onClose }: { onClose: () => void }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(720px, 100%)', height: '100%',
        background: 'linear-gradient(180deg, #15101e, #0a0710)',
        borderLeft: '1px solid #ffd76a55',
        boxShadow: '-12px 0 32px #000c',
        overflowY: 'auto',
        padding: 20,
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{
            fontFamily: '"Cinzel", "Times New Roman", serif',
            fontSize: 22, fontWeight: 800, color: '#ffd76a', letterSpacing: 2,
          }}>HOW TO PLAY</div>
          <button onClick={onClose} style={{
            background: 'transparent', color: '#fff',
            border: '1px solid #555', borderRadius: 6,
            padding: '4px 12px', cursor: 'pointer', fontWeight: 700,
          }}>✕</button>
        </div>
        <RulesPanel side="left" />
        <RulesPanel side="right" />
      </div>
    </div>
  );
}

function MiniCard({
  defId, instance, faceUp, faceDown, onClick, selected, targetable, footer,
}: {
  defId?: string; instance?: Instance;
  faceUp?: boolean; faceDown?: boolean;
  onClick?: () => void; selected?: boolean; targetable?: boolean;
  footer?: React.ReactNode;
}) {
  if (faceDown || !defId) {
    return (
      <div style={{
        width: 48, height: 68, borderRadius: 5,
        background: 'repeating-linear-gradient(45deg, #2a2a3a 0 5px, #3a3a4a 5px 10px)',
        border: '1px solid #000',
        boxShadow: '0 2px 6px #0008',
      }} />
    );
  }
  const def = CARDS[defId];
  if (!def) return null;
  const meta = COLOR_META[def.color];
  return (
    <CardHover defId={defId}>
    <div onClick={onClick}
      onMouseEnter={e => {
        e.currentTarget.style.transform = `${instance?.tapped ? 'rotate(8deg) ' : ''}translateY(-4px) scale(1.08)`;
        e.currentTarget.style.zIndex = '20';
        e.currentTarget.style.boxShadow = `0 6px 18px ${meta.hex}aa, 0 0 12px ${meta.hex}88`;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = instance?.tapped ? 'rotate(8deg)' : '';
        e.currentTarget.style.zIndex = '';
        e.currentTarget.style.boxShadow = instance?.tapped
          ? 'inset 0 0 0 3px #0008, 0 2px 6px #000a'
          : selected ? `0 0 14px ${meta.hex}, 0 0 4px #ffeb3b` : '0 2px 6px #000a';
      }}
      style={{
        width: 68, height: 96, padding: 3, borderRadius: 6,
        background: meta.hex, color: meta.ink,
        border: selected ? '2px solid #ffeb3b' : targetable ? '2px dashed #ffeb3b' : '1px solid #000',
        cursor: onClick ? 'pointer' : 'default',
        boxShadow: instance?.tapped
          ? 'inset 0 0 0 3px #0008, 0 2px 6px #000a'
          : selected ? `0 0 14px ${meta.hex}, 0 0 4px #ffeb3b` : '0 2px 6px #000a',
        transform: instance?.tapped ? 'rotate(8deg)' : undefined,
        opacity: instance?.summoningSick && def.type === 'meme' ? 0.6 : 1,
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        fontFamily: 'system-ui',
        position: 'relative',
        transition: 'transform 0.15s ease, box-shadow 0.15s ease',
      }}>
      <div style={{ fontSize: 8, fontWeight: 800, lineHeight: 1.0, overflow: 'hidden' }}>{def.name}</div>
      {def.power != null && def.toughness != null && (
        <div style={{ fontSize: 10, fontWeight: 800, alignSelf: 'flex-end',
          background: '#000a', padding: '0 4px', borderRadius: 3 }}>
          {def.power}/{(def.toughness ?? 1) - (instance?.damage ?? 0)}
        </div>
      )}
      {footer && <div style={{ fontSize: 7, lineHeight: 1.0 }}>{footer}</div>}
    </div>
    </CardHover>
  );
}

function Side({
  title, side, deckCount, face,
  onNodeClick, onMemeClick, onMachineClick,
  memeTargetable, machineTargetable,
  attackingUids, blocks, selectedBlocker,
}: {
  title: string;
  side: GState['players'][string];
  deckCount: number;
  face: 'up' | 'down';
  onNodeClick?: (uid: string) => void;
  onMemeClick?: (uid: string) => void;
  onMachineClick?: (uid: string) => void;
  memeTargetable?: boolean;
  machineTargetable?: boolean;
  attackingUids?: string[];
  blocks?: Record<string, string[]>;
  selectedBlocker?: string;
}) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 12, opacity: 0.7 }}>{title} — Hand: {side.hand.length} · Deck: {deckCount} · Graveyard: {side.graveyard.length}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        <Zone label="Nodes"    instances={side.nodes}    onClick={onNodeClick} />
        <Zone label="Memes"    instances={side.memes}
          onClick={onMemeClick}
          highlightUids={attackingUids}
          selectedUid={selectedBlocker}
          targetable={memeTargetable}
          blocks={blocks}
        />
        <Zone label="Machines" instances={side.machines}
          onClick={onMachineClick}
          targetable={machineTargetable}
        />
      </div>
    </div>
  );
}

function Zone({
  label, instances, onClick,
  highlightUids = [], selectedUid, targetable, blocks,
}: {
  label: string;
  instances: Instance[];
  onClick?: (uid: string) => void;
  highlightUids?: string[];
  selectedUid?: string;
  targetable?: boolean;
  blocks?: Record<string, string[]>;
}) {
  return (
    <div style={{ flex: 1, minWidth: 240, padding: 4, border: '1px solid #333' }}>
      <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 2 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        {instances.length === 0 && <div style={{ fontSize: 11, opacity: 0.4 }}>—</div>}
        {instances.map(inst => {
          const attacking = highlightUids.includes(inst.uid);
          const blockedBy = blocks?.[inst.uid] ?? [];
          return (
            <div key={inst.uid} style={{ position: 'relative' }}>
              <CardFace
                defId={inst.defId}
                instance={inst}
                selected={inst.uid === selectedUid || attacking}
                onClick={onClick ? () => onClick(inst.uid) : undefined}
                footer={
                  <>
                    <span style={{ opacity: 0.6 }}>{inst.uid}</span>
                    {attacking && <span style={{ color: '#f55', marginLeft: 4 }}>⚔️</span>}
                    {blockedBy.length > 0 && <span style={{ color: '#5cf', marginLeft: 4 }}>🛡{blockedBy.length}</span>}
                  </>
                }
              />
              {targetable && <div style={{
                position: 'absolute', inset: 0, border: '2px dashed #ff0', pointerEvents: 'none',
              }} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CombatStrip({ G, ctx, myId }: { G: GState; ctx: any; myId: string }) {
  if (G.combat.attackers.length === 0) return <div style={{ fontSize: 12, opacity: 0.5 }}>No combat in progress.</div>;
  return (
    <div style={{ padding: 6, background: '#1a1a1a', border: '1px solid #444' }}>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
        Combat — attacker: P{ctx.currentPlayer}
      </div>
      {G.combat.attackers.map(a => (
        <div key={a.memeUid} style={{ fontSize: 12 }}>
          Attacker <b>{a.memeUid}</b> blocked by: {G.combat.blocks[a.memeUid]?.join(', ') || '(none)'}
        </div>
      ))}
    </div>
  );
}

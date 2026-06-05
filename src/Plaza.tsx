// Memetic Plaza — WorkAdventure-style 2D lobby.
// Walk an avatar around a chain-themed plaza. Walk onto a "table" to join an
// open match; walk into an NPC tile to read a chain-specific tutorial blurb.
// Renders to a single <canvas>; no extra deps.

import { useEffect, useMemo, useRef, useState } from 'react';

type Color = 'bnb' | 'sol' | 'avax' | 'eth' | 'xrp';

type Match = {
  matchID: string;
  players: Array<{ id: number; name?: string }>;
  setupData?: { colors?: Array<Color | null> };
};

type Table = {
  x: number; y: number; w: number; h: number;
  match: Match;
};

type NPC = {
  x: number; y: number;
  color: Color;
  name: string;
  blurb: string;
};

const TILE = 32;
const COLS = 22;
const ROWS = 14;
const W = COLS * TILE;
const H = ROWS * TILE;

const COLOR_HEX: Record<Color, string> = {
  bnb: '#f0b90b', sol: '#9945ff', avax: '#e84142', eth: '#e6e6e6', xrp: '#111111',
};

const NPCS: NPC[] = [
  { x: 3,  y: 3,  color: 'bnb', name: 'BNB Bull',     blurb: 'Orange means fast gas. Flood the board with cheap memes — pressure wins before they stabilize.' },
  { x: 18, y: 3,  color: 'sol', name: 'Sol Degen',    blurb: 'Purple plays combos. Save Moves for one explosive turn — set up, then snap the table in half.' },
  { x: 3,  y: 10, color: 'avax', name: 'Avalanche Camp', blurb: 'Red is resilient. Build around Validators and Subnets, then let your snowballing engine bury them.' },
  { x: 18, y: 10, color: 'eth', name: 'Eth Cathedral',blurb: 'White is control. Bigger nodes, bigger memes. Trade evenly until your late-game crushes theirs.' },
  { x: 10, y: 12, color: 'xrp', name: 'XRP Vault',    blurb: 'Black is disruption. Force discards and removal. Make every card they draw feel like a tax.' },
];

const COLOR_LABEL: Record<Color, string> = {
  bnb: 'BNB', sol: 'Sol', avax: 'AVAX', eth: 'Eth', xrp: 'XRP',
};

export function Plaza({
  matches, myName, onJoinMatch, onCreateMatch, onClose,
}: {
  matches: Match[];
  myName: string;
  onJoinMatch: (m: Match) => void;
  onCreateMatch?: () => void;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pos, setPos] = useState({ x: COLS / 2, y: ROWS / 2 });
  const [popup, setPopup] = useState<{ kind: 'npc'; npc: NPC } | { kind: 'table'; table: Table } | null>(null);
  const keys = useRef<Set<string>>(new Set());

  // Lay open matches out as tables along the middle band.
  const tables: Table[] = useMemo(() => {
    const open = matches.filter(m => (m.players ?? []).some(p => !p.name)).slice(0, 6);
    return open.map((m, i) => {
      const col = 3 + (i % 6) * 3;
      const row = 7;
      return { x: col, y: row, w: 2, h: 1, match: m };
    });
  }, [matches]);

  // Keyboard input.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','w','a','s','d','W','A','S','D',' '].includes(e.key)) {
        e.preventDefault();
        keys.current.add(e.key.toLowerCase());
      }
      if (e.key === 'Escape') { setPopup(null); }
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Game loop: movement + collision detection against NPCs/tables.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const speed = 5.5; // tiles/sec
      let dx = 0, dy = 0;
      if (keys.current.has('arrowleft') || keys.current.has('a')) dx -= 1;
      if (keys.current.has('arrowright') || keys.current.has('d')) dx += 1;
      if (keys.current.has('arrowup') || keys.current.has('w')) dy -= 1;
      if (keys.current.has('arrowdown') || keys.current.has('s')) dy += 1;
      if (dx || dy) {
        const len = Math.hypot(dx, dy);
        setPos(p => {
          const nx = Math.max(0.5, Math.min(COLS - 0.5, p.x + (dx / len) * speed * dt));
          const ny = Math.max(0.5, Math.min(ROWS - 0.5, p.y + (dy / len) * speed * dt));
          // Trigger popup when you stand on a tile.
          const npc = NPCS.find(n => Math.abs(n.x + 0.5 - nx) < 0.7 && Math.abs(n.y + 0.5 - ny) < 0.7);
          if (npc) setPopup({ kind: 'npc', npc });
          else {
            const tbl = tables.find(t => nx >= t.x && nx <= t.x + t.w && ny >= t.y - 0.3 && ny <= t.y + t.h + 0.3);
            if (tbl) setPopup({ kind: 'table', table: tbl });
            else setPopup(cur => (cur ? null : cur));
          }
          return { x: nx, y: ny };
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [tables]);

  // Render.
  useEffect(() => {
    const cvs = canvasRef.current; if (!cvs) return;
    const ctx = cvs.getContext('2d'); if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cvs.width = W * dpr; cvs.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Floor with subtle radial gradient per chain corner.
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#1a1228'); g.addColorStop(1, '#0b0d18');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // Grid.
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    for (let x = 0; x <= COLS; x++) { ctx.beginPath(); ctx.moveTo(x * TILE, 0); ctx.lineTo(x * TILE, H); ctx.stroke(); }
    for (let y = 0; y <= ROWS; y++) { ctx.beginPath(); ctx.moveTo(0, y * TILE); ctx.lineTo(W, y * TILE); ctx.stroke(); }

    // Chain-room labels in corners.
    ctx.font = '700 12px Inter, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText('BNB BAZAAR',     TILE,           TILE * 1.5);
    ctx.fillText('SOLANA BEACH',   W - TILE * 7,   TILE * 1.5);
    ctx.fillText('AVAX CAMP',      TILE,           H - TILE * 0.5);
    ctx.fillText('ETH CATHEDRAL',  W - TILE * 7,   H - TILE * 0.5);
    ctx.textAlign = 'center';
    ctx.fillText('XRP VAULT', W / 2, H - TILE * 0.3);
    ctx.textAlign = 'start';

    // NPC tiles.
    for (const n of NPCS) {
      ctx.fillStyle = COLOR_HEX[n.color];
      ctx.fillRect(n.x * TILE + 4, n.y * TILE + 4, TILE - 8, TILE - 8);
      ctx.fillStyle = n.color === 'xrp' || n.color === 'sol' ? '#fff' : '#000';
      ctx.font = '700 12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(COLOR_LABEL[n.color], n.x * TILE + TILE / 2, n.y * TILE + TILE / 2 + 4);
      ctx.textAlign = 'start';
    }

    // Tables (open matches).
    for (const t of tables) {
      const c1 = t.match.setupData?.colors?.[0];
      const c2 = t.match.setupData?.colors?.[1];
      ctx.fillStyle = '#3a2a1a';
      ctx.fillRect(t.x * TILE, t.y * TILE, t.w * TILE, t.h * TILE);
      ctx.strokeStyle = '#c8a050';
      ctx.strokeRect(t.x * TILE + 0.5, t.y * TILE + 0.5, t.w * TILE - 1, t.h * TILE - 1);
      // Stools coloured by deck choice.
      if (c1) { ctx.fillStyle = COLOR_HEX[c1]; ctx.beginPath(); ctx.arc(t.x * TILE - 6, t.y * TILE + TILE / 2, 6, 0, Math.PI * 2); ctx.fill(); }
      if (c2) { ctx.fillStyle = COLOR_HEX[c2]; ctx.beginPath(); ctx.arc(t.x * TILE + t.w * TILE + 6, t.y * TILE + TILE / 2, 6, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = '#fff';
      ctx.font = '600 10px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(t.match.matchID.slice(0, 6), t.x * TILE + t.w * TILE / 2, t.y * TILE + TILE - 6);
      ctx.textAlign = 'start';
    }

    // Player avatar.
    ctx.fillStyle = '#ffd54f';
    ctx.beginPath();
    ctx.arc(pos.x * TILE, pos.y * TILE, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.font = '700 10px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(myName.slice(0, 8) || 'you', pos.x * TILE, pos.y * TILE - 14);
    ctx.textAlign = 'start';
  }, [pos, tables, myName]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(0,0,0,0.92)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: 16,
    }}>
      <div style={{
        display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10,
        color: '#fff', fontFamily: 'Inter, sans-serif',
      }}>
        <div style={{ fontWeight: 800, fontSize: 16 }}>🏛️ Memetic Plaza</div>
        <div style={{ opacity: 0.6, fontSize: 12 }}>WASD / arrows to move · walk into a table to join · ESC to dismiss</div>
        <button onClick={onClose} style={{
          marginLeft: 12, background: '#333', color: '#fff',
          border: '1px solid #555', borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
        }}>Leave plaza</button>
      </div>
      <div style={{ position: 'relative' }}>
        <canvas
          ref={canvasRef}
          style={{ width: W, height: H, maxWidth: '95vw', maxHeight: '70vh', borderRadius: 8, border: '1px solid #333' }}
          tabIndex={0}
        />
        {popup && (
          <div style={{
            position: 'absolute', left: '50%', bottom: 10, transform: 'translateX(-50%)',
            minWidth: 320, maxWidth: 420,
            background: '#15192a', border: '1px solid #6c4bd8', borderRadius: 8,
            padding: 12, color: '#fff', fontFamily: 'Inter, sans-serif',
            boxShadow: '0 6px 22px rgba(0,0,0,0.55)',
          }}>
            {popup.kind === 'npc' ? (
              <>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4, color: COLOR_HEX[popup.npc.color] }}>
                  {popup.npc.name}
                </div>
                <div style={{ fontSize: 12, lineHeight: 1.4, opacity: 0.9 }}>{popup.npc.blurb}</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
                  Open table · {popup.table.match.matchID.slice(0, 8)}
                </div>
                <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
                  {(popup.table.match.players ?? []).filter(p => p.name).length}/2 seated
                </div>
                <button onClick={() => onJoinMatch(popup.table.match)} style={{
                  background: '#6c4bd8', color: '#fff', border: 'none',
                  borderRadius: 4, padding: '6px 12px', fontWeight: 700, cursor: 'pointer',
                }}>Sit down</button>
              </>
            )}
          </div>
        )}
      </div>
      {onCreateMatch && (
        <button onClick={onCreateMatch} style={{
          marginTop: 10, background: '#1f5a3a', color: '#fff',
          border: '1px solid #2a8a55', borderRadius: 4, padding: '6px 14px',
          fontWeight: 700, cursor: 'pointer',
        }}>+ Set up my own table</button>
      )}
    </div>
  );
}

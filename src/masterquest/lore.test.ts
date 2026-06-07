import { describe, it, expect } from 'vitest';
import { SITES, ACTS, TOTAL_SITES, INTERLUDES, sitesByAct, sitesByChain, MAP_VIEWBOX } from './lore';

describe('Memetic Masterquest lore', () => {
  it('has exactly 15 sacred sites', () => {
    expect(TOTAL_SITES).toBe(15);
  });

  it('numbers sites 1..15 with no gaps or duplicates', () => {
    const idxs = SITES.map(s => s.index).sort((a, b) => a - b);
    expect(idxs).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it('uses unique site ids', () => {
    expect(new Set(SITES.map(s => s.id)).size).toBe(15);
  });

  it('uses unique rival names', () => {
    expect(new Set(SITES.map(s => s.rival.name)).size).toBe(15);
  });

  it('has exactly 5 sites per act', () => {
    for (const act of Object.keys(ACTS) as Array<keyof typeof ACTS>) {
      expect(sitesByAct(act).length).toBe(5);
    }
  });

  it('places each act on the right index range', () => {
    for (const [key, meta] of Object.entries(ACTS)) {
      const range = sitesByAct(key as any).map(s => s.index);
      expect(Math.min(...range)).toBe(meta.siteRange[0]);
      expect(Math.max(...range)).toBe(meta.siteRange[1]);
    }
  });

  it('puts 3 sites on every chain in total', () => {
    for (const c of ['bnb', 'sol', 'avax', 'eth', 'xrp'] as const) {
      expect(sitesByChain(c).length).toBe(3);
    }
  });

  it('escalates difficulty across acts (no easy in Act III)', () => {
    const actIII = sitesByAct('coronation');
    expect(actIII.every(s => s.rival.difficulty !== 'easy')).toBe(true);
  });

  it('has a pre and post interlude for every site', () => {
    for (const s of SITES) {
      const i = INTERLUDES[s.id];
      expect(i, `missing interlude for ${s.id}`).toBeDefined();
      expect(i.pre.length).toBeGreaterThan(80);
      expect(i.post.length).toBeGreaterThan(80);
    }
  });

  it('places every map node inside the map viewBox', () => {
    for (const s of SITES) {
      expect(s.mapPos.x).toBeGreaterThanOrEqual(0);
      expect(s.mapPos.x).toBeLessThanOrEqual(MAP_VIEWBOX.w);
      expect(s.mapPos.y).toBeGreaterThanOrEqual(0);
      expect(s.mapPos.y).toBeLessThanOrEqual(MAP_VIEWBOX.h);
    }
  });
});

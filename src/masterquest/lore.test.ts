import { describe, it, expect } from 'vitest';
import { SITES, ACTS, TOTAL_SITES, sitesByAct, sitesByChain } from './lore';

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

  it('covers all 5 chains across each act', () => {
    const chains = ['bnb', 'sol', 'avax', 'eth', 'xrp'] as const;
    for (const act of Object.keys(ACTS) as Array<keyof typeof ACTS>) {
      const seen = new Set(sitesByAct(act).map(s => s.chain));
      for (const c of chains) {
        expect(seen.has(c)).toBe(true);
      }
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
});

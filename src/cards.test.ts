import { describe, expect, it } from 'vitest';
import { CARDS, COLORS, COLOR_META, STARTER_DECKS } from './cards';

describe('Avalanche chain registry', () => {
  it('uses Avalanche/AVAX instead of the removed Hyperliquid chain key', () => {
    expect(COLORS).toEqual(['bnb', 'sol', 'avax', 'eth', 'xrp']);
    expect(COLOR_META.avax).toMatchObject({
      name: 'Avalanche',
      glyph: 'AVAX',
      template: '/template-avax.svg',
    });

    expect(CARDS.node_avax).toMatchObject({
      name: 'Avalanche Node',
      type: 'node',
      color: 'avax',
      image: '/nodes/avax.svg',
    });
  });

  it('contains the AVAX starter content and no Hyperliquid leftovers', () => {
    const ids = Object.keys(CARDS);
    const serializedCards = JSON.stringify(CARDS);

    expect(ids.some(id => id.startsWith('hl_') || id === 'node_hl')).toBe(false);
    expect(serializedCards).not.toMatch(/Hyperliquid|template-hl|nodes\/hl|hl_/i);

    expect(ids.filter(id => id.startsWith('avax_'))).toEqual([
      'avax_coq',
      'avax_kimbo',
      'avax_nochill',
      'avax_husky',
      'avax_tech',
      'avax_gec',
      'avax_meat',
      'avax_ket',
      'avax_subnet',
      'avax_staking',
      'avax_teleport',
      'avax_router',
      'avax_snowball',
      'avax_rush',
      'avax_finality',
      'avax_icebound',
    ]);

    expect(STARTER_DECKS.avax).toHaveLength(60);
    expect(STARTER_DECKS.avax).toContain('node_avax');
    expect(STARTER_DECKS.avax).toContain('avax_coq');
    expect(STARTER_DECKS.avax.every(id => CARDS[id])).toBe(true);
  });
});

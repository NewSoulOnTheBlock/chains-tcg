import { describe, expect, it } from 'vitest';
import { CARDS, COLORS, COLOR_META, STARTER_DECKS, validateDeck } from './cards';

describe('On-Chain Virtual Arena chain registry', () => {
  it('has exactly the five-chain roster (no avax/xrp leftovers)', () => {
    expect(COLORS).toEqual(['bnb', 'sol', 'eth', 'robinhood', 'base']);

    const serialized = JSON.stringify(CARDS);
    expect(serialized).not.toMatch(/avax|xrp|Avalanche|Hyperliquid/i);
    expect(Object.keys(CARDS).some(id => id.startsWith('avax_') || id.startsWith('xrp_'))).toBe(false);
    expect(CARDS.node_avax).toBeUndefined();
    expect(CARDS.node_xrp).toBeUndefined();
  });

  it('defines Robinhood and Base color metadata', () => {
    expect(COLOR_META.robinhood).toMatchObject({ name: 'Robinhood', hex: '#00C805', glyph: 'HOOD' });
    expect(COLOR_META.base).toMatchObject({ name: 'Base', hex: '#0052FF', glyph: 'BASE' });
    expect(CARDS.node_robinhood).toMatchObject({ name: 'Robinhood Node', type: 'node', color: 'robinhood' });
    expect(CARDS.node_base).toMatchObject({ name: 'Base Node', type: 'node', color: 'base' });
  });

  it('gives every chain the full pool shape (8 memes + 4 machines + 3 moves + 1 aura)', () => {
    for (const color of COLORS) {
      const pool = Object.values(CARDS).filter(c => c.color === color && c.type !== 'node');
      const count = (t: string) => pool.filter(c => c.type === t).length;
      expect(count('meme'), `${color} memes`).toBe(8);
      expect(count('machine'), `${color} machines`).toBe(4);
      expect(count('move'), `${color} moves`).toBe(3);
      expect(count('aura'), `${color} auras`).toBe(1);
    }
  });

  it('builds a valid 60-card starter deck for every chain', () => {
    for (const color of COLORS) {
      const deck = STARTER_DECKS[color];
      expect(deck, `${color} deck length`).toHaveLength(60);
      expect(deck.every(id => CARDS[id]), `${color} known ids`).toBe(true);
      expect(validateDeck(deck).ok, `${color} validateDeck`).toBe(true);
    }
  });

  it('moves BRETT from Ethereum to Base', () => {
    expect(CARDS.eth_brett).toBeUndefined();
    expect(CARDS.base_brett).toMatchObject({ color: 'base', image: '/cards/brett.png?v=1' });
  });
});

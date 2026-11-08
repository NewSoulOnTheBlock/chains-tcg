// Generate ERC-721 metadata for every card (+ a foil variant), served statically
// from /public/nft/. Card index N -> public/nft/N.json and N-foil.json.
import fs from 'node:fs';
import path from 'node:path';
import { CARDS, COLOR_META } from '../src/cards.ts';

const SITE = process.env.SITE || 'https://chains-tcg.vercel.app';
const outDir = path.join(process.cwd(), 'public', 'nft');
fs.mkdirSync(outDir, { recursive: true });

const cards = Object.values(CARDS).filter((c) => c.type !== 'node');

const absImage = (img?: string) => {
  if (!img) return `${SITE}/favicon.png`;
  if (img.startsWith('http')) return img;
  return `${SITE}${img.split('?')[0]}`;
};

const catalog: Array<{ index: number; id: string; name: string }> = [];

cards.forEach((c, i) => {
  const image = absImage(c.image);
  const attrs: Array<{ trait_type: string; value: string | number }> = [
    { trait_type: 'Chain', value: COLOR_META[c.color].name },
    { trait_type: 'Type', value: c.type },
  ];
  if (c.power != null && c.toughness != null) {
    attrs.push({ trait_type: 'Power', value: c.power });
    attrs.push({ trait_type: 'Toughness', value: c.toughness });
  }

  const base = {
    name: c.name,
    description: c.text || `${COLOR_META[c.color].name} ${c.type} — On-Chain Virtual Arena.`,
    image,
    attributes: [...attrs, { trait_type: 'Foil', value: 'No' }],
  };
  fs.writeFileSync(path.join(outDir, `${i}.json`), JSON.stringify(base, null, 2));

  const foil = {
    ...base,
    name: `${c.name} (Foil)`,
    attributes: [...attrs, { trait_type: 'Foil', value: 'Yes' }],
  };
  fs.writeFileSync(path.join(outDir, `${i}-foil.json`), JSON.stringify(foil, null, 2));

  catalog.push({ index: i, id: c.id, name: c.name });
});

// contracts-10 / audit L-6: the on-chain card-index space is this catalogue's order. A
// reorder/insert/deletion would silently remap every already-minted CardPack token to a
// different card. Treat the committed index.json as a FROZEN manifest: existing indices may
// never change id; new cards may only be APPENDED. Fail the build otherwise so the drift is
// caught before it ships (set ALLOW_INDEX_REMAP=1 only for an intentional, un-minted reset).
const indexPath = path.join(outDir, 'index.json');
if (fs.existsSync(indexPath) && process.env.ALLOW_INDEX_REMAP !== '1') {
  const prev = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const prevCards: Array<{ index: number; id: string }> = prev.cards || [];
  if (prevCards.length > catalog.length) {
    throw new Error(
      `card catalogue shrank (${catalog.length} < committed ${prevCards.length}); ` +
      `this would strand minted tokens. Refusing to regenerate the frozen manifest.`,
    );
  }
  for (const p of prevCards) {
    const now = catalog[p.index];
    if (!now || now.id !== p.id) {
      throw new Error(
        `on-chain index ${p.index} changed card id '${p.id}' -> '${now ? now.id : 'MISSING'}'. ` +
        `This remaps an already-minted token. Only append new cards; never reorder/delete. ` +
        `(Set ALLOW_INDEX_REMAP=1 to override for an intentional, un-minted reset.)`,
      );
    }
  }
  console.log(`manifest check ok: ${prevCards.length} committed indices unchanged`);
}

fs.writeFileSync(
  indexPath,
  JSON.stringify({ site: SITE, cardCount: cards.length, baseURI: `${SITE}/nft/`, cards: catalog }, null, 2),
);
console.log('cardCount', cards.length, '->', outDir);

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

fs.writeFileSync(
  path.join(outDir, 'index.json'),
  JSON.stringify({ site: SITE, cardCount: cards.length, baseURI: `${SITE}/nft/`, cards: catalog }, null, 2),
);
console.log('cardCount', cards.length, '->', outDir);

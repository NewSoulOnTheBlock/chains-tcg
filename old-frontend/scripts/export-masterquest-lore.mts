// scripts/export-masterquest-lore.mts
// One-shot: bundle PROLOGUE + 15 SITES + INTERLUDES + EPILOGUE into a
// single Markdown file at public/lore/masterquest.md for static reading.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROLOGUE, ACTS, SITES, EPILOGUE, INTERLUDES, mapPosOf,
  type SacredSite,
} from '../src/masterquest/lore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUT = join(__dirname, '..', 'public', 'lore', 'masterquest.md');

const ACT_LABEL: Record<string, string> = {
  awakening:  'Act I — The Awakening',
  pilgrimage: 'Act II — The Pilgrimage',
  coronation: 'Act III — The Coronation',
};

function siteSection(s: SacredSite): string {
  const i = INTERLUDES[s.id];
  const pos = mapPosOf(s);
  return `
---

## Site ${s.index} — ${s.name}

> *${s.region}*

**Chain:** ${s.chain.toUpperCase()} · **Act:** ${ACT_LABEL[s.act]} · **Map position:** (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})

${s.description}

### The Approach

${i.pre}

### Your Rival — ${s.rival.name}, *${s.rival.title}*

${s.rival.bio}

- **Difficulty:** ${s.rival.difficulty}
- **Deck colour:** ${s.rival.botColor}
- **Rival's opener:** *"${s.rival.quote.replace(/\\'/g, "'")}"*

### The Aftermath

${i.post}

### Reward

${s.reward}
`;
}

const md = `# Memetic Masterquest

*Cycle I — Sorendo the Unhoused*

## Prologue

${PROLOGUE}

${SITES.map(siteSection).join('\n')}

---

## Epilogue

${EPILOGUE}
`.trim() + '\n';

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, md, 'utf8');
console.log(`Wrote ${md.length} chars → ${OUT}`);

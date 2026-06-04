// scripts/render-cards.mjs
//
// Composite-PNG generator for every card in the catalogue.
//
// What it does:
//   1. Spawns `npm run dev` (Vite) on a fixed port.
//   2. Waits for the dev server to come up.
//   3. Navigates Playwright/Chromium to `http://localhost:<port>/#print`,
//      which renders the PrintAllCards grid (every CardPreview at 280×400).
//   4. Iterates every `[data-card-id]` element and screenshots it to
//      `public/cards-rendered/<id>.png` at 2× device-scale (560×800).
//
// Usage:
//   npm install --save-dev playwright wait-on
//   npx playwright install chromium
//   node scripts/render-cards.mjs
//
// Or via the npm alias added in package.json:
//   npm run render:cards
//
// The script exits 0 on success, 1 on any failure.

import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import waitOn from 'wait-on';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT  = resolve(ROOT, 'public', 'cards-rendered');
const PORT = 5179;
const URL  = `http://localhost:${PORT}/#print`;

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // Start `vite` on PORT.
  console.log(`[render-cards] starting vite on :${PORT}`);
  const vite = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true, env: { ...process.env, BROWSER: 'none' } },
  );
  vite.stdout.on('data', d => process.stdout.write(`[vite] ${d}`));
  vite.stderr.on('data', d => process.stderr.write(`[vite] ${d}`));

  let browser;
  try {
    console.log('[render-cards] waiting for vite…');
    await waitOn({ resources: [`http-get://localhost:${PORT}`], timeout: 60_000, interval: 500 });

    console.log('[render-cards] launching chromium');
    browser = await chromium.launch();
    const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1600, height: 1200 } });
    const page = await ctx.newPage();

    console.log(`[render-cards] navigating to ${URL}`);
    await page.goto(URL, { waitUntil: 'networkidle' });

    // Wait until at least one card is in the DOM.
    await page.waitForSelector('[data-card-id]', { timeout: 30_000 });
    // Give all <img> tags inside the previews a chance to load.
    await page.evaluate(() => Promise.all(
      Array.from(document.images).map(img => img.complete
        ? Promise.resolve()
        : new Promise(r => { img.onload = img.onerror = r; }),
      ),
    ));

    const ids = await page.$$eval('[data-card-id]', els => els.map(e => e.getAttribute('data-card-id')));
    console.log(`[render-cards] found ${ids.length} cards`);

    let ok = 0;
    for (const id of ids) {
      const el = await page.$(`[data-card-id="${id}"]`);
      if (!el) { console.warn(`[render-cards] missing element for ${id}`); continue; }
      await el.screenshot({ path: resolve(OUT, `${id}.png`), omitBackground: false });
      ok++;
      if (ok % 25 === 0) console.log(`[render-cards] rendered ${ok}/${ids.length}`);
    }
    console.log(`[render-cards] done: ${ok}/${ids.length} → ${OUT}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    vite.kill('SIGINT');
    // Give vite a moment to release the port.
    await new Promise(r => setTimeout(r, 500));
  }
}

main().catch(err => {
  console.error('[render-cards] FAILED', err);
  process.exit(1);
});

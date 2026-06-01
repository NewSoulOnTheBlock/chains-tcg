// src/server.ts — boardgame.io Server + REST API + static React build.
import path from 'node:path';
import fs from 'node:fs';
import { Server, Origins } from 'boardgame.io/server';
import serveStatic from 'koa-static';
import { ChainsTCG } from './Game';
import { initDb, upsertProfile, updateProfile, getProfile, getProfileByWallet, listProfiles, recordMatch, getDeck, saveDeck } from './db';
import { validateDeck } from './cards';

const distDir = path.resolve(__dirname, '..', 'dist');

const PORT = Number(process.env.PORT) || 8000;

const server = Server({
  games: [ChainsTCG],
  origins: [
    Origins.LOCALHOST_IN_DEVELOPMENT,
    Origins.LOCALHOST,
    // Allow same-origin (when client served from this server). Use ALLOW_ORIGIN env to add prod domain.
    ...(process.env.ALLOW_ORIGIN ? [process.env.ALLOW_ORIGIN] : []),
  ],
});

// ── Custom REST API (mounted on the same Koa app) ───────────────────────────
const app = server.app;

async function readJson(ctx: any): Promise<any> {
  return await new Promise((resolve, reject) => {
    let raw = '';
    ctx.req.on('data', (chunk: Buffer) => { raw += chunk; });
    ctx.req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    ctx.req.on('error', reject);
  });
}

// ── Memetic Masters library (Helius DAS API) ────────────────────────────────
type LibraryCard = {
  id: string;        // NFT mint
  name: string;
  image: string;
  collection?: string;
};

const HELIUS_API_KEY = process.env.HELIUS_API_KEY ?? '';
const MEMETIC_MASTERS_COLLECTION = process.env.MEMETIC_MASTERS_COLLECTION ?? '';
const NAME_MATCH = (process.env.MEMETIC_MASTERS_NAME_MATCH ?? 'memetic master').toLowerCase();

async function fetchMemeticMastersLibrary(walletAddress: string): Promise<LibraryCard[]> {
  if (!walletAddress) return [];
  // Heuristic: Solana base58 addresses are 32-44 chars and don't start with 0x.
  if (walletAddress.startsWith('0x')) return [];
  if (!HELIUS_API_KEY) {
    console.warn('[library] HELIUS_API_KEY not set; returning empty library');
    return [];
  }
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'memetic-masters',
        method: 'getAssetsByOwner',
        params: { ownerAddress: walletAddress, page: 1, limit: 1000 },
      }),
    });
    if (!r.ok) {
      console.warn('[library] helius http', r.status);
      return [];
    }
    const j: any = await r.json();
    const items: any[] = j?.result?.items ?? [];
    const filtered = items.filter(it => {
      const grouping: Array<{ group_key: string; group_value: string }> = it?.grouping ?? [];
      if (MEMETIC_MASTERS_COLLECTION) {
        return grouping.some(g => g.group_key === 'collection' && g.group_value === MEMETIC_MASTERS_COLLECTION);
      }
      const name: string = (it?.content?.metadata?.name ?? '').toLowerCase();
      const collName: string = (it?.content?.metadata?.collection?.name ?? '').toLowerCase();
      return name.includes(NAME_MATCH) || collName.includes(NAME_MATCH);
    });
    return filtered.map((it: any): LibraryCard => {
      const links = it?.content?.links ?? {};
      const files: Array<{ uri?: string }> = it?.content?.files ?? [];
      return {
        id: String(it?.id ?? ''),
        name: String(it?.content?.metadata?.name ?? 'Untitled'),
        image: String(links.image ?? files[0]?.uri ?? ''),
        collection: it?.content?.metadata?.collection?.name,
      };
    }).filter(c => c.id);
  } catch (e) {
    console.warn('[library] helius error', e);
    return [];
  }
}

app.use(async (ctx, next) => {
  const url = ctx.request.url || '';
  const method = ctx.request.method;

  // CORS for /api/*
  if (url.startsWith('/api/')) {
    ctx.set('Access-Control-Allow-Origin', '*');
    ctx.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    ctx.set('Access-Control-Allow-Headers', 'Content-Type');
    if (method === 'OPTIONS') { ctx.status = 204; return; }
  }

  try {
    if (method === 'GET' && url === '/api/health') {
      ctx.body = { ok: true, ts: Date.now() };
      return;
    }
    if (method === 'GET' && url === '/api/leaderboard') {
      ctx.body = { profiles: await listProfiles() };
      return;
    }
    if (method === 'GET' && url.startsWith('/api/profile/')) {
      const name = decodeURIComponent(url.slice('/api/profile/'.length));
      ctx.body = { profile: await getProfile(name) };
      return;
    }
    if (method === 'POST' && url === '/api/profile') {
      const body = await readJson(ctx);
      if (!body?.name) { ctx.status = 400; ctx.body = { error: 'name required' }; return; }
      ctx.body = { profile: await upsertProfile(String(body.name)) };
      return;
    }
    if (method === 'GET' && url.startsWith('/api/profile-by-wallet/')) {
      const addr = decodeURIComponent(url.slice('/api/profile-by-wallet/'.length));
      ctx.body = { profile: await getProfileByWallet(addr) };
      return;
    }
    if (method === 'POST' && url === '/api/profile/update') {
      const body = await readJson(ctx);
      if (!body?.name) { ctx.status = 400; ctx.body = { error: 'name required' }; return; }
      const patch: { avatarUrl?: string | null; bio?: string | null; walletAddress?: string | null; walletChain?: string | null } = {};
      if ('avatarUrl' in body)     patch.avatarUrl     = body.avatarUrl     == null ? null : String(body.avatarUrl);
      if ('bio'       in body)     patch.bio           = body.bio           == null ? null : String(body.bio).slice(0, 500);
      if ('walletAddress' in body) patch.walletAddress = body.walletAddress == null ? null : String(body.walletAddress).slice(0, 128);
      if ('walletChain'   in body) patch.walletChain   = body.walletChain   == null ? null : String(body.walletChain).slice(0, 32);
      ctx.body = { profile: await updateProfile(String(body.name), patch) };
      return;
    }
    if (method === 'GET' && url.startsWith('/api/deck/')) {
      const name = decodeURIComponent(url.slice('/api/deck/'.length));
      ctx.body = { cards: (await getDeck(name)) ?? [] };
      return;
    }
    if (method === 'POST' && url === '/api/deck') {
      const body = await readJson(ctx);
      if (!body?.name) { ctx.status = 400; ctx.body = { error: 'name required' }; return; }
      if (!Array.isArray(body?.cards)) { ctx.status = 400; ctx.body = { error: 'cards[] required' }; return; }
      const cards = body.cards.map(String);
      const v = validateDeck(cards);
      if (!v.ok) { ctx.status = 400; ctx.body = { error: 'invalid deck', issues: v.issues }; return; }
      await saveDeck(String(body.name), cards);
      ctx.body = { ok: true };
      return;
    }
    if (method === 'GET' && url.startsWith('/api/library/')) {
      const addr = decodeURIComponent(url.slice('/api/library/'.length));
      ctx.body = { cards: await fetchMemeticMastersLibrary(addr) };
      return;
    }
    if (method === 'POST' && url === '/api/result') {
      const body = await readJson(ctx);
      const { matchID, winner, loser, draw } = body ?? {};
      if (!matchID) { ctx.status = 400; ctx.body = { error: 'matchID required' }; return; }
      const status = await recordMatch(String(matchID), winner ?? null, loser ?? null, !!draw);
      ctx.body = { status };
      return;
    }
  } catch (e: any) {
    ctx.status = 500;
    ctx.body = { error: String(e?.message ?? e) };
    return;
  }

  await next();
});

// ── Serve built React app from /dist (if present) ───────────────────────────
if (fs.existsSync(distDir)) {
  app.use(serveStatic(distDir, { index: 'index.html' }));
  // SPA fallback for non-API, non-lobby routes
  app.use(async (ctx, next) => {
    const url = ctx.request.url || '';
    if (
      ctx.request.method === 'GET' &&
      !url.startsWith('/api/') &&
      !url.startsWith('/games/') &&
      !url.startsWith('/socket.io/') &&
      !path.extname(url)
    ) {
      const indexPath = path.join(distDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        ctx.type = 'html';
        ctx.body = fs.createReadStream(indexPath);
        return;
      }
    }
    await next();
  });
  console.log(`[server] serving static client from ${distDir}`);
} else {
  console.log(`[server] no dist/ folder — run 'npm run build' to enable static serving`);
}

// ── Boot ────────────────────────────────────────────────────────────────────
(async () => {
  await initDb();
  server.run(PORT, () => {
    console.log(`[server] Chains TCG listening on :${PORT}`);
  });
})().catch(e => { console.error(e); process.exit(1); });


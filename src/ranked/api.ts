// src/ranked/api.ts
// Koa middleware mounting all /api/ranked/* endpoints. Designed to plug into
// the existing server.ts middleware chain — call routeRanked(ctx) early in
// the handler and return its truthy result to short-circuit.
import * as RDB from './db';
import * as RatingSvc from './rating-service';
import * as QueueSvc from './queue-service';
import * as Leaderboard from './leaderboard-service';
import * as Season from './season-service';
import * as ReplaySvc from './replay-service';
import { takePendingMatchFor, reapStalePending } from './matchmaker';

async function readJson(ctx: any): Promise<any> {
  return await new Promise((resolve, reject) => {
    let raw = '';
    ctx.req.on('data', (c: Buffer) => { raw += c; });
    ctx.req.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    ctx.req.on('error', reject);
  });
}

/** Returns true if the request was handled (so caller should `return`). */
export async function routeRanked(ctx: any): Promise<boolean> {
  const url: string = ctx.request.url || '';
  const method: string = ctx.request.method;
  if (!url.startsWith('/api/ranked/')) return false;

  // GET /api/ranked/profile/:name
  if (method === 'GET' && url.startsWith('/api/ranked/profile/')) {
    const name = decodeURIComponent(url.slice('/api/ranked/profile/'.length));
    const p = await RatingSvc.getOrCreateProfile(name);
    // Strip hidden fields per spec — the client must NEVER see MMR/RD/volatility.
    const { hiddenMmr, ratingDeviation, volatility, mmrMultiplier, smurfFlagged, ...safe } = p;
    void hiddenMmr; void ratingDeviation; void volatility; void mmrMultiplier; void smurfFlagged;
    ctx.body = { profile: safe };
    return true;
  }

  // GET /api/ranked/leaderboard?scope=global|season&limit=
  if (method === 'GET' && url.startsWith('/api/ranked/leaderboard')) {
    const u = new URL(url, 'http://x');
    const scope = (u.searchParams.get('scope') === 'global' ? 'global' : 'season') as 'global'|'season';
    const limit = Math.min(500, Math.max(1, Number(u.searchParams.get('limit') ?? 100)));
    const entries = await Leaderboard.getLeaderboard(scope, limit);
    // Strip hiddenMmr from public payload.
    ctx.body = { entries: entries.map(({ hiddenMmr, ...e }) => { void hiddenMmr; return e; }) };
    return true;
  }

  // POST /api/ranked/queue/join { name, region, deckId? }
  if (method === 'POST' && url === '/api/ranked/queue/join') {
    const body = await readJson(ctx);
    const name = String(body?.name ?? '').trim();
    const region = String(body?.region ?? 'global');
    const deckId = body?.deckId ? String(body.deckId) : undefined;
    if (!name) { ctx.status = 400; ctx.body = { error: 'name required' }; return true; }
    const r = await QueueSvc.joinQueue(name, region, deckId);
    if (!r.ok) { ctx.status = 400; ctx.body = r as any; return true; }
    ctx.body = r;
    return true;
  }

  // POST /api/ranked/queue/leave { name }
  if (method === 'POST' && url === '/api/ranked/queue/leave') {
    const body = await readJson(ctx);
    const name = String(body?.name ?? '').trim();
    if (!name) { ctx.status = 400; ctx.body = { error: 'name required' }; return true; }
    await QueueSvc.leaveQueue(name);
    ctx.body = { ok: true };
    return true;
  }

  // GET /api/ranked/queue/status?name=
  if (method === 'GET' && url.startsWith('/api/ranked/queue/status')) {
    const u = new URL(url, 'http://x');
    const name = u.searchParams.get('name') ?? '';
    if (!name) { ctx.status = 400; ctx.body = { error: 'name required' }; return true; }
    const status = await QueueSvc.queueStatus(name);
    // Match notification: clients poll this endpoint.
    reapStalePending();
    const pending = takePendingMatchFor(name);
    ctx.body = {
      queued: !!status,
      queuedAt: status?.queuedAt ?? null,
      match: pending ? {
        matchId: pending.matchId,
        opponent: pending.player0 === name ? pending.player1 : pending.player0,
        seat: pending.player0 === name ? '0' : '1',
      } : null,
    };
    return true;
  }

  // GET /api/ranked/season
  if (method === 'GET' && url === '/api/ranked/season') {
    ctx.body = { season: await Season.ensureActiveSeason() };
    return true;
  }

  // GET /api/ranked/rewards
  if (method === 'GET' && url === '/api/ranked/rewards') {
    const s = await Season.ensureActiveSeason();
    ctx.body = { rewards: s.rewardDefinitions ?? null };
    return true;
  }

  // GET /api/ranked/replay/:matchId
  if (method === 'GET' && url.startsWith('/api/ranked/replay/')) {
    const id = decodeURIComponent(url.slice('/api/ranked/replay/'.length));
    if (!id) { ctx.status = 400; ctx.body = { error: 'matchId required' }; return true; }
    const events = await ReplaySvc.getReplay(id);
    ctx.body = { matchId: id, events };
    return true;
  }

  // POST /api/ranked/match/result { matchId, seasonId, player0, player1, winner, draw, replaySeed, disconnectedPlayer? }
  // Server-internal. Caller is responsible for ensuring the match was a
  // ranked match and that this is the authoritative result.
  if (method === 'POST' && url === '/api/ranked/match/result') {
    const body = await readJson(ctx);
    const required = ['matchId','seasonId','player0','player1','replaySeed'];
    for (const k of required) if (!body?.[k]) { ctx.status = 400; ctx.body = { error: `${k} required` }; return true; }
    const status = await RatingSvc.ingestMatchResult({
      matchId: String(body.matchId),
      seasonId: String(body.seasonId),
      player0: String(body.player0),
      player1: String(body.player1),
      winner: body.winner ? String(body.winner) : null,
      draw: !!body.draw,
      startedAt: Number(body.startedAt ?? Date.now()),
      endedAt: Number(body.endedAt ?? Date.now()),
      replaySeed: String(body.replaySeed),
      disconnectedPlayer: body.disconnectedPlayer ? String(body.disconnectedPlayer) : null,
    });
    ctx.body = { status };
    return true;
  }

  return false;
}

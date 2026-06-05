// src/SoloClient.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Single-player client: player vs MMTCGBot, running entirely in-browser via
// boardgame.io's Local() transport. No socket.io, no /api hits, no wager UI.
//
// Props:
//   - playerName: shown as the human player
//   - difficulty: 'easy' | 'normal' | 'hard'
//   - mode: 'casual' (random seed) or 'daily' (deterministic seed for everyone)
//   - playerDeckColor: chosen starter deck color (or null → pick phase)
//   - onExit: navigate back to landing
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useEffect, useRef } from 'react';
import { Client } from 'boardgame.io/react';
import { Local } from 'boardgame.io/multiplayer';
import { ChainsTCG } from './Game';
import { ChainsBoard } from './Board';
import { MMTCGBot, enumerateMoves, type Difficulty } from './bot';
import { dailySeed, dailyBotColor, todayKey, saveDailyResult } from './dailyChallenge';
import { COLORS, STARTER_DECKS, type Color } from './cards';

export type SoloMode = 'casual' | 'daily';

export function SoloClient({
  playerName,
  difficulty,
  mode,
  playerDeckColor,
  customDeck,
  onExit,
}: {
  playerName: string;
  difficulty: Difficulty;
  mode: SoloMode;
  playerDeckColor: Color;
  /** If provided (and length > 0), used instead of STARTER_DECKS[playerDeckColor]. */
  customDeck?: string[] | null;
  onExit: () => void;
}) {
  // Build a per-mount Client. Includes the seed when mode='daily' so today's
  // shuffles are identical for everyone.
  const ClientCtor = useMemo(() => {
    const dateKey = todayKey();
    const isDaily = mode === 'daily';
    const seed = isDaily ? dailySeed(dateKey) : undefined;

    // Daily mode picks the bot's deck deterministically. Casual mode picks
    // a random one of the 5 starters per match.
    const botColor: Color = isDaily
      ? dailyBotColor(dateKey)
      : COLORS[Math.floor(Math.random() * COLORS.length)];

    // Bake setupData into the wrapped setup() because the React Client doesn't
    // accept a setupData prop (Local mode has no lobby to forward it from).
    const useCustom = !!(customDeck && customDeck.length > 0);
    const bakedSetupData = {
      // When using a custom deck, leave the player color as null so Game.setup
      // derives the theme color from the deck contents.
      colors: [useCustom ? null : playerDeckColor, botColor] as Array<Color | null>,
      names: [playerName, `Bot (${difficulty})`],
      decks: [useCustom ? customDeck! : STARTER_DECKS[playerDeckColor], STARTER_DECKS[botColor]],
    };
    const originalSetup = ChainsTCG.setup as any;
    const wrappedGame: any = {
      ...ChainsTCG,
      setup: (ctxLike: any /*, _ignored */) =>
        originalSetup(ctxLike, bakedSetupData),
      // boardgame.io's LocalMaster only spins up bots when game.ai is defined,
      // so even though our heuristic bot doesn't call enumerate(), the field
      // must exist for `bots` to be initialized at all. See
      // node_modules/boardgame.io/dist/esm/socketio-…js line 188.
      ai: { enumerate: enumerateMoves },
      ...(seed ? { seed } : {}),
    };

    // Bind the difficulty into the bot constructor via a thin subclass — the
    // Local transport accepts the class (it `new`s it with {enumerate, seed}).
    class BoundBot extends MMTCGBot {
      constructor(args: { enumerate?: any; seed?: string | number }) {
        super({ ...args, difficulty });
      }
    }

    return Client({
      game: wrappedGame,
      board: ChainsBoard as any,
      numPlayers: 2,
      multiplayer: Local({ bots: { '1': BoundBot as any } }),
      debug: false,
    });
  }, [difficulty, mode, playerDeckColor, playerName, customDeck]);

  // Track match start time for daily-best recording.
  const startedAt = useRef<number>(Date.now());
  void startedAt; void saveDailyResult;

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a0a1e', zIndex: 100, overflow: 'auto' }}>
      <button
        onClick={onExit}
        style={{
          position: 'fixed', top: 12, right: 12, zIndex: 200,
          background: '#1b1230', color: '#fff', border: '1px solid #6c4bd8',
          borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontWeight: 700,
        }}
      >Exit Solo</button>
      <ClientCtor
        playerID="0"
        matchID={`solo-${mode}-${todayKey()}-${difficulty}`}
        credentials=""
      />
    </div>
  );
}

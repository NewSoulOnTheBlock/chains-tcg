// @chains/game-core — shared game logic for the Chains TCG.
// Consumed as raw TypeScript: the Next.js frontend transpiles it via
// `transpilePackages`, the backend runs it through tsx.

export * from './cards';
export * from './Game';
export * from './bot';

// Explicit type-only re-exports (isolatedModules-safe).
export type {
  Color,
  CardType,
  GasCost,
  EffectId,
  CardDef,
  DeckIssue,
  DeckValidation,
} from './cards';
export type {
  Instance,
  Zone,
  PlayerState,
  SecretState,
  Combat,
  GState,
} from './Game';
export type { Difficulty } from './bot';

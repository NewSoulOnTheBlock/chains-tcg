/**
 * Server-decided amount policy.
 *
 * The legacy `/api/wager/intent` took `amount` from the request body and only
 * range-checked it, so a client could open a wager for any number it liked (and
 * the escrow row was created from that number). Here the client names a TIER
 * INDEX and the server looks the base-unit amount up in an env-provided
 * allowlist. There is no request shape that carries an amount.
 */
export class StakePolicy {
  private readonly tiers: readonly bigint[];

  constructor(tiersBase: readonly bigint[]) {
    if (tiersBase.length === 0) throw new Error('at least one stake tier is required');
    this.tiers = [...tiersBase];
  }

  /** Tier list for the client UI: index + base-unit amount as a string. */
  list(): Array<{ tier: number; amountBase: string }> {
    return this.tiers.map((amountBase, tier) => ({ tier, amountBase: amountBase.toString() }));
  }

  /** Returns null when the tier index is not in the allowlist. */
  amountForTier(tier: number): bigint | null {
    if (!Number.isInteger(tier) || tier < 0 || tier >= this.tiers.length) return null;
    return this.tiers[tier] ?? null;
  }

  /** Used when re-validating a stored escrow amount against current policy. */
  isAllowedAmount(amountBase: bigint): boolean {
    return this.tiers.some((t) => t === amountBase);
  }
}

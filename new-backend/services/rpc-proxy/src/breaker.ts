/**
 * Circuit breaker for the upstream RPC.
 *
 * Without one, an upstream that is timing out turns every inbound request into
 * a held connection and a full timeout of latency — the proxy becomes the
 * outage. With one, we fail fast and recover on a probe.
 *
 *   closed    → normal. Consecutive failures are counted.
 *   open      → every call is refused immediately until `cooldownMs` elapses.
 *   half-open → exactly one probe is allowed through; success closes the
 *               breaker, failure re-opens it.
 */
export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  private readonly now: () => number;

  constructor(private readonly options: BreakerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  get state(): BreakerState {
    if (this.failures < this.options.failureThreshold) return 'closed';
    if (this.now() - this.openedAt >= this.options.cooldownMs) return 'half-open';
    return 'open';
  }

  /** False when the call must be refused without touching the network. */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open') return false;
    // half-open: let exactly one probe through.
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.probing = false;
  }

  recordFailure(): void {
    this.failures += 1;
    this.probing = false;
    if (this.failures >= this.options.failureThreshold) {
      // Restart the cooldown on every failure at or past the threshold, so a
      // flapping upstream does not get probed continuously.
      this.openedAt = this.now();
    }
  }

  snapshot(): { state: BreakerState; failures: number } {
    return { state: this.state, failures: this.failures };
  }
}

/**
 * Token bucket shared by every consumer of the (single) API key.
 * Steam's ToS budget is 100k calls/day ≈ 1.15/s sustained; default a bit under.
 */
export class TokenBucket {
  #capacity: number;
  #tokens: number;
  #refillPerMs: number;
  #lastRefill: number;

  constructor(opts: { ratePerSecond: number; burst?: number }) {
    this.#capacity = opts.burst ?? Math.ceil(opts.ratePerSecond * 5);
    this.#tokens = this.#capacity;
    this.#refillPerMs = opts.ratePerSecond / 1000;
    this.#lastRefill = Date.now();
  }

  #refill(): void {
    const now = Date.now();
    this.#tokens = Math.min(
      this.#capacity,
      this.#tokens + (now - this.#lastRefill) * this.#refillPerMs,
    );
    this.#lastRefill = now;
  }

  async take(): Promise<void> {
    for (;;) {
      this.#refill();
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - this.#tokens) / this.#refillPerMs);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
